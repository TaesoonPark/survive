import type { ProjectileDef } from '../types';

/**
 * The projectile table.
 *
 * Speeds are px/second. For scale: one tile is 32 px and the simulation runs at 20 Hz,
 * so a 9 mm round at 4 200 px/s crosses six tiles in a single tick and is effectively
 * hitscan, while an arrow at 900 px/s visibly travels and can be led or dodged. That
 * gap is deliberate - it is what makes a bow a skill weapon and a rifle a resource
 * decision.
 *
 * `recoverDefId` / `recoverChance` are what keep archery sustainable: roughly half of
 * wooden arrows and two thirds of bolts come back, so the loop is "craft a batch, walk
 * the field, craft a smaller batch". Bullets recover nothing, ever.
 *
 * `spitter_bile` has no weapon item behind it. `ZombieDef` carries no projectile field,
 * so the AI resolves a ranged zombie's projectile by this id; keep the id stable.
 */
export const PROJECTILE_DEFS: readonly ProjectileDef[] = [
  {
    id: 'arrow_wooden',
    speed: 900,
    maxRange: 640,
    radius: 5,
    pierce: 0,
    damageFalloff: 0.8,
    recoverDefId: 'arrow_wooden',
    recoverChance: 0.5,
    sprite: 'projectile_arrow_wooden',
    trail: false,
  },
  {
    id: 'arrow_iron',
    speed: 960,
    maxRange: 680,
    radius: 5,
    pierce: 1,
    damageFalloff: 0.85,
    recoverDefId: 'arrow_iron',
    recoverChance: 0.6,
    sprite: 'projectile_arrow_iron',
    trail: false,
  },
  {
    id: 'bolt',
    speed: 1150,
    maxRange: 760,
    radius: 5,
    pierce: 1,
    damageFalloff: 0.9,
    recoverDefId: 'bolt',
    recoverChance: 0.65,
    sprite: 'projectile_bolt',
    trail: false,
  },
  {
    id: 'bullet_9mm',
    speed: 4200,
    maxRange: 900,
    radius: 3,
    pierce: 0,
    damageFalloff: 0.75,
    sprite: 'projectile_bullet',
    trail: true,
  },
  {
    id: 'bullet_308',
    speed: 6800,
    maxRange: 1600,
    radius: 3,
    // Rifle rounds go through the first two things they meet, which is the only
    // reason a queue of walkers in a corridor is ever a good thing.
    pierce: 2,
    damageFalloff: 0.92,
    sprite: 'projectile_bullet_heavy',
    trail: true,
  },
  {
    id: 'pellet',
    speed: 3400,
    maxRange: 420,
    radius: 3,
    pierce: 0,
    // Buckshot loses most of its bite past a couple of tiles.
    damageFalloff: 0.3,
    sprite: 'projectile_pellet',
    trail: false,
  },
  {
    id: 'thrown_rock',
    speed: 520,
    maxRange: 300,
    radius: 7,
    pierce: 0,
    damageFalloff: 0.6,
    recoverDefId: 'throwing_rock',
    recoverChance: 0.7,
    sprite: 'projectile_rock',
    trail: false,
  },
  {
    id: 'molotov_flask',
    speed: 420,
    maxRange: 420,
    radius: 14,
    pierce: 0,
    damageFalloff: 1,
    sprite: 'projectile_molotov',
    trail: true,
  },
  {
    id: 'spitter_bile',
    speed: 480,
    maxRange: 340,
    radius: 9,
    pierce: 0,
    damageFalloff: 0.8,
    sprite: 'projectile_bile',
    trail: true,
  },
];
