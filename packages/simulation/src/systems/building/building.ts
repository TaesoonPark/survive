import {
  CHUNK_SIZE,
  SIM_HZ,
  TICKS_PER_GAME_HOUR,
  TILE_SIZE,
  distance,
  pixelToTile,
  tileCenter,
  type CommandOf,
  type DamageType,
  type EntityId,
  type ItemStack,
  type PlayerState,
  type StructureState,
} from '@survive/protocol';
import type { ItemAmount, StructureDef, ToolKind } from '@survive/game-data';
import { CollisionFlag } from '@survive/world';
import { SystemOrder, type CommandRouter, type SimContext, type System } from '../../core/context';
import { damageAnimal, damageStructure, damageZombie } from '../../core/damage';
import { killAnimal, killZombie } from '../../core/death';
import { addToInventory, findTool, recomputeCarryWeight, spendDurability } from '../../core/items';
import { dropStack, dropStacks } from '../../core/loot';
import { NoiseRadius, emitNoise } from '../../core/noise';
import {
  bump,
  distanceToNearestPlayer,
  markStructureDirty,
  nearestPlayer,
  structureAtTile,
} from '../../core/queries';
import { grantXp, skillMultiplier } from '../../core/skills';
import { tileKey } from '../../core/state';
import {
  refreshStructureCollision,
  removeStructure,
  spawnStructure,
  structureCenter,
  structureCollisionFlags,
} from '../../core/structures';
import { spillReservedMaterials } from '../crafting/crafting';
import {
  BLUEPRINT_BUILD_RANGE,
  STRUCTURE_REACH,
  canPlace,
  chargeMaterials,
  costStacks,
  footprintDistance,
  isBuildable,
  missingMaterial,
  scaleCost,
  scaleRefund,
  structureCovers,
  structureFootprint,
} from './placement';

/**
 * Construction, doors, repair, decay and traps.
 *
 * Everything that happens to a structure after (and including) the moment a player
 * decides to put it there. Placement validation itself lives in `./placement` because
 * the client's placement ghost has to run the identical check - see the note there.
 *
 * The per-tick half of this system is one pass over the structure table. That pass is
 * doing five unrelated jobs (blueprints, lights, beds, traps, decay) and it is one loop
 * on purpose: a base is thousands of structures, and five separate scans of the same
 * table is four scans too many.
 */

// --- action rate limits ------------------------------------------------------
// All of these spend the *shared* `useReadyTick`, the same clock interact and item use
// spend. A player is one pair of hands: they cannot hammer a wall and open a door in
// the same instant, and a client that tries is either lagging or lying.

/** Ticks of hands-full after placing a piece. */
export const BUILD_ACTION_TICKS = 4;
/** Ticks of hands-full after tearing a piece down. */
export const DEMOLISH_ACTION_TICKS = 10;
/** Ticks between repair swings. */
export const REPAIR_ACTION_TICKS = 10;
/** Ticks between door pulls. Stops a client farming door noise to bait zombies. */
export const DOOR_ACTION_TICKS = 4;

// --- repair ------------------------------------------------------------------

/** Health restored per repair swing, as a fraction of max health. */
export const REPAIR_HEALTH_FRACTION = 0.5;
/**
 * Fraction of the original cost each swing consumes.
 *
 * Two swings bring a wreck back to full for half the build cost, so repairing always
 * beats rebuilding on materials - which is the whole point of maintaining a base
 * instead of abandoning it. Every input rounds *up* to at least one unit, so a
 * structure whose cost is a single kit item is the one case where replacing is cheaper.
 */
export const REPAIR_COST_FRACTION = 0.25;
/** Building XP per repair swing, as a fraction of the structure's build XP. */
export const REPAIR_XP_FRACTION = 0.2;

// --- destruction and decay ---------------------------------------------------

/** Fraction of the build cost that survives a collapse as rubble. */
export const RUBBLE_RATIO = 0.25;
/** How often unmaintained structures are checked for rot. */
export const DECAY_INTERVAL_TICKS = TICKS_PER_GAME_HOUR;
/** Health lost per decay check, as a fraction of max health. */
export const DECAY_FRACTION = 0.01;
/** Inside this radius of a living player, nothing decays. */
export const DECAY_SAFE_RADIUS = CHUNK_SIZE * 2;

// --- lights and beds ---------------------------------------------------------

/**
 * How often burning fuel is deducted from a light.
 *
 * A torch spends 0.08 fuel a tick. Applying that every tick would bump the entity 20
 * times a second to replicate a number no client can see change, so it is batched to
 * once a second - the same total burn, one twentieth of the traffic.
 */
export const LIGHT_TICK_INTERVAL = SIM_HZ;

/**
 * How long a light with no declared burn life is expected to last.
 *
 * `torch_wall` costs one `torch`, whose item comment states the contract the budget
 * below follows: "a torch's burn life lives in `fuel.burnTicks`, which is what the wall
 * socket's `light.fuel` is filled from". This constant is only the floor for a light
 * whose parts declare neither burn time nor a reservoir - one in-game night, the
 * shortest span for which putting a light up is worth the walk.
 */
