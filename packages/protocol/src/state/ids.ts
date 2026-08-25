/**
 * Identifier aliases.
 *
 * These stay plain `string`/`number` so that every state object remains directly
 * JSON-serializable (Architecture Guard rule 6). The aliases exist for readability
 * and to make signatures self-documenting.
 */

/** Runtime entity id, unique within a world (e.g. `z:1042`, `p:alice`). */
export type EntityId = string;

/** Player id. Stable across sessions; used as the persistence key. */
export type PlayerId = string;

/** Key into the item definition table, e.g. `wood_log`. */
export type ItemDefId = string;

/** Key into the recipe table, e.g. `craft_plank`. */
export type RecipeDefId = string;

/** Key into the structure (buildable/placeable) definition table. */
export type StructureDefId = string;

/** Key into the resource-node definition table, e.g. `tree_pine`. */
export type ResourceNodeDefId = string;

/** Key into the zombie definition table. */
export type ZombieDefId = string;

/** Key into the animal definition table. */
export type AnimalDefId = string;

/** Key into the crop definition table. */
export type CropDefId = string;

/** Key into the loot table registry. */
export type LootTableId = string;

/** Key into the projectile definition table. */
export type ProjectileDefId = string;

/** `"cx,cy"` chunk key. Use `chunkKey()` from `@survive/protocol` to build one. */
export type ChunkKey = string;

/** Id of a queued crafting job. */
export type CraftJobId = string;
