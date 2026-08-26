/**
 * `@survive/game-data` - the static content layer.
 *
 * Pure data plus the lookup and validation helpers around it. It depends on
 * `@survive/protocol` for ids, units and the seeded RNG, and on nothing else: no
 * Phaser, no Node APIs, no wall clock, no `Math.random`. Both the authoritative
 * simulation and the client read exactly these tables, which is what lets the client
 * render an item tooltip without asking the server what an item is.
 *
 * Start at {@link createGameData}.
 */
export * from './types';
export * from './registry';
export * from './gameData';
export {
  DEFAULT_LOCALE,
  localize,
  localizeDescribed,
  stringTable,
  type DisplayText,
  type Locale,
  type StringTable,
  type TextKind,
} from './strings';

export { ITEM_DEFS } from './defs/items';
export { RECIPE_DEFS } from './defs/recipes';
export { STRUCTURE_DEFS } from './defs/structures';
export { RESOURCE_NODE_DEFS } from './defs/nodes';
export { CROP_DEFS } from './defs/crops';
export { ZOMBIE_DEFS } from './defs/zombies';
export { ANIMAL_DEFS } from './defs/animals';
export { PROJECTILE_DEFS } from './defs/projectiles';
export { LOOT_TABLE_DEFS } from './defs/loot';
