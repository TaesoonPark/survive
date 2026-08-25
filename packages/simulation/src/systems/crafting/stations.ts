import {
  TILE_SIZE,
  pixelToTile,
  type EquipSlot,
  type ItemStack,
  type PlayerState,
  type StationSubState,
  type StructureState,
} from '@survive/protocol';
import type { StationKind, StructureDef } from '@survive/game-data';
import type { SimContext } from '../../core/context';
import { findTool, recomputeCarryWeight, spendDurability, takeFromSlot } from '../../core/items';
import { bump, markStructureDirty } from '../../core/queries';
import { tileKey } from '../../core/state';
import { structureCenter } from '../../core/structures';

/**
 * Crafting stations: reach, fuel and fire.
 *
 * A station is a {@link StructureState} carrying a `station` sub-state. Everything in
 * this file is about the station *as a machine* - how close you have to stand, what it
 * burns, whether it is alight - and is deliberately separate from the recipe logic in
 * `crafting.ts`, which consumes it.
 *
 * Fuel is denominated in **ticks of burn time**, the same unit as
 * `FuelProps.burnTicks`, `StationDef.maxFuel` and `RecipeDef.fuelCost`. That shared
 * unit is what makes the content table's arithmetic legible: a log is 2 400, an iron
 * smelt costs 600, so a log pays for four smelts.
 */

/**
 * How far from a station's footprint a player may stand and still use it, in pixels.
 *
 * Two tiles. Most stations block movement, so the player is already standing a body
 * radius off the edge; being stingy here would make a legitimately adjacent player
 * unable to reach their own furnace on a diagonal.
 */
export const STATION_REACH = TILE_SIZE * 2;

/**
 * Ticks a player is busy for after feeding, lighting or dousing a station.
 *
 * Held in the shared `useReadyTick` rather than a crafting-only field, for the same
 * reason farming and gathering share it: shovelling logs into a furnace and eating a
 * tin of beans are the same pair of hands, and a client that could interleave them
 * freely would be doing two things at once. Without this a client can also empty
 * twenty inventory slots into one fire inside a single tick, and pay the
 * {@link adjacentLitFire} search once per `ignite` it feels like sending.
 */
export const STATION_ACTION_TICKS = 8;

/** Fuel a lit station burns per tick just staying alight, with no job running. */
export const AMBIENT_FUEL_BURN = 1;

/**
 * How far, in tiles, the neighbouring-fire search looks either side of a station.
 *
 * {@link STATION_REACH} in tiles, plus one, because a station's centre can sit on a
 * tile boundary rather than in the middle of a tile. Anything whose footprint is
 * within reach of the centre must own a tile inside that box, which is what lets the
 * search read the tile index instead of walking every structure in the world.
 */
const NEIGHBOUR_SEARCH_TILES = Math.ceil(STATION_REACH / TILE_SIZE) + 1;

/** A structure that is a station, resolved together with everything needed to use it. */
export interface StationRef {
  structure: StructureState;
  def: StructureDef;
  station: StationSubState;
  kind: StationKind;
  /** Whether this station has a fire that needs feeding at all. */
  burnsFuel: boolean;
}

/** Where an item lives on a player. Mirrors the shape {@link findTool} returns. */
export type ItemRef =
  | { stack: ItemStack; where: 'equipment'; slot: EquipSlot }
  | { stack: ItemStack; where: 'inventory'; index: number };

/** Emit the standard rejection so the UI can explain why nothing happened. */
export function rejectCommand(
  ctx: SimContext,
  player: PlayerState,
  command: string,
  reason: string,
): void {
  ctx.events.emit({ type: 'commandRejected', playerId: player.id, command, reason });
}

/**
 * Resolve a structure id to a usable station, or null.
 *
 * Returns null for an unknown id, a structure with no `station` sub-state, and a
 * definition the content tables no longer contain - all three are things a lying or
 * stale client will send.
 */
export function resolveStation(ctx: SimContext, structureId: string): StationRef | null {
  const structure = ctx.state.structures[structureId];
  if (!structure?.station) return null;
  const def = ctx.data.structures.get(structure.defId);
  if (!def?.station) return null;
  return {
    structure,
    def,
    station: structure.station,
    kind: def.station.kind,
    burnsFuel: def.station.needsFuel,
  };
}

/**
 * Distance in pixels from a point to the nearest edge of a structure's footprint.
 *
 * Measured against the whole rectangle rather than its centre: a 2x1 workbench should
 * be usable from either end, and a player pressed against a big furnace should not be
 * further away than one standing at the corner of a small one.
 */