export const DEFAULT_LIGHT_BURN_TICKS = TICKS_PER_GAME_HOUR * 10;

/** How far an occupant may stray before a bed decides it is empty. */
export const BED_OCCUPANT_RANGE = 64;

// ---------------------------------------------------------------------------
// Traps
// ---------------------------------------------------------------------------

/**
 * Trap behaviour, keyed by structure id.
 *
 * `StructureDef` has no trap sub-state - the same contract gap `water_barrel` works
 * around by being declared a container - so the numbers live here, next to the code
 * that reads them, rather than being smuggled into a field that means something else.
 */
export interface TrapSpec {
  /** Damage per trigger, before armour and body-part modifiers. */
  damage: number;
  damageType: DamageType;
  /**
   * Ticks the victim is pinned, and also the trap's re-arm window: the victim's own
   * stagger clock is what stops the trap firing again on the next tick.
   */
  holdTicks: number;
  /** Structure health spent per trigger. This is the trap's durability. */
  wear: number;
}

export const TRAP_SPECS: Readonly<Record<string, TrapSpec>> = {
  // Stakes in a pit: cheap, brutal, and it grinds itself down fast.
  spike_trap: { damage: 30, damageType: 'pierce', holdTicks: SIM_HZ, wear: 6 },
  // Steel jaws: less damage, but eight seconds of a walker going nowhere.
  bear_trap: { damage: 22, damageType: 'pierce', holdTicks: SIM_HZ * 8, wear: 14 },
};

/** Trap behaviour for a structure definition, or undefined when it is not a trap. */
export function trapSpec(defId: string): TrapSpec | undefined {
  return TRAP_SPECS[defId];
}

// ---------------------------------------------------------------------------
// The system
// ---------------------------------------------------------------------------

