import {
  distance,
  type CommandOf,
  type PlayerId,
  type PlayerState,
  type StructureState,
} from '@survive/protocol';
import type { SimContext } from '../../core/context';
import { addEffect } from '../../core/effects';
import { PLAYER_RADIUS } from '../../core/movement';
import { bump, markStructureDirty } from '../../core/queries';
import { structureCenter } from '../../core/structures';
import { hasLineOfSightToStructure } from '../inventory/containers';
import { spillReservedMaterials } from '../crafting/crafting';
import { notify, reject } from './attrition';
import {
  SLEEP_REACH,
  SLEEP_THREAT_RADIUS,
  WELL_RESTED_FATIGUE,
  WELL_RESTED_MAGNITUDE,
  WELL_RESTED_MIN_SLEEP_TICKS,
  WELL_RESTED_TICKS,
} from './tuning';

/**
 * Sleeping in a bed.
 *
 * Who is asleep is **derived from replicated state**, never stored beside it: the bed
 * carries `occupantId` and the player carries `bedStructureId`, and a player counts as
 * asleep exactly when those two agree. That pair survives a save/load without a line
 * of bespoke serialization, and it means a bed cannot end up permanently "occupied" by
 * a player who has since been teleported, respawned or disconnected - the link breaks
 * from either end.
 *
 * The {@link SleeperSet} the system threads through here holds no authority over any
 * of that. It exists for one job: noticing that the link broke *without anyone asking
 * for it* - a bed burnt down under a sleeper - so `sleepEnded` still fires. Rebuilt
 * from state on join, so a reload loses nothing that matters.
 *
 * Sleeping does three things: fatigue falls fast, healing runs at
 * {@link import('./tuning').SLEEP_HEAL_SCALE} times its waking rate, and the bed
 * becomes the player's respawn point. It does **not** fast-forward the world clock.
 * The simulation reads only `state.tick` (Architecture Guard rule 8), so
 * "sleep through the night" is expressed as accelerated recovery for the sleeper -
 * multiplied by {@link import('./tuning').SINGLE_PLAYER_SLEEP_SCALE} in single player,
 * where nobody else is waiting on the world. A host that wants literal fast-forward
 * steps the simulation faster, which is a server-loop concern and keeps single-player
 * and multiplayer running the identical rule set.
 */

/** Players the system last saw asleep. Transient, derived, never authoritative. */
export type SleeperSet = Set<PlayerId>;

/** Why a sleeper woke up. Shapes the notification, not the mechanics. */
export type WakeReason = 'commanded' | 'rested' | 'threat' | 'moved' | 'bedLost' | 'died';

/**
 * The bed a player is currently asleep in, or undefined when awake.
 *
 * O(1) and self-healing: a stale `bedStructureId` - bed burnt down, player respawned
 * elsewhere - simply reads as "awake" rather than needing a sweep to clean up.
 */
export function sleepingBed(ctx: SimContext, player: PlayerState): StructureState | undefined {
  const id = player.bedStructureId;
  if (!id) return undefined;
  const structure = ctx.state.structures[id];
  if (!structure?.bed) return undefined;
  if (structure.bed.occupantId !== player.id) return undefined;
  return structure;
}

/** Whether a structure is a bed in a fit state to be slept in. */
export function isUsableBed(ctx: SimContext, structure: StructureState): boolean {
  if (!structure.bed) return false;
  if (structure.progress < 1) return false;
  if (structure.health <= 0) return false;
  return ctx.data.structures.get(structure.defId)?.bed !== undefined;
}

/** Centre of a bed's footprint, which is where a sleeper is laid down. */
export function bedCenter(ctx: SimContext, structure: StructureState): { x: number; y: number } {
  const def = ctx.data.structures.get(structure.defId);
  if (!def) return { x: structure.tileX * 32 + 16, y: structure.tileY * 32 + 16 };
  return structureCenter(structure, def);
}