export function stationFootprintDistance(
  ctx: SimContext,
  x: number,
  y: number,
  structure: StructureState,
): number {
  const def = ctx.data.structures.get(structure.defId);
  // Odd rotations swap the footprint, exactly as `structureTiles` does.
  const swapped = structure.rotation % 2 === 1;
  const width = (swapped ? def?.height : def?.width) ?? 1;
  const height = (swapped ? def?.width : def?.height) ?? 1;
  const minX = structure.tileX * TILE_SIZE;
  const minY = structure.tileY * TILE_SIZE;
  const maxX = minX + width * TILE_SIZE;
  const maxY = minY + height * TILE_SIZE;
  const dx = x < minX ? minX - x : x > maxX ? x - maxX : 0;
  const dy = y < minY ? minY - y : y > maxY ? y - maxY : 0;
  return Math.hypot(dx, dy);
}

/** True when the player is standing close enough to work at a structure. */
export function withinStationReach(
  ctx: SimContext,
  player: PlayerState,
  structure: StructureState,
  reach = STATION_REACH,
): boolean {
  return stationFootprintDistance(ctx, player.x, player.y, structure) <= reach;
}

/**
 * Whether the player can actually see the machine they are working at.
 *
 * Reach alone is not enough: {@link STATION_REACH} is two tiles, and a base wall is
 * one, so a distance-only check lets somebody outside stand against the wall and
 * smelt at the furnace inside it - or, worse, put that furnace out and cancel the
 * jobs queued on it. The ray is re-tested when it is blocked, and accepted when the
 * thing that stopped it *is* the station, because most stations are themselves solid
 * and you have to be able to use the furnace you are standing against.
 */
export function hasStationLineOfSight(
  ctx: SimContext,
  player: PlayerState,
  ref: StationRef,
): boolean {
  const focus = structureCenter(ref.structure, ref.def);
  if (ctx.world.hasLineOfSight(player.x, player.y, focus.x, focus.y)) return true;
  const hit = ctx.world.raycast(player.x, player.y, focus.x, focus.y);
  if (!hit) return false;
  return ctx.state.structureTiles[tileKey(hit.tileX, hit.tileY)] === ref.structure.id;
}

/**
 * Can this player work at this station at all? Returns the reason they cannot.
 *
 * One gate for every command that touches a station, so `craft`, `cancelCraft`,
 * `refuel`, `ignite` and `extinguish` cannot drift apart over which of them checks
 * the wall in between.
 */
export function stationOutOfReach(
  ctx: SimContext,
  player: PlayerState,
  ref: StationRef,
): string | null {
  if (!withinStationReach(ctx, player, ref.structure)) return 'too far from the station';
  if (!hasStationLineOfSight(ctx, player, ref)) return 'you cannot see the station';
  return null;
}

/** World position to spit output at when nobody is around to receive it. */
export function stationDropPoint(ref: StationRef): { x: number; y: number } {
  return structureCenter(ref.structure, ref.def);
}

/**
 * Ticks until the player may act on a station again, or 0 when they are free.
 *
 * Shares `useReadyTick` with every other hand action; see {@link STATION_ACTION_TICKS}.
 */
export function stationActionCooldown(ctx: SimContext, player: PlayerState): number {
  return Math.max(0, player.useReadyTick - ctx.state.tick);
}

/** Start the shared hand-action cooldown after a station was worked on. */
function beginStationAction(ctx: SimContext, player: PlayerState): void {
  player.useReadyTick = ctx.state.tick + STATION_ACTION_TICKS;
  bump(player);
}

// ---------------------------------------------------------------------------
// Tool wear shared with crafting
// ---------------------------------------------------------------------------

/**
 * Spend one use of a tool-like item, discarding it when it is used up.
 *
 * Items with durability lose points; items without (matches, tinder) lose exactly one
 * unit from the stack whatever `amount` says, because a stack of matches has no
 * points to spend and "one action, one match" is the only reading that makes sense.
 * Recipes are held to the same rule from the other side: a `consumeDurability` input
 * has to name an item that actually wears out. Either way the item disappears from
 * wherever it was held once it is spent, which is why this needs the {@link ItemRef}
 * rather than just the stack.
 *
 * The "it broke" event is `weaponBroke` because that is the only item-destroyed event
 * the protocol defines. It is the right notification for the client to show - an item
 * the player was using is gone - and inventing a second event for tools would mean the
 * UI had to listen for two things that mean the same thing.
 */
export function spendToolUse(ctx: SimContext, player: PlayerState, ref: ItemRef, amount = 1): void {
  if (amount <= 0) return;
  const defId = ref.stack.defId;
  let used = false;
  if (ref.stack.durability !== undefined) {
    used = spendDurability(ref.stack, amount);
  } else {
    ref.stack.count -= 1;
    used = ref.stack.count <= 0;
  }
  if (used) {
    if (ref.where === 'equipment') player.equipment[ref.slot] = null;
    else player.inventory.slots[ref.index] = null;
    ctx.events.emit({ type: 'weaponBroke', ownerId: player.id, defId });
  }
  recomputeCarryWeight(player, ctx.data);
  bump(player);
}

