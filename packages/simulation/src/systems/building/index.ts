/**
 * Construction: placement rules, blueprints, doors, repair, decay and traps.
 *
 * `./placement` is the pure validator - the client's placement ghost calls exactly the
 * same function the server does, so a green preview never turns into a rejection.
 * `./building` is the system that acts on it.
 */
export * from './placement';
export * from './building';