/** Whether a living zombie is close enough to make sleep a bad idea. */
function threatNearby(ctx: SimContext, x: number, y: number): boolean {
  const entry = ctx.spatial.nearest(x, y, SLEEP_THREAT_RADIUS, ['zombie'], (candidate) => {
    const zombie = ctx.state.zombies[candidate.id];
    return zombie !== undefined && zombie.ai !== 'dead';
  });
  return entry !== null;
}

/**
 * Lie down. Validated against the world rather than trusted: the structure has to
 * exist, be a finished undamaged bed, be within arm's reach, and be free.
 */
export function handleSleep(
  ctx: SimContext,
  player: PlayerState,
  command: CommandOf<'sleep'>,
  sleepers: SleeperSet,
): void {
  if (!player.alive) {
    reject(ctx, player, 'sleep', 'you are dead');
    return;
  }
  if (sleepingBed(ctx, player)) {
    reject(ctx, player, 'sleep', 'already asleep');
    return;
  }
  const structure = ctx.state.structures[command.structureId];
  if (!structure) {
    reject(ctx, player, 'sleep', 'no such structure');
    return;
  }
  const bed = structure.bed;
  if (!bed || !isUsableBed(ctx, structure)) {
    reject(ctx, player, 'sleep', 'that is not a usable bed');
    return;
  }
  const centre = bedCenter(ctx, structure);
  if (distance(player.x, player.y, centre.x, centre.y) > SLEEP_REACH) {
    reject(ctx, player, 'sleep', 'too far from the bed');
    return;
  }
  // Distance alone is not reach. `SLEEP_REACH` is two tiles, so a bed one tile beyond a
  // wall is 63 px away and passes - which let a player lie down in, and claim as a respawn
  // point, a bed inside someone else's sealed base. Every other structure interaction pairs
  // the distance test with this one; beds were the exception.
  if (!hasLineOfSightToStructure(ctx, player, structure)) {
    reject(ctx, player, 'sleep', 'something is in the way');
    return;
  }
  if (bed.occupantId !== undefined && bed.occupantId !== player.id) {
    reject(ctx, player, 'sleep', 'someone is already in it');
    return;
  }
  if (threatNearby(ctx, centre.x, centre.y)) {
    reject(ctx, player, 'sleep', 'not with those things so close');
    return;
  }

  bed.occupantId = player.id;
  bed.sleepStartTick = ctx.state.tick;
  bump(structure);
  markStructureDirty(ctx.state, structure);

  // Laid down on the bed, but only where the bed centre is actually standable: a
  // two-tile reach must not become a two-tile teleport through a wall.
  if (!ctx.world.circleBlocked(centre.x, centre.y, PLAYER_RADIUS)) {
    player.x = centre.x;
    player.y = centre.y;
  }
  player.vx = 0;
  player.vy = 0;
  player.moveMode = 'walk';
  player.bedStructureId = structure.id;
  // Sleeping in a bed claims it as a respawn point. That is the whole reason to build
  // one somewhere other than where you happen to be standing.
  player.spawnX = centre.x;
  player.spawnY = centre.y;
  // Clearing the queue is deliberate - you do not craft in your sleep - but the materials
  // it reserved came out of this player's pack, and dropping the array dropped them with
  // it. They land beside the bed instead.
  spillReservedMaterials(ctx, player.craftQueue, player.x, player.y);
  player.craftQueue = [];
  bump(player);

  sleepers.add(player.id);
  ctx.events.emit({ type: 'sleepStarted', playerId: player.id, structureId: structure.id });
  notify(ctx, player, 'info', 'You settle down to sleep.');
}

/** The `wake` command: get up on purpose. */
export function handleWake(ctx: SimContext, player: PlayerState, sleepers: SleeperSet): void {
  const bed = sleepingBed(ctx, player);
  if (!bed && !sleepers.has(player.id)) {
    reject(ctx, player, 'wake', 'you are not asleep');
    return;
  }
  endSleep(ctx, player, bed, 'commanded', sleepers);
}

