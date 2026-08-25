/**
 * Survival: needs, injury, medicine, sleep and death.
 *
 * The layering, innermost first:
 *
 * - `./tuning` - every number, in one place, expressed per *second* of simulated time
 *   and derived from design intent ("2.5 days to starve") rather than typed in as
 *   per-tick decimals.
 * - `./environment` - read-only queries over the world the other files need but do not
 *   own: activity, clothing, fires, rain, shelter.
 * - `./attrition` - the one way survival hurts you, and the one way it tells you.
 * - `./tick` - the per-tick derived facts about a player, computed once and threaded
 *   through every step so four steps cannot disagree about whether someone is asleep.
 * - `./needs`, `./injury`, `./conditions` - the steps themselves.
 * - `./consumption`, `./sleep`, `./respawn` - the command surface.
 * - `./survivalSystem` - the factory that orders all of it.
 *
 * `consumeItem` and `treatBodyPart` are exported for the inventory system's `useItem`
 * routing, which owns the slot an item came out of. Everything else is exported because
 * the client's HUD asks the same questions the server answers, and because a rule with
 * no test is a rule nobody has checked.
 */
export * from './attrition';
export * from './conditions';
export * from './consumption';
export * from './environment';
export * from './injury';
export * from './needs';
export * from './respawn';
export * from './sleep';
export * from './survivalSystem';
export * from './tick';
export * from './tuning';
