/**
 * `@survive/simulation` - the authoritative game rules.
 *
 * Fixed-tick, deterministic and headless. Nothing here imports Phaser, Colyseus, or
 * anything that touches the filesystem or the network: the server drives it, and tests
 * drive it exactly the same way (spec sections 5, 6 and 34).
 */
export * from './core';
export * from './simulation';
export * from './systems';
