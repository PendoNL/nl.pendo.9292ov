'use strict';

const https = require('https');

const BASE_URL = 'https://v0.ovapi.nl';
const STOP_AREAS_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const DEPARTURES_CACHE_TTL = 30 * 1000; // 30 seconds

class OVApi {
  constructor(homey) {
    this.homey = homey;
    this.stopAreasCache = null;
    this.stopAreasCacheTime = 0;
    this.departuresCache = new Map();
  }

  /**
   * Make an HTTP GET request to the OV API.
   */
  async _fetch(endpoint, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const url = `${BASE_URL}${endpoint}`;
      const timeoutId = setTimeout(() => {
        reject(new Error('Request timeout'));
      }, timeout);

      https.get(url, { rejectUnauthorized: false }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          clearTimeout(timeoutId);
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('Invalid JSON response'));
          }
        });
      }).on('error', (err) => {
        clearTimeout(timeoutId);
        reject(err);
      });
    });
  }

  /**
   * Get all stop areas from the OV API.
   * Caches results for 24 hours.
   */
  async getAllStopAreas() {
    const now = Date.now();

    // Check in-memory cache first
    if (this.stopAreasCache && (now - this.stopAreasCacheTime) < STOP_AREAS_CACHE_TTL) {
      return this.stopAreasCache;
    }

    // Check persistent cache
    const cached = this.homey.settings.get('stopAreasCache');
    const cachedTime = this.homey.settings.get('stopAreasCacheTime');
    if (cached && cachedTime && (now - cachedTime) < STOP_AREAS_CACHE_TTL) {
      this.stopAreasCache = cached;
      this.stopAreasCacheTime = cachedTime;
      return cached;
    }

    // Fetch fresh data
    try {
      const data = await this._fetch('/stopareacode/', 30000);
      const stopAreas = Object.values(data || {});

      // Store in both caches
      this.stopAreasCache = stopAreas;
      this.stopAreasCacheTime = now;
      this.homey.settings.set('stopAreasCache', stopAreas);
      this.homey.settings.set('stopAreasCacheTime', now);

      return stopAreas;
    } catch (error) {
      this.homey.error('Failed to fetch stop areas:', error.message);
      return this.stopAreasCache || [];
    }
  }

  /**
   * Search for stops by query string.
   * Searches in name, town, and code.
   */
  async searchLocations(query) {
    if (!query || query.length < 2) {
      return [];
    }

    const queryLower = query.toLowerCase();
    const allStops = await this.getAllStopAreas();

    return allStops
      .filter(stop => {
        const name = (stop.TimingPointName || '').toLowerCase();
        const town = (stop.TimingPointTown || '').toLowerCase();
        const code = (stop.StopAreaCode || '').toLowerCase();

        return name.includes(queryLower) ||
               town.includes(queryLower) ||
               code.includes(queryLower);
      })
      .slice(0, 15)
      .map(stop => ({
        id: stop.StopAreaCode || '',
        name: stop.TimingPointName || '',
        description: stop.TimingPointTown || '',
      }));
  }

  /**
   * Get departures for a stop area.
   */
  async getDepartures(stopAreaCode, limit = 10) {
    if (!stopAreaCode) {
      return [];
    }

    const now = Date.now();
    const cacheKey = stopAreaCode;

    // Check cache
    const cached = this.departuresCache.get(cacheKey);
    if (cached && (now - cached.time) < DEPARTURES_CACHE_TTL) {
      return cached.data.slice(0, limit);
    }

    try {
      const data = await this._fetch(`/stopareacode/${stopAreaCode}`);
      const stopData = data[stopAreaCode] || {};

      const departures = [];

      // Iterate through all stops in this area
      for (const stop of Object.values(stopData)) {
        const passes = stop.Passes || {};

        for (const departure of Object.values(passes)) {
          const planned = this._parseDateTime(departure.TargetDepartureTime);
          const expected = this._parseDateTime(departure.ExpectedDepartureTime);

          let delayMinutes = 0;
          if (planned && expected) {
            delayMinutes = Math.round((expected.getTime() - planned.getTime()) / 60000);
          }

          const status = this._mapStatus(departure.TripStopStatus || '');
          const timestamp = expected?.getTime() || planned?.getTime() || 0;

          // Skip passed departures or invalid timestamps
          if (status === 'passed' || timestamp === 0) {
            continue;
          }

          departures.push({
            line: departure.LinePublicNumber || '',
            destination: departure.DestinationName50 || departure.DestinationName || '',
            status,
            planned_time: planned ? this._formatTime(planned) : '',
            expected_time: expected ? this._formatTime(expected) : '',
            delay_minutes: delayMinutes,
            transport_type: this._mapTransportType(departure.TransportType || ''),
            operator: departure.OperatorCode || '',
            timestamp,
            // Unique ID for tracking triggered departures
            uid: `${stopAreaCode}_${departure.LinePublicNumber}_${departure.DestinationName50 || departure.DestinationName}_${planned?.getTime() || 0}`,
          });
        }
      }

      // Sort by timestamp and limit
      departures.sort((a, b) => a.timestamp - b.timestamp);

      // Cache the results
      this.departuresCache.set(cacheKey, {
        time: now,
        data: departures,
      });

      return departures.slice(0, limit);
    } catch (error) {
      this.homey.error(`Failed to fetch departures for ${stopAreaCode}:`, error.message);
      return [];
    }
  }

  /**
   * Get unique destinations for a stop (for autocomplete).
   */
  async getDestinations(stopAreaCode) {
    const departures = await this.getDepartures(stopAreaCode, 50);
    const destinations = new Map();

    for (const dep of departures) {
      if (dep.destination && !destinations.has(dep.destination)) {
        destinations.set(dep.destination, {
          name: dep.destination,
          description: `Line ${dep.line}`,
        });
      }
    }

    return Array.from(destinations.values());
  }

  /**
   * Get minutes until a departure.
   */
  getMinutesUntil(departure) {
    const now = Date.now();
    const departureTime = departure.timestamp;
    return Math.max(0, Math.round((departureTime - now) / 60000));
  }

  /**
   * Parse an ISO datetime string from the OV API.
   * The API returns times in Europe/Amsterdam timezone.
   */
  _parseDateTime(datetime) {
    if (!datetime) return null;
    try {
      // The OV API returns times like "2025-12-14T13:31:00" without timezone
      // These are in Europe/Amsterdam time, so we need to handle that
      const date = new Date(datetime);

      // If the datetime string doesn't have timezone info, it's interpreted as local time
      // But Homey runs in UTC, so we need to check if there's a Z or +/- timezone
      if (!datetime.includes('Z') && !datetime.includes('+') && !/\d{2}:\d{2}:\d{2}-/.test(datetime)) {
        // No timezone specified - assume Europe/Amsterdam
        // Get the offset for Amsterdam (CET = +1, CEST = +2)
        const amsterdamOffset = this._getAmsterdamOffset(date);
        // Adjust the timestamp: subtract the offset to convert to UTC
        return new Date(date.getTime() - amsterdamOffset * 60 * 1000);
      }

      return date;
    } catch {
      return null;
    }
  }

  /**
   * Get the UTC offset for Amsterdam in minutes.
   * CET (winter) = +60 minutes, CEST (summer) = +120 minutes
   */
  _getAmsterdamOffset(date) {
    // Simple DST check for Europe: last Sunday of March to last Sunday of October
    const year = date.getFullYear();
    const month = date.getMonth();
    const day = date.getDate();

    // Find last Sunday of March
    const marchLast = new Date(year, 2, 31);
    const dstStart = 31 - marchLast.getDay();

    // Find last Sunday of October
    const octLast = new Date(year, 9, 31);
    const dstEnd = 31 - octLast.getDay();

    // Check if we're in DST
    const isDST = (month > 2 && month < 9) ||
                  (month === 2 && day >= dstStart) ||
                  (month === 9 && day < dstEnd);

    return isDST ? 120 : 60; // CEST = +2h, CET = +1h
  }

  /**
   * Format a Date object as HH:MM.
   */
  _formatTime(date) {
    return date.toLocaleTimeString('nl-NL', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }

  /**
   * Map OV API status to normalized status.
   */
  _mapStatus(status) {
    switch (status.toUpperCase()) {
      case 'PLANNED':
      case 'DRIVING':
      case 'ARRIVED':
        return 'planned';
      case 'PASSED':
        return 'passed';
      case 'CANCEL':
        return 'cancelled';
      default:
        return 'unknown';
    }
  }

  /**
   * Map transport type to normalized value.
   */
  _mapTransportType(type) {
    switch (type.toLowerCase()) {
      case 'bus':
        return 'bus';
      case 'tram':
        return 'tram';
      case 'metro':
        return 'metro';
      case 'trein':
      case 'train':
        return 'train';
      case 'ferry':
      case 'veer':
        return 'ferry';
      default:
        return 'bus';
    }
  }
}

module.exports = OVApi;
