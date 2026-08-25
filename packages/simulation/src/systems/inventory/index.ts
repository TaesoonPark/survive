/**
 * Items: inventories, equipment, containers and the ground.
 *
 * `containers.ts` turns a client's {@link ContainerRef} into a validated window of
 * slots and is the reason the move rules are not a matrix of container kinds;
 * `inventorySystem.ts` owns every item command; `itemEntitySystem.ts` owns the ground
 * and the slow business of rot. All three are exported because the client's inventory
 * UI has to be able to ask the same questions the server answers.
 */
export * from './containers';
export * from './inventorySystem';
export * from './itemEntitySystem';
