/**
 * Farming: tilling, planting, watering, growth, blight and harvest.
 *
 * `./crops` holds the pure agronomy model (shared with the client and the tests);
 * `./farming` holds the system that drives it and the six `farm` command actions.
 */
export * from './crops';
export * from './farming';