export function createBuildingSystem(): System {
  return {
    id: 'building',
    order: SystemOrder.Structure,
    init(_ctx: SimContext, router: CommandRouter) {
      router.on('setBuildSelection', handleSetBuildSelection);
      router.on('build', handleBuild);
      router.on('demolish', handleDemolish);
      router.on('repair', handleRepair);
      router.on('toggleDoor', handleToggleDoor);
      // `interact` is shared with the gathering and inventory systems, split by target
      // kind: this handler acts on doors and says nothing at all about anything else,
      // so one click on one thing produces one answer.
      router.on('interact', handleInteract);
    },
    update: updateBuilding,
  };
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

function rejectBuild(ctx: SimContext, player: PlayerState, defId: string, reason: string): void {
  ctx.events.emit({ type: 'buildRejected', playerId: player.id, defId, reason });
}

function reject(ctx: SimContext, player: PlayerState, command: string, reason: string): void {
  ctx.events.emit({ type: 'commandRejected', playerId: player.id, command, reason });
}

/**
 * Remember what the player is about to build.
 *
 * Purely cosmetic state - the `build` command carries its own definition and is
 * validated on its own merits - but it is replicated so that other clients can draw the
 * ghost too, and so a reconnect does not lose the selection.
 */
function handleSetBuildSelection(
  ctx: SimContext,
  player: PlayerState,
  command: CommandOf<'setBuildSelection'>,
): void {
  if (command.defId === null) {
    delete player.buildDefId;
    player.buildRotation = 0;
    bump(player);
    return;
  }
  if (!ctx.data.structures.has(command.defId)) {
    reject(ctx, player, 'setBuildSelection', 'unknownStructure');
    return;
  }
  if (!isBuildable(ctx, command.defId)) {
    reject(ctx, player, 'setBuildSelection', 'notBuildable');
    return;
  }
  if (!Number.isInteger(command.rotation)) {
    reject(ctx, player, 'setBuildSelection', 'badRotation');
    return;
  }
  player.buildDefId = command.defId;
  player.buildRotation = ((command.rotation % 4) + 4) % 4;
  bump(player);
}

/**
 * Place a piece.
 *
 * The whole of the validation is {@link canPlace}, so that the ghost the player was
 * looking at and the answer they get are the same answer. Materials are charged only
 * after the structure actually exists, so a failure inside `spawnStructure` cannot eat
 * someone's timber.
 */
function handleBuild(ctx: SimContext, player: PlayerState, command: CommandOf<'build'>): void {
  // Liveness before the rate limit: a corpse whose hands were full when it died should
  // hear "you are dead", not "wait a moment".
  if (!player.alive) {
    rejectBuild(ctx, player, command.defId, 'dead');
    return;
  }
  if (player.useReadyTick > ctx.state.tick) {
    rejectBuild(ctx, player, command.defId, 'busy');
    return;
  }

  const check = canPlace(
    ctx,
    player,
    command.defId,
    command.tileX,
    command.tileY,
    command.rotation,
  );
  if (!check.ok) {
    rejectBuild(ctx, player, command.defId, check.reason ?? 'invalid');
    return;
  }

  const def = ctx.data.structures.require(command.defId);
  // A piece with real work in it starts as a frame the builder has to stand and finish;
  // anything instant (a bedroll thrown on the ground) is simply done.
  const progress = def.buildTicks > 0 ? 0 : 1;
  const structure = spawnStructure(
    ctx,
    def.id,
    command.tileX,
    command.tileY,
    command.rotation,
    player.id,
    progress,
  );
  if (!structure) {
    rejectBuild(ctx, player, command.defId, 'unknownStructure');
    return;
  }

  chargeMaterials(ctx, player, def.cost);
  if (def.tool) wearTool(ctx, player, def.tool, 1);
  player.useReadyTick = ctx.state.tick + BUILD_ACTION_TICKS;
  bump(player);

  const centre = structureCenter(structure, def);
  emitNoise(ctx, centre.x, centre.y, NoiseRadius.Building, 0.7, player.id);
  ctx.events.emit({
    type: 'structurePlaced',
    structureId: structure.id,
    defId: def.id,
    tileX: structure.tileX,
    tileY: structure.tileY,
    builderId: player.id,
  });

  if (structure.progress >= 1) completeStructure(ctx, structure, def, player);
}

/**
 * Tear a piece down and get some of the materials back.
 *
 * Ownership is checked before the tool requirement so that "that is not yours" is what
 * a griefer hears, rather than a hint about which tool to go and fetch.
 */
function handleDemolish(
  ctx: SimContext,
  player: PlayerState,
  command: CommandOf<'demolish'>,
): void {
  if (!player.alive) {
    reject(ctx, player, 'demolish', 'dead');
    return;
  }
  if (player.useReadyTick > ctx.state.tick) {
    reject(ctx, player, 'demolish', 'busy');
    return;
  }
  const structure = ctx.state.structures[command.structureId];
  const def = structure ? ctx.data.structures.get(structure.defId) : undefined;
  if (!structure || !def) {
    reject(ctx, player, 'demolish', 'unknownStructure');
    return;
  }
  if (!def.destructible) {
    reject(ctx, player, 'demolish', 'indestructible');
    return;
  }

  const tiles = structureFootprint(structure, def);
  if (footprintDistance(tiles, player.x, player.y) > STRUCTURE_REACH) {
    reject(ctx, player, 'demolish', 'outOfRange');
    return;
  }
  // A world-generated structure belongs to nobody and anyone may clear it. A built one
  // is its owner's until the server says otherwise, and `pvp` is that switch: a server
  // that lets players shoot each other lets them knock each other's walls down too.
  if (structure.ownerId && structure.ownerId !== player.id && !ctx.config.mode.pvp) {
    reject(ctx, player, 'demolish', 'notOwner');
    return;
  }
  if (def.tool && !findTool(player, def.tool, ctx.data)) {
    reject(ctx, player, 'demolish', 'missingTool');
    return;
  }

  // Cancelling a frame returns everything: the materials went in, the labour did not.
  const ratio = structure.progress >= 1 ? def.refundRatio : 1;
  const refund = costStacks(ctx, scaleRefund(def.cost, ratio));
  for (const stack of refund) {
    const moving: ItemStack = { ...stack };
    const leftover = addToInventory(player.inventory, moving, ctx.data);
    if (leftover > 0) dropStack(ctx, player.x, player.y, { ...stack, count: leftover }, player.id);
  }
  recomputeCarryWeight(player, ctx.data);
  if (def.tool) wearTool(ctx, player, def.tool, 1);
  player.useReadyTick = ctx.state.tick + DEMOLISH_ACTION_TICKS;
  bump(player);

  const centre = structureCenter(structure, def);
  spillContainer(ctx, structure, centre.x, centre.y);
  if (structure.station) {
    spillReservedMaterials(ctx, structure.station.jobs, centre.x, centre.y);
  }
  releaseStructure(ctx, structure);
  removeStructure(ctx, structure);
  restoreTiles(ctx, tiles);

  emitNoise(ctx, centre.x, centre.y, NoiseRadius.Building, 0.8, player.id);
  ctx.events.emit({ type: 'structureDemolished', structureId: structure.id, refund });
}

/**
 * Hammer a damaged structure back towards full health.
 *
 * In steps rather than all at once, so repairing a chewed-through wall during a siege
 * is a decision about time as well as materials.
 */
function handleRepair(ctx: SimContext, player: PlayerState, command: CommandOf<'repair'>): void {
  if (!player.alive) {
    reject(ctx, player, 'repair', 'dead');
    return;
  }
  if (player.useReadyTick > ctx.state.tick) {
    reject(ctx, player, 'repair', 'busy');
    return;
  }
  const structure = ctx.state.structures[command.structureId];
  const def = structure ? ctx.data.structures.get(structure.defId) : undefined;
  if (!structure || !def) {
    reject(ctx, player, 'repair', 'unknownStructure');
    return;
  }
  if (!def.destructible) {
    reject(ctx, player, 'repair', 'indestructible');
    return;
  }
  // An unfinished frame is not damaged, it is unfinished: stand next to it instead.
  if (structure.progress < 1) {
    reject(ctx, player, 'repair', 'blueprint');
    return;
  }
  if (structure.health >= structure.maxHealth) {
    reject(ctx, player, 'repair', 'notDamaged');
    return;
  }
  const tiles = structureFootprint(structure, def);
  if (footprintDistance(tiles, player.x, player.y) > STRUCTURE_REACH) {
    reject(ctx, player, 'repair', 'outOfRange');
    return;
  }

  const hammer = findTool(player, 'hammer', ctx.data);
  if (!hammer) {
    reject(ctx, player, 'repair', 'missingTool');
    return;
  }
  const cost = repairCost(def);
  if (missingMaterial(player, cost)) {
    reject(ctx, player, 'repair', 'missingMaterials');
    return;
  }

  chargeMaterials(ctx, player, cost);
  wearTool(ctx, player, 'hammer', 1);

  const step = def.maxHealth * REPAIR_HEALTH_FRACTION * skillMultiplier(player, 'building', 0.05);
  const healed = Math.min(structure.maxHealth - structure.health, Math.round(step));
  structure.health += healed;
  bump(structure);
  markStructureDirty(ctx.state, structure);

  player.useReadyTick = ctx.state.tick + REPAIR_ACTION_TICKS;
  bump(player);
  grantXp(ctx, player, 'building', Math.max(1, Math.round(def.xp * REPAIR_XP_FRACTION)));

  const centre = structureCenter(structure, def);
  emitNoise(ctx, centre.x, centre.y, NoiseRadius.Building, 0.7, player.id);
  ctx.events.emit({ type: 'structureRepaired', structureId: structure.id, amount: healed });
}

/**
 * Open or close a door.
 *
 * The collision grid is the authority on "can something walk here", so the toggle is
 * only real once {@link refreshStructureCollision} has run - which is also what makes a
 * closed door block line of sight and an open one not.
 */
function handleToggleDoor(
  ctx: SimContext,
  player: PlayerState,
  command: CommandOf<'toggleDoor'>,
): void {
  tryToggleDoor(ctx, player, ctx.state.structures[command.structureId], command.code, 'toggleDoor');
}

/**
 * A generic click that landed on a door.
 *
 * The keypress that opens a door is the same one that picks a berry, so `interact`
 * arrives at several systems at once. This one answers only when the target really is a
 * door; anything else it leaves entirely alone, including the rejection, because the
 * system that owns that target is going to speak for it.
 */
function handleInteract(
  ctx: SimContext,
  player: PlayerState,
  command: CommandOf<'interact'>,
): void {
  const structure = resolveDoorTarget(ctx, command);
  if (!structure) return;
  // No code: `interact` carries none, so a locked door only opens for its owner. A
  // client that knows the combination sends `toggleDoor` instead.
  tryToggleDoor(ctx, player, structure, undefined, 'interact');
}

/** The door an `interact` was aimed at, by entity id or by tile, or nothing. */
function resolveDoorTarget(
  ctx: SimContext,
  command: CommandOf<'interact'>,
): StructureState | undefined {
  if (command.targetId !== undefined) {
    const structure = ctx.state.structures[command.targetId];
    return structure?.door ? structure : undefined;
  }
  if (command.tileX === undefined || command.tileY === undefined) return undefined;
  const structure = structureAtTile(ctx.state, command.tileX, command.tileY);
  return structure?.door ? structure : undefined;
}

/**
 * The one door toggle.
 *
 * `command` is only the label the rejection carries, so the UI can tell which of its
 * two paths was refused; the rules themselves are identical either way.
 */
function tryToggleDoor(
  ctx: SimContext,
  player: PlayerState,
  structure: StructureState | undefined,
  code: string | undefined,
  command: string,
): void {
  if (!player.alive) {
    reject(ctx, player, command, 'dead');
    return;
  }
  if (player.useReadyTick > ctx.state.tick) {
    reject(ctx, player, command, 'busy');
    return;
  }
  const def = structure ? ctx.data.structures.get(structure.defId) : undefined;
  if (!structure || !def) {
    reject(ctx, player, command, 'unknownStructure');
    return;
  }
  const door = structure.door;
  if (!door) {
    reject(ctx, player, command, 'notADoor');
    return;
  }
  if (structure.progress < 1) {
    reject(ctx, player, command, 'blueprint');
    return;
  }
  const tiles = structureFootprint(structure, def);
  if (footprintDistance(tiles, player.x, player.y) > STRUCTURE_REACH) {
    reject(ctx, player, command, 'outOfRange');
    return;
  }
  if (door.locked && !canUnlock(structure, door.code, player, code)) {
    reject(ctx, player, command, 'locked');
    return;
  }

  door.open = !door.open;
  refreshStructureCollision(ctx, structure);
  bump(structure);
  markStructureDirty(ctx.state, structure);
  player.useReadyTick = ctx.state.tick + DOOR_ACTION_TICKS;
  bump(player);

  const centre = structureCenter(structure, def);
  emitNoise(ctx, centre.x, centre.y, NoiseRadius.DoorOpen, 0.6, player.id);
  ctx.events.emit({
    type: 'doorToggled',
    structureId: structure.id,
    open: door.open,
    byId: player.id,
  });
}

/**
 * Who gets through a locked door: the owner, or anyone who was told the code.
 *
 * A lock with no code set is an owner-only lock. Comparing `undefined` to `undefined`
 * would otherwise open it for the whole server.
 */
function canUnlock(
  structure: StructureState,
  code: string | undefined,
  player: PlayerState,
  supplied: string | undefined,
): boolean {
  if (structure.ownerId === player.id) return true;
  if (typeof code !== 'string' || code.length === 0) return false;
  return supplied === code;
}

/** Materials one repair swing consumes. */
export function repairCost(def: StructureDef): ItemAmount[] {
  return def.cost.map((entry) => ({
    defId: entry.defId,
    count: Math.max(1, Math.ceil(entry.count * REPAIR_COST_FRACTION)),
  }));
}

// ---------------------------------------------------------------------------
// Per-tick
// ---------------------------------------------------------------------------

function updateBuilding(ctx: SimContext): void {
  const tick = ctx.state.tick;
  const decayNow = tick % DECAY_INTERVAL_TICKS === 0;
  const burnNow = tick % LIGHT_TICK_INTERVAL === 0;

  // Sorted so that two hosts with the same state destroy the same structure first when
  // a collapse cascades into dropped loot, which consumes RNG.
  const ids = Object.keys(ctx.state.structures).sort();
  const doomed: EntityId[] = [];

  for (const id of ids) {
    const structure = ctx.state.structures[id];
    if (!structure) continue;
    const def = ctx.data.structures.get(structure.defId);
    if (!def) continue;

    if (structure.progress < 1) {
      advanceBlueprint(ctx, structure, def);
    } else {
      // A frame has no bed to lie in, no wick to burn and no jaws to spring: the parts
      // that make a structure do something are only real once it is finished.
      if (structure.bed) syncBed(ctx, structure);
      if (structure.light) tickLight(ctx, structure, def, burnNow);
      const trap = TRAP_SPECS[structure.defId];
      if (trap) triggerTrap(ctx, structure, def, trap);
    }

    // Decay is the exception: it applies to a frame too. Abandoned timber is exactly
    // what should go back to the world, and a frame that never rotted would be
    // permanent litter - one misclick on the far side of the map, forever.
    if (decayNow) decayStructure(ctx, structure, def);

    if (structure.health <= 0) doomed.push(id);
  }

  // Collected first: destroying inside the loop would drop loot and re-index tiles
  // while the table it iterates is being mutated.
  for (const id of doomed) {
    const structure = ctx.state.structures[id];
    if (structure) destroyStructure(ctx, structure);
  }
}

/**
 * Move an unfinished frame towards done.
 *
 * Only while somebody is standing close enough to be swinging at it: a half-built wall
 * left alone stays a half-built wall. `craftSpeed` is the tuning knob - a server that
 * halves crafting time halves construction time with it, because they are the same
 * "how long does making things take" dial to the person setting it.
 *
 * The builder is held in place while they work. Raising a frame used to be something that
 * happened *near* you rather than something you did: the progress bar filled while you
 * walked off, which read as the world building itself. The lock is re-armed every tick
 * rather than set for the whole job, so it lapses on its own the moment the frame is
 * finished or the builder is out of range - there is no state to unwind and no way to be
 * left frozen by a frame that was destroyed mid-build.
 */
function advanceBlueprint(ctx: SimContext, structure: StructureState, def: StructureDef): void {
  const centre = structureCenter(structure, def);
  const builder = nearestPlayer(ctx.state, centre.x, centre.y, BLUEPRINT_BUILD_RANGE);
  if (!builder) return;

  const perTick = 1 / Math.max(1, def.buildTicks);
  const rate = perTick * ctx.config.tuning.craftSpeed * skillMultiplier(builder, 'building', 0.04);
  structure.progress = Math.min(1, structure.progress + rate);
  bump(structure);
  markStructureDirty(ctx.state, structure);

  if (structure.progress >= 1) {
    // Not locked on the tick it finishes: the work is done and the next step is the
    // player's own again.
    completeStructure(ctx, structure, def, builder);
    return;
  }
  // Two ticks, not one. The lock is compared against the tick it is read on, so a single
  // tick of margin would leave the player free on every other step and produce a stutter
  // rather than a stop.
  builder.actionLockedUntilTick = Math.max(builder.actionLockedUntilTick, ctx.state.tick + 2);
  bump(builder);
  if (ctx.state.tick % SIM_HZ === 0) {
    emitNoise(ctx, centre.x, centre.y, NoiseRadius.Building, 0.5, builder.id);
  }
}

/** Finish a structure: full health, XP for whoever drove the last nail. */
function completeStructure(
  ctx: SimContext,
  structure: StructureState,
  def: StructureDef,
  builder: PlayerState | undefined,
): void {
  structure.progress = 1;
  structure.health = structure.maxHealth;
  igniteLight(ctx, structure, def);
  bump(structure);
  markStructureDirty(ctx.state, structure);

  if (builder) {
    builder.stats.structuresBuilt++;
    bump(builder);
    grantXp(ctx, builder, 'building', def.xp);
  }

  const centre = structureCenter(structure, def);
  emitNoise(ctx, centre.x, centre.y, NoiseRadius.Building, 0.8, structure.id);
  ctx.events.emit({
    type: 'notification',
    ...(builder ? { playerId: builder.id } : {}),
    severity: 'success',
    message: { code: 'notify.structureFinished', params: { structure: def.name } },
  });
}

/**
 * Fuel a finished light starts with, read off the materials it was made from.
 *
 * `light.fuel` is in the same unit as `station.fuel` and `FuelProps.burnTicks`, so a
 * torch nailed to a wall simply inherits the torch's own `fuel.burnTicks` and burns it
 * down at the socket's `fuelPerTick`. A lantern declares no fuel but does declare
 * `maxDurability` - its reservoir, in the only unit the item table has for "how long
 * this lasts" - so that stands in for it, and a lantern post ends up outlasting a torch
 * by the margin its description promises. Only a light whose every part declares
 * neither falls back to a flat {@link DEFAULT_LIGHT_BURN_TICKS} of life, because one
 * that came out of the build menu already dead would just look like a bug.
 */
export function lightFuelBudget(ctx: SimContext, def: StructureDef): number {
  let fuel = 0;
  for (const entry of def.cost) {
    const item = ctx.data.items.get(entry.defId);
    if (!item) continue;
    fuel += (item.fuel?.burnTicks ?? item.maxDurability ?? 0) * entry.count;
  }
  // The fallback is a duration, so it has to be converted into fuel units at this
  // light's own burn rate before it means anything.
  if (fuel <= 0) fuel = (def.light?.fuelPerTick ?? 0) * DEFAULT_LIGHT_BURN_TICKS;
  return fuel;
}

/**
 * Light a finished standalone lamp.
 *
 * A station's fire is the crafting system's business - `ignite` needs a flame and a
 * reason - but a torch or a lantern post has no fuel hopper and no ignite command
 * pointed at it, so its one moment of being lit is the moment it is finished. Fuel is
 * only ever granted here, so re-finishing an already-lit light (which cannot happen,
 * but would be a silent duplication bug if it did) tops nothing up.
 */
function igniteLight(ctx: SimContext, structure: StructureState, def: StructureDef): void {
  const light = structure.light;
  if (!light || structure.station) return;
  if (light.on) return;
  light.fuel = lightFuelBudget(ctx, def);
  light.on = light.fuel > 0;
  if (light.on) ctx.events.emit({ type: 'stationLit', structureId: structure.id, lit: true });
}

/**
 * Keep a bed's occupant honest.
 *
 * The sleep system sets `bed.occupantId`; nothing guarantees it clears it, because the
 * occupant can be killed, disconnected or dragged off by a zombie. A bed that thinks it
 * is occupied forever is a bed nobody can ever use again, so the structure that owns
 * the field is the one that re-checks it.
 */
function syncBed(ctx: SimContext, structure: StructureState): void {
  const bed = structure.bed;
  if (!bed) return;
  if (!bed.occupantId) {
    if (bed.sleepStartTick >= 0) {
      bed.sleepStartTick = -1;
      bump(structure);
    }
    return;
  }
  const occupant = ctx.state.players[bed.occupantId];
  const def = ctx.data.structures.get(structure.defId);
  const centre = def
    ? structureCenter(structure, def)
    : { x: tileCenter(structure.tileX), y: tileCenter(structure.tileY) };
  const gone =
    !occupant ||
    !occupant.alive ||
    distance(occupant.x, occupant.y, centre.x, centre.y) > BED_OCCUPANT_RANGE;
  if (!gone) return;

  delete bed.occupantId;
  bed.sleepStartTick = -1;
  bump(structure);
  markStructureDirty(ctx.state, structure);
}

/**
 * Burn a light's fuel.
 *
 * A structure that is both a station and a light - a campfire - has one fire, and the
 * station's fuel is the authority on it, so here the light only mirrors `station.lit`
 * rather than burning a second, independent budget. A standalone torch or lantern burns
 * its own.
 *
 * There is no `lightExtinguished` event in the protocol, so a light going out reports
 * itself as `stationLit: false`, which is the same news in the same words.
 */
function tickLight(
  ctx: SimContext,
  structure: StructureState,
  def: StructureDef,
  burnNow: boolean,
): void {
  const light = structure.light;
  if (!light) return;

  if (structure.station) {
    if (light.on !== structure.station.lit) {
      light.on = structure.station.lit;
      bump(structure);
    }
    return;
  }

  if (!burnNow || !light.on) return;
  const perTick = def.light?.fuelPerTick ?? 0;
  light.fuel = Math.max(0, light.fuel - perTick * LIGHT_TICK_INTERVAL);
  if (light.fuel <= 0) {
    light.on = false;
    ctx.events.emit({ type: 'stationLit', structureId: structure.id, lit: false });
  }
  bump(structure);
  markStructureDirty(ctx.state, structure);
}

/**
 * Rot.
 *
 * Only player-built work, and only when nobody has been near it: a base you live in
 * never decays, and a base you walked away from goes back to the world over a few
 * in-game days. Checked once an in-game hour rather than every tick, because a
 * hundredth of a percent per tick is a rounding error nobody can see.
 *
 * The rate is a fraction of *max* health, not of what is left, so an unfinished frame
 * (which spawns at a third of its health) rots away in a third of the time a finished
 * piece takes - which reads correctly: bare timber goes first.
 *
 * With nobody in the world at all, everything is "far from a player" - which is the
 * correct reading, and in practice the host has unloaded those chunks long before.
 */
function decayStructure(ctx: SimContext, structure: StructureState, def: StructureDef): void {
  if (!structure.ownerId) return;
  if (!def.destructible) return;
  const centre = structureCenter(structure, def);
  if (distanceToNearestPlayer(ctx.state, centre.x, centre.y) <= DECAY_SAFE_RADIUS) return;
  damageStructure(ctx, structure, {
    amount: Math.max(1, def.maxHealth * DECAY_FRACTION),
    type: 'blunt',
    cause: 'decay',
  });
}

/**
 * Spring a trap on whatever just stood on it.
 *
 * The trap has no cooldown field of its own, so the victim's own stagger clock doubles
 * as the re-arm gate - which also reads correctly in play: a thing that just took the
 * spikes is reeling, and a reeling thing is not stepping on them again this instant.
 * That is the same clock the bear trap holds its victim with, so one number does both
 * jobs.
 */
function triggerTrap(
  ctx: SimContext,
  structure: StructureState,
  def: StructureDef,
  spec: TrapSpec,
): void {
  const tick = ctx.state.tick;
  const tiles = structureFootprint(structure, def);
  const covered = new Set(tiles.map((tile) => tileKey(tile.tileX, tile.tileY)));
  const centre = structureCenter(structure, def);
  const reach = (Math.max(tiles.length, 2) * TILE_SIZE) / 2 + TILE_SIZE;

  const candidates = ctx.spatial
    .queryKinds(centre.x, centre.y, reach, ['zombie', 'animal'])
    .map((entry) => entry.id)
    .sort();

  for (const id of candidates) {
    if (structure.health <= 0) return;

    const zombie = ctx.state.zombies[id];
    if (zombie) {
      if (zombie.ai === 'dead' || zombie.staggerUntilTick > tick) continue;
      if (!covered.has(tileKey(pixelToTile(zombie.x), pixelToTile(zombie.y)))) continue;
      const result = damageZombie(ctx, zombie, {
        amount: spec.damage,
        type: spec.damageType,
        // Attributed to the trap, not its owner: a zombie that gets hurt turns on what
        // hurt it, and a trap that pointed every walker at an absent owner across the
        // map would be a beacon rather than a defence.
        attackerId: structure.id,
        cause: def.name,
      });
      pinZombie(ctx, id, tick, spec.holdTicks);
      if (result.killed) killZombie(ctx, zombie, spec.damageType, structure.ownerId);
      wearTrap(ctx, structure, spec);
      continue;
    }

    const animal = ctx.state.animals[id];
    if (!animal) continue;
    if (animal.ai === 'dead' || animal.attackReadyTick > tick) continue;
    if (!covered.has(tileKey(pixelToTile(animal.x), pixelToTile(animal.y)))) continue;
    const result = damageAnimal(ctx, animal, {
      amount: spec.damage,
      type: spec.damageType,
      attackerId: structure.id,
      cause: def.name,
    });
    // Animals have no stagger clock, so the hold is "your brain does not run and you
    // have no velocity" - which is what being caught by the leg looks like from here.
    animal.attackReadyTick = Math.max(animal.attackReadyTick, tick + spec.holdTicks);
    animal.nextThinkTick = Math.max(animal.nextThinkTick, tick + spec.holdTicks);
    animal.vx = 0;
    animal.vy = 0;
    bump(animal);
    if (result.killed) killAnimal(ctx, animal, spec.damageType, structure.ownerId);
    wearTrap(ctx, structure, spec);
  }
}

function pinZombie(ctx: SimContext, id: EntityId, tick: number, holdTicks: number): void {
  const zombie = ctx.state.zombies[id];
  if (!zombie || zombie.ai === 'dead') return;
  zombie.staggerUntilTick = Math.max(zombie.staggerUntilTick, tick + holdTicks);
  zombie.nextThinkTick = Math.max(zombie.nextThinkTick, tick + holdTicks);
  zombie.vx = 0;
  zombie.vy = 0;
  zombie.ai = 'stagger';
  bump(zombie);
}

/**
 * Spend the trap's durability.
 *
 * Deliberately un-attributed: routing it through the victim would multiply the wear by
 * the structure's `zombieDamageMultiplier`, and a spike trap's 1.6x is there to say
 * "zombies smash these quickly", not "these wear out faster when they work".
 */
function wearTrap(ctx: SimContext, structure: StructureState, spec: TrapSpec): void {
  damageStructure(ctx, structure, { amount: spec.wear, type: 'blunt', cause: 'trap' });
}

// ---------------------------------------------------------------------------
// Destruction
// ---------------------------------------------------------------------------

/**
 * A structure at zero health comes apart.
 *
 * Some of the materials survive as rubble on the ground, and anything stored inside
 * spills with them: losing a chest should cost you the chest, not silently delete forty
 * slots of loot.
 *
 * Exported because combat kills structures too, and it must not have its own, shorter
 * version of "comes apart" - a sledgehammer or a zombie chewing through a storage locker
 * used to delete the contents outright while the decay reaper spilled them properly.
 * `attackerId` attributes the collapse noise to whoever caused it, so the AI investigates
 * the breach rather than the rubble.
 */
export function destroyStructure(
  ctx: SimContext,
  structure: StructureState,
  attackerId?: EntityId,
): void {
  const def = ctx.data.structures.get(structure.defId);
  const centre = def
    ? structureCenter(structure, def)
    : { x: tileCenter(structure.tileX), y: tileCenter(structure.tileY) };
  const tiles = def
    ? structureFootprint(structure, def)
    : [{ tileX: structure.tileX, tileY: structure.tileY }];

  spillContainer(ctx, structure, centre.x, centre.y);
  // A station's queued jobs are holding materials that left someone's pack. They belong on
  // the ground with the rest of the wreckage, not deleted with the record.
  if (structure.station) {
    spillReservedMaterials(ctx, structure.station.jobs, centre.x, centre.y);
  }
  if (def) dropStacks(ctx, centre.x, centre.y, costStacks(ctx, scaleCost(def.cost, RUBBLE_RATIO)));

  releaseStructure(ctx, structure);
  removeStructure(ctx, structure);
  restoreTiles(ctx, tiles);

  emitNoise(ctx, centre.x, centre.y, NoiseRadius.StructureBreak, 1, attackerId ?? structure.id);
  ctx.events.emit({
    type: 'structureDestroyed',
    structureId: structure.id,
    defId: structure.defId,
    tileX: structure.tileX,
    tileY: structure.tileY,
  });
}

/** Empty a container onto the ground. */
function spillContainer(ctx: SimContext, structure: StructureState, x: number, y: number): void {
  const container = structure.container;
  if (!container) return;
  for (let i = 0; i < container.slots.length; i++) {
    const slot = container.slots[i];
    if (!slot) continue;
    dropStack(ctx, x, y, slot, undefined, 20);
    container.slots[i] = null;
  }
  container.viewers.length = 0;
}

/**
 * Drop every player-held reference to a structure that is about to stop existing.
 *
 * A dangling `openContainerId` leaves a UI open onto nothing; a dangling
 * `bedStructureId` respawns someone at a bed that burned down.
 */
function releaseStructure(ctx: SimContext, structure: StructureState): void {
  for (const id of Object.keys(ctx.state.players).sort()) {
    const player = ctx.state.players[id];
    if (!player) continue;
    let touched = false;
    if (player.openContainerId === structure.id) {
      delete player.openContainerId;
      touched = true;
    }
    if (player.bedStructureId === structure.id) {
      delete player.bedStructureId;
      touched = true;
    }
    if (touched) bump(player);
  }
}

/**
 * Re-assert the tile index and collision for whatever is left on a set of tiles.
 *
 * The tile index holds one structure per tile, so a wall built over a floor takes the
 * index entry - and `detachStructure` clears the whole tile's collision bits when
 * either of them is removed. Both leave the survivor unregistered, which shows up as a
 * wall you can walk through. Running this after every removal repairs both.
 */
function restoreTiles(ctx: SimContext, tiles: readonly { tileX: number; tileY: number }[]): void {
  for (const tile of tiles) {
    const key = tileKey(tile.tileX, tile.tileY);
    const holder =
      structureAtTile(ctx.state, tile.tileX, tile.tileY) ??
      findStructureCovering(ctx, tile.tileX, tile.tileY);
    if (!holder) continue;
    const def = ctx.data.structures.get(holder.defId);
    if (!def) continue;
    ctx.state.structureTiles[key] = holder.id;
    const flags = structureCollisionFlags(def, holder.door?.open ?? false);
    if (flags !== CollisionFlag.None) ctx.world.addCollision(tile.tileX, tile.tileY, flags);
  }
}

/**
 * The structure that should own a tile once the one that did is gone.
 *
 * Newest wins, since that is the one a player deliberately stacked on top; the id
 * breaks ties so two structures placed on the same tick cannot disagree between hosts.
 */
function findStructureCovering(
  ctx: SimContext,
  tileX: number,
  tileY: number,
): StructureState | undefined {
  let best: StructureState | undefined;
  for (const id of Object.keys(ctx.state.structures).sort()) {
    const structure = ctx.state.structures[id];
    if (!structure) continue;
    const def = ctx.data.structures.get(structure.defId);
    if (!def) continue;
    if (!structureCovers(structure, def, tileX, tileY)) continue;
    if (
      !best ||
      structure.builtTick > best.builtTick ||
      (structure.builtTick === best.builtTick && structure.id > best.id)
    ) {
      best = structure;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** Wear the tool a build action used, and discard it when it finally gives up. */
function wearTool(ctx: SimContext, player: PlayerState, kind: ToolKind, uses: number): void {
  const found = findTool(player, kind, ctx.data);
  if (!found) return;
  const def = ctx.data.items.get(found.stack.defId);
  const perUse = def?.tool?.durabilityPerUse ?? 1;
  if (!spendDurability(found.stack, perUse * uses)) {
    bump(player);
    return;
  }
  if (found.where === 'equipment') player.equipment[found.slot] = null;
  else player.inventory.slots[found.index] = null;
  recomputeCarryWeight(player, ctx.data);
  bump(player);
  ctx.events.emit({ type: 'weaponBroke', ownerId: player.id, defId: found.stack.defId });
}