/**
 * Find something to light a fire with.
 *
 * A `lighter`-kind tool first (the lighter itself is one), then anything tagged
 * `ignition` so that adding matches to the item table needs no code change here.
 */
export function findIgnitionSource(ctx: SimContext, player: PlayerState): ItemRef | null {
  const tool = findTool(player, 'lighter', ctx.data);
  if (tool) return tool;
  for (const slot of ['mainHand', 'offHand'] as const) {
    const stack = player.equipment[slot];
    if (!stack) continue;
    if (ctx.data.items.get(stack.defId)?.tags.includes('ignition')) {
      return { stack, where: 'equipment', slot };
    }
  }
  for (let index = 0; index < player.inventory.slots.length; index++) {
    const stack = player.inventory.slots[index];
    if (!stack) continue;
    if (ctx.data.items.get(stack.defId)?.tags.includes('ignition')) {
      return { stack, where: 'inventory', index };
    }
  }
  return null;
}

/**
 * Is there a lit fire close enough to the target to borrow a flame from?
 *
 * This is what lets a camp keep going once the lighter runs dry: light one fire, and
 * every fire you build next to it lights for free.
 *
 * Reads the `structureTiles` index over a small box rather than walking every
 * structure in the world, because this runs on a player command and a late-game base
 * holds thousands of structures. Every candidate still gets the same exact distance
 * test, and the ids are sorted, so which fire the flame is borrowed from can depend on
 * neither insertion order nor how big the base has grown.
 */
