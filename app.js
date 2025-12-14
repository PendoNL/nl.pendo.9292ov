'use strict';

const Homey = require('homey');
const OVApi = require('./lib/9292Api');

const POLL_INTERVAL = 30 * 1000; // 30 seconds

module.exports = class OVApp extends Homey.App {

  async onInit() {
    this.log('9292 OV app has been initialized');

    // Initialize API client
    this.api = new OVApi(this.homey);

    // Track triggered departures to support "once" mode
    this.triggeredDepartures = {
      soon: new Set(),
      delayed: new Set(),
    };

    // Register flow cards
    await this._registerFlowCards();

    // Start polling for triggers
    this._startPolling();

    // Pre-fetch stop areas in the background
    this.api.getAllStopAreas().catch(err => {
      this.error('Failed to pre-fetch stop areas:', err.message);
    });
  }

  async _registerFlowCards() {
    // ===== TRIGGERS =====

    // Departure soon trigger
    this.departureSoonTrigger = this.homey.flow.getTriggerCard('departure_soon');
    this._registerStationAutocomplete(this.departureSoonTrigger);
    this._registerDestinationAutocomplete(this.departureSoonTrigger);
    this.departureSoonTrigger.registerRunListener(async (args, state) => {
      // Match the trigger state with the configured flow arguments
      if (args.station?.id !== state.stationId) return false;
      if (args.destination?.name && state.destination) {
        if (!state.destination.toLowerCase().includes(args.destination.name.toLowerCase())) {
          return false;
        }
      }
      return true;
    });

    // Departure delayed trigger
    this.departureDelayedTrigger = this.homey.flow.getTriggerCard('departure_delayed');
    this._registerStationAutocomplete(this.departureDelayedTrigger);
    this._registerDestinationAutocomplete(this.departureDelayedTrigger);
    this.departureDelayedTrigger.registerRunListener(async (args, state) => {
      // Match the trigger state with the configured flow arguments
      if (args.station?.id !== state.stationId) return false;
      if (args.destination?.name && state.destination) {
        if (!state.destination.toLowerCase().includes(args.destination.name.toLowerCase())) {
          return false;
        }
      }
      return true;
    });

    // ===== CONDITIONS =====

    // Next departure matches condition
    const nextDepartureIsCondition = this.homey.flow.getConditionCard('next_departure_is');
    this._registerStationAutocomplete(nextDepartureIsCondition);
    nextDepartureIsCondition.registerRunListener(async (args) => {
      const departures = await this.api.getDepartures(args.station.id);
      if (departures.length === 0) return false;

      const next = departures[0];
      const matchValue = (args.match_value || '').toLowerCase();

      if (args.match_type === 'line') {
        return next.line.toLowerCase() === matchValue;
      }
      if (args.match_type === 'destination') {
        return next.destination.toLowerCase().includes(matchValue);
      }
      return false;
    });

    // Departure within minutes condition
    const departureWithinCondition = this.homey.flow.getConditionCard('departure_within_minutes');
    this._registerStationAutocomplete(departureWithinCondition);
    this._registerDestinationAutocomplete(departureWithinCondition);
    departureWithinCondition.registerRunListener(async (args) => {
      const departures = await this.api.getDepartures(args.station.id);
      const destinationLower = (args.destination?.name || '').toLowerCase();

      for (const dep of departures) {
        // Check destination match if specified
        if (destinationLower && !dep.destination.toLowerCase().includes(destinationLower)) {
          continue;
        }

        const minutesUntil = this.api.getMinutesUntil(dep);
        if (minutesUntil <= args.minutes) {
          return true;
        }
      }
      return false;
    });

    // Is delayed condition
    const isDelayedCondition = this.homey.flow.getConditionCard('is_delayed');
    this._registerStationAutocomplete(isDelayedCondition);
    this._registerDestinationAutocomplete(isDelayedCondition);
    isDelayedCondition.registerRunListener(async (args) => {
      const departures = await this.api.getDepartures(args.station.id);
      const destinationLower = (args.destination?.name || '').toLowerCase();

      for (const dep of departures) {
        // Check destination match if specified
        if (destinationLower && !dep.destination.toLowerCase().includes(destinationLower)) {
          continue;
        }

        if (dep.delay_minutes > args.minutes) {
          return true;
        }
      }
      return false;
    });

    // ===== ACTIONS =====

    // Get departure info action
    const getDepartureInfoAction = this.homey.flow.getActionCard('get_departure_info');
    this._registerStationAutocomplete(getDepartureInfoAction);
    this._registerDestinationAutocomplete(getDepartureInfoAction);
    getDepartureInfoAction.registerRunListener(async (args) => {
      const departures = await this.api.getDepartures(args.station.id);
      const destinationLower = (args.destination?.name || '').toLowerCase();

      let departure = departures[0];

      // If destination specified, find matching departure
      if (destinationLower) {
        departure = departures.find(dep =>
          dep.destination.toLowerCase().includes(destinationLower)
        );
      }

      if (!departure) {
        return {
          line: '',
          destination: '',
          minutes_until: 0,
          delay_minutes: 0,
          planned_time: '',
          expected_time: '',
          transport_type: '',
        };
      }

      return {
        line: departure.line,
        destination: departure.destination,
        minutes_until: this.api.getMinutesUntil(departure),
        delay_minutes: departure.delay_minutes,
        planned_time: departure.planned_time,
        expected_time: departure.expected_time,
        transport_type: departure.transport_type,
      };
    });
  }

  _registerStationAutocomplete(flowCard) {
    flowCard.registerArgumentAutocompleteListener('station', async (query) => {
      const results = await this.api.searchLocations(query);
      return results;
    });
  }

  _registerDestinationAutocomplete(flowCard) {
    flowCard.registerArgumentAutocompleteListener('destination', async (query, args) => {
      // If no station selected yet, return empty
      if (!args.station?.id) {
        return [];
      }

      // Get destinations for this station
      const destinations = await this.api.getDestinations(args.station.id);

      // Filter by query if provided
      if (query && query.length > 0) {
        const queryLower = query.toLowerCase();
        return destinations.filter(d =>
          d.name.toLowerCase().includes(queryLower)
        );
      }

      return destinations;
    });
  }

  _startPolling() {
    this.pollInterval = this.homey.setInterval(async () => {
      await this._checkTriggers();
    }, POLL_INTERVAL);
  }

  async _checkTriggers() {
    try {
      // Get all configured trigger instances for departure_soon
      const soonArgs = await this.departureSoonTrigger.getArgumentValues();
      for (const args of soonArgs) {
        await this._checkDepartureSoonTrigger(args);
      }

      // Get all configured trigger instances for departure_delayed
      const delayedArgs = await this.departureDelayedTrigger.getArgumentValues();
      for (const args of delayedArgs) {
        await this._checkDepartureDelayedTrigger(args);
      }

      // Clean up old triggered departures
      this._cleanupTriggeredDepartures();
    } catch (error) {
      this.error('Error checking triggers:', error.message);
    }
  }

  async _checkDepartureSoonTrigger(args) {
    if (!args.station?.id) return;

    const departures = await this.api.getDepartures(args.station.id);
    const destinationLower = (args.destination?.name || '').toLowerCase();
    const threshold = args.minutes || 5;

    for (const dep of departures) {
      // Check destination match if specified
      if (destinationLower && !dep.destination.toLowerCase().includes(destinationLower)) {
        continue;
      }

      const minutesUntil = this.api.getMinutesUntil(dep);

      // Check if within threshold
      if (minutesUntil <= threshold) {
        const triggerKey = `soon_${dep.uid}`;

        // Check if already triggered (for "once" mode)
        if (args.trigger_mode === 'once' && this.triggeredDepartures.soon.has(triggerKey)) {
          continue;
        }

        // Fire the trigger
        const tokens = {
          line: dep.line,
          destination: dep.destination,
          minutes_until: minutesUntil,
          planned_time: dep.planned_time,
          expected_time: dep.expected_time,
        };

        const state = {
          stationId: args.station.id,
          destination: dep.destination,
        };

        await this.departureSoonTrigger.trigger(tokens, state);

        // Mark as triggered
        this.triggeredDepartures.soon.add(triggerKey);

        // Only trigger once per poll for this configuration
        break;
      }
    }
  }

  async _checkDepartureDelayedTrigger(args) {
    if (!args.station?.id) return;

    const departures = await this.api.getDepartures(args.station.id);
    const destinationLower = (args.destination?.name || '').toLowerCase();
    const minDelay = args.min_delay || 5;

    for (const dep of departures) {
      // Check destination match if specified
      if (destinationLower && !dep.destination.toLowerCase().includes(destinationLower)) {
        continue;
      }

      // Check if delayed enough
      if (dep.delay_minutes > minDelay) {
        const triggerKey = `delayed_${dep.uid}`;

        // Check if already triggered (for "once" mode)
        if (args.trigger_mode === 'once' && this.triggeredDepartures.delayed.has(triggerKey)) {
          continue;
        }

        // Fire the trigger
        const tokens = {
          line: dep.line,
          destination: dep.destination,
          delay_minutes: dep.delay_minutes,
          planned_time: dep.planned_time,
          expected_time: dep.expected_time,
        };

        const state = {
          stationId: args.station.id,
          destination: dep.destination,
        };

        await this.departureDelayedTrigger.trigger(tokens, state);

        // Mark as triggered
        this.triggeredDepartures.delayed.add(triggerKey);

        // Only trigger once per poll for this configuration
        break;
      }
    }
  }

  _cleanupTriggeredDepartures() {
    const now = Date.now();
    const oneHourAgo = now - (60 * 60 * 1000);

    // Clean up triggered departures older than 1 hour
    // The UID contains the planned timestamp, so we can check if it's passed
    for (const key of this.triggeredDepartures.soon) {
      const parts = key.split('_');
      const timestamp = parseInt(parts[parts.length - 1], 10);
      if (timestamp && timestamp < oneHourAgo) {
        this.triggeredDepartures.soon.delete(key);
      }
    }

    for (const key of this.triggeredDepartures.delayed) {
      const parts = key.split('_');
      const timestamp = parseInt(parts[parts.length - 1], 10);
      if (timestamp && timestamp < oneHourAgo) {
        this.triggeredDepartures.delayed.delete(key);
      }
    }
  }

  onUninit() {
    if (this.pollInterval) {
      this.homey.clearInterval(this.pollInterval);
    }
  }

};
