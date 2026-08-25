/**
 * Crafting and crafting stations.
 *
 * `crafting.ts` owns the recipe rules and the per-tick job advance; `stations.ts` owns
 * the machine underneath - reach, fuel, and fire. Both are exported so the client's
 * crafting UI can ask the same questions the server answers.
 */
export * from './crafting';
export * from './stations';