export function adjacentLitFire(ctx: SimContext, target: StationRef): StructureState | null {
  const centre = structureCenter(target.structure, target.def);
  const originX = pixelToTile(centre.x);
  const originY = pixelToTile(centre.y);

  const candidates: string[] = [];
  const seen = new Set<string>();
  for (let dy = -NEIGHBOUR_SEARCH_TILES; dy <= NEIGHBOUR_SEARCH_TILES; dy++) {
    for (let dx = -NEIGHBOUR_SEARCH_TILES; dx <= NEIGHBOUR_SEARCH_TILES; dx++) {
      const id = ctx.state.structureTiles[tileKey(originX + dx, originY + dy)];
      if (id === undefined || id === target.structure.id || seen.has(id)) continue;
      seen.add(id);
      candidates.push(id);
    }
  }
  candidates.sort();

  for (const id of candidates) {
    const ref = resolveStation(ctx, id);
    if (!ref?.burnsFuel || !ref.station.lit) continue;
    if (stationFootprintDistance(ctx, centre.x, centre.y, ref.structure) <= STATION_REACH) {
      return ref.structure;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fire
// ---------------------------------------------------------------------------

/** Light a station's fire. Assumes every precondition has already been checked. */
export function lightStation(ctx: SimContext, ref: StationRef): void {
  ref.station.lit = true;
  ref.station.heat = ref.def.station?.heat ?? 0;
  // A campfire is also a lamp. Keeping the light in step here means a lit fire is
  // never a dark one, whatever else happens to the structure later.
  if (ref.structure.light) ref.structure.light.on = true;
  bump(ref.structure);
  markStructureDirty(ctx.state, ref.structure);
  ctx.events.emit({ type: 'stationLit', structureId: ref.structure.id, lit: true });
}

/** Put a station's fire out, dropping its heat. */
export function douseStation(ctx: SimContext, ref: StationRef): void {
  if (!ref.station.lit) return;
  ref.station.lit = false;
  ref.station.heat = 0;
  if (ref.structure.light) ref.structure.light.on = false;
  bump(ref.structure);
  markStructureDirty(ctx.state, ref.structure);
  ctx.events.emit({ type: 'stationLit', structureId: ref.structure.id, lit: false });
}

/**
 * Burn one tick of fuel on a lit station and report whether a job's share was paid.
 *
 * The fire is either idling or working, never both: the burn for the tick is the
 * larger of the ambient rate and the running job's share. Charging both would double
 * the cost of every smelt relative to what the recipe table says it costs.
 *
 * Returns false only when a job that *needs* fuel could not be paid, which is the
 * caller's cue to stall it with a reason rather than silently working for free.
 */
export function burnStationFuel(ctx: SimContext, ref: StationRef, jobRate: number): boolean {
  if (!ref.burnsFuel) return true;
  const station = ref.station;
  if (!station.lit) return jobRate <= 0;

  const burn = Math.max(AMBIENT_FUEL_BURN, jobRate);
  if (station.fuel < burn) {
    station.fuel = 0;
    douseStation(ctx, ref);
    return jobRate <= 0;
  }
  station.fuel = Math.max(0, station.fuel - burn);
  bump(ref.structure);
  markStructureDirty(ctx.state, ref.structure);
  return true;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * `refuel`: move fuel from a specific inventory slot into a station's fire.
 *
 * Feeds as many whole units as fit under `maxFuel`, so topping up a furnace from a
 * stack of ten logs is one command rather than ten. A single unit still goes in when
 * the station is nearly full - the player asked for it, and part of a log burning is
 * better than the fire going out.
 */
export function handleRefuel(
  ctx: SimContext,
  player: PlayerState,
  command: { structureId: string; inventorySlot: number },
): void {
  const fail = (reason: string) => rejectCommand(ctx, player, 'refuel', reason);
  if (!player.alive) return fail('you are dead');
  if (stationActionCooldown(ctx, player) > 0) return fail('still busy');

  const ref = resolveStation(ctx, command.structureId);
  if (!ref) return fail('that is not a station');
  if (!ref.burnsFuel) return fail(`a ${ref.def.name.toLowerCase()} burns no fuel`);
  if (ref.structure.progress < 1) return fail('that station is not finished');
  const blocked = stationOutOfReach(ctx, player, ref);
  if (blocked) return fail(blocked);

  const index = Math.floor(command.inventorySlot);
  if (!Number.isFinite(index) || index < 0 || index >= player.inventory.slots.length) {
    return fail('no such inventory slot');
  }
  const slot = player.inventory.slots[index];
  if (!slot) return fail('that slot is empty');
  const itemDef = ctx.data.items.get(slot.defId);
  const fuel = itemDef?.fuel;
  if (!itemDef || !fuel || fuel.burnTicks <= 0)
    return fail(`${itemDef?.name ?? 'that'} does not burn`);

  const space = ref.station.maxFuel - ref.station.fuel;
  if (space <= 0) return fail('the station is already full of fuel');

  const units = Math.min(slot.count, Math.max(1, Math.floor(space / fuel.burnTicks)));
  const taken = takeFromSlot(player.inventory, index, units);
  if (!taken) return fail('that slot is empty');

  ref.station.fuel = Math.min(ref.station.maxFuel, ref.station.fuel + taken.count * fuel.burnTicks);
  recomputeCarryWeight(player, ctx.data);
  beginStationAction(ctx, player);
  bump(ref.structure);
  markStructureDirty(ctx.state, ref.structure);
  ctx.events.emit({
    type: 'notification',
    playerId: player.id,
    severity: 'success',
    text: `Added ${taken.count} x ${itemDef.name} to the ${ref.def.name.toLowerCase()}.`,
  });
}

/** `ignite`: set a fuelled station alight, with a lighter or a neighbouring fire. */
export function handleIgnite(
  ctx: SimContext,
  player: PlayerState,
  command: { structureId: string },
): void {
  const fail = (reason: string) => rejectCommand(ctx, player, 'ignite', reason);
  if (!player.alive) return fail('you are dead');
  if (stationActionCooldown(ctx, player) > 0) return fail('still busy');

  const ref = resolveStation(ctx, command.structureId);
  if (!ref) return fail('that is not a station');
  if (!ref.burnsFuel) return fail(`a ${ref.def.name.toLowerCase()} has nothing to light`);
  if (ref.structure.progress < 1) return fail('that station is not finished');
  const blocked = stationOutOfReach(ctx, player, ref);
  if (blocked) return fail(blocked);
  if (ref.station.lit) return fail('it is already lit');
  if (ref.station.fuel <= 0) return fail('there is no fuel in it');

  if (!adjacentLitFire(ctx, ref)) {
    const source = findIgnitionSource(ctx, player);
    if (!source) return fail('you have nothing to light it with');
    const sourceDef = ctx.data.items.get(source.stack.defId);
    spendToolUse(ctx, player, source, sourceDef?.tool?.durabilityPerUse ?? 1);
  }

  beginStationAction(ctx, player);
  lightStation(ctx, ref);
}

/** `extinguish`: put a station's fire out on purpose. Its remaining fuel keeps. */
export function handleExtinguish(
  ctx: SimContext,
  player: PlayerState,
  command: { structureId: string },
): void {
  const fail = (reason: string) => rejectCommand(ctx, player, 'extinguish', reason);
  if (!player.alive) return fail('you are dead');
  if (stationActionCooldown(ctx, player) > 0) return fail('still busy');

  const ref = resolveStation(ctx, command.structureId);
  if (!ref) return fail('that is not a station');
  if (!ref.burnsFuel) return fail(`a ${ref.def.name.toLowerCase()} is not on fire`);
  const blocked = stationOutOfReach(ctx, player, ref);
  if (blocked) return fail(blocked);
  if (!ref.station.lit) return fail('it is not lit');

  beginStationAction(ctx, player);
  douseStation(ctx, ref);
}