/** Wording for each way a night can end. */
const WAKE_MESSAGES: Record<WakeReason, string> = {
  commanded: 'You get up.',
  rested: 'You wake up rested.',
  threat: 'Something moving nearby drags you awake.',
  moved: 'You stir and get up.',
  bedLost: 'Your bed is gone. You wake on the ground.',
  died: 'You died in your sleep.',
};

/**
 * End a sleep, from any cause.
 *
 * `bed` may be undefined when the bed itself is what disappeared, in which case there
 * is nothing left to release and the time slept is unknowable, so it is reported as 0.
 */
export function endSleep(
  ctx: SimContext,
  player: PlayerState,
  bed: StructureState | undefined,
  reason: WakeReason,
  sleepers: SleeperSet,
): void {
  let ticksSlept = 0;
  if (bed?.bed) {
    const started = bed.bed.sleepStartTick;
    if (started >= 0) ticksSlept = Math.max(0, ctx.state.tick - started);
    delete bed.bed.occupantId;
    bed.bed.sleepStartTick = -1;
    bump(bed);
    markStructureDirty(ctx.state, bed);
  }
  // A night in a bed pays out twice: the fatigue it shed while asleep, and the
  // `well_rested` bonus that slows tomorrow's accumulation. See the tuning block for
  // why both a minimum duration and an actually-rested finish are required.
  if (
    reason !== 'died' &&
    ticksSlept >= WELL_RESTED_MIN_SLEEP_TICKS &&
    player.fatigue <= WELL_RESTED_FATIGUE
  ) {
    addEffect(ctx, player, 'well_rested', WELL_RESTED_TICKS, WELL_RESTED_MAGNITUDE);
  }
  // `bedStructureId` is deliberately kept: it is the respawn anchor, and an unoccupied
  // bed is already enough for `sleepingBed` to read the player as awake.
  bump(player);

  sleepers.delete(player.id);
  ctx.events.emit({ type: 'sleepEnded', playerId: player.id, ticksSlept });
  if (reason !== 'died') {
    notify(ctx, player, reason === 'threat' ? 'warn' : 'info', WAKE_MESSAGES[reason]);
  }
}

/**
 * Whether anything happened this tick that should end the sleep.
 *
 * Returns the reason to wake, or null to stay asleep. Checked before the recovery
 * steps so a sleeper woken by a zombie does not also collect that tick's sleep bonus.
 */
export function sleepInterruption(
  ctx: SimContext,
  player: PlayerState,
  bed: StructureState,
): WakeReason | null {
  if (!player.alive) return 'died';
  if (!isUsableBed(ctx, bed)) return 'bedLost';
  if (player.fatigue <= 0) return 'rested';

  const centre = bedCenter(ctx, bed);
  // Knockback, a teleport or a collapsing floor can carry a sleeper off the bed.
  if (distance(player.x, player.y, centre.x, centre.y) > SLEEP_REACH * 2) return 'moved';

  // A held movement key is a deliberate "get me up", and the only way out of a sleep
  // besides the `wake` command that needs no extra UI.
  const frame = ctx.inputs.get(player.id);
  if (frame && (Math.abs(frame.moveX) > 0.5 || Math.abs(frame.moveY) > 0.5)) return 'moved';

  if (threatNearby(ctx, centre.x, centre.y)) return 'threat';
  return null;
}

/**
 * Keep a sleeping player pinned. Movement and combat both refuse to act while
 * `actionLockedUntilTick` is in the future.
 *
 * The lock is refreshed every tick rather than set once far ahead, so it releases by
 * itself the moment the survival system stops calling this - including if the system
 * is removed entirely - instead of leaving a player frozen.
 */
export function holdSleeper(ctx: SimContext, player: PlayerState): void {
  player.actionLockedUntilTick = Math.max(player.actionLockedUntilTick, ctx.state.tick + 2);
}
