/**
 * `@survive/protocol` - the contract layer.
 *
 * Everything here is pure, JSON-serializable data plus small pure helpers. It has no
 * dependencies at all: not on Phaser, not on Colyseus, not on Node. Both the
 * authoritative server and the renderer import from here, which is what keeps the
 * game rules independent of the engine (Architecture Guard rules 1, 2 and 6).
 */
export * from './constants';
export * from './chunks';
export * from './clock';
export * from './commands';
export * from './config';
export * from './events';
export * from './math';
export * from './messages';
export * from './rng';
export * from './save';
export * from './snapshot';
export * from './state';
export * from './tiles';
export * from './util';
