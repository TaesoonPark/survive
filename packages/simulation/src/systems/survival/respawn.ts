import { clampToWorld, distance, type CommandOf, type PlayerState } from '@survive/protocol';
import type { SimContext } from '../../core/context';
import { recomputeCarryWeight } from '../../core/items';
import { PLAYER_RADIUS } from '../../core/movement';
import { outfitPlayer, resetPlayerForRespawn } from '../../core/player';
import { bump } from '../../core/queries';
import { notify, reject } from './attrition';
import { bedCenter, isUsableBed } from './sleep';
import { SLEEP_REACH } from './tuning';
import { hasLineOfSightToStructure } from '../inventory/containers';

/**
 * Coming back.
 *
 * Death costs the player their gear (dropped where they fell by
 * {@link import('../../core/death').killPlayer}) and their position. Respawning is
 * the only way to undo the second half, and it is gated on three things the server
 * checks itself: the player really is dead, the grace period set at death has
 * elapsed, and the bed they asked for is still standing.
 *
 * A refused bed is a *fallback*, not a rejection: telling a dead player "your bed
 * burned down, try again" leaves them with nothing to try. They respawn at their
 * recorded spawn point with a notification explaining why.
 */

/** Radius searched for standing room around the intended respawn point, in pixels. */
export const RESPAWN_SEARCH_RADIUS = 256;

/** Candidate positions tried before giving up and using the point as-is. */
const RESPAWN_ATTEMPTS = 48;

/**
 * Nearest standable spot to a point.
 *
 * A bed can be walled in, and a spawn point recorded on open ground can have a wall
 * built over it since. Neither should wedge a player inside geometry, so the world's
 * own spawn search runs first; the raw point is only used when even that fails, which
 * beats refusing to respawn at all.
 */
function standableNear(
  ctx: SimContext,
  x: number,
  y: number,
  label: string,
): { x: number; y: number } {
  const safeX = clampToWorld(x);
  const safeY = clampToWorld(y);
  if (!ctx.world.circleBlocked(safeX, safeY, PLAYER_RADIUS)) return { x: safeX, y: safeY };
  const rng = ctx.rng.fork(`survival:respawn:${label}:${ctx.state.tick}`);
  const found = ctx.world.findSpawnPosition(
    safeX,
    safeY,
    RESPAWN_SEARCH_RADIUS,
    PLAYER_RADIUS,
    () => rng.next(),
    RESPAWN_ATTEMPTS,
  );
  return found ?? { x: safeX, y: safeY };
}

/**
 * The `respawn` command.
 *
 * `atBed` is a request, not an instruction: the bed has to still exist, still be a
 * bed, and not be holding someone else.
 */
export function handleRespawn(
  ctx: SimContext,
  player: PlayerState,
  command: CommandOf<'respawn'>,
): void {
  if (player.alive) {
    reject(ctx, player, 'respawn', 'you are not dead');
    return;
  }
  if (player.respawnAtTick >= 0 && ctx.state.tick < player.respawnAtTick) {
    const ticks = player.respawnAtTick - ctx.state.tick;
    reject(ctx, player, 'respawn', `wait ${ticks} more ticks`);
    return;
  }

  let target = { x: player.spawnX, y: player.spawnY };
  let label = 'spawn';
  let bedRefused: string | undefined;

  if (command.atBed) {
    const bedId = player.bedStructureId;
    const structure = bedId ? ctx.state.structures[bedId] : undefined;
    if (!structure) {
      bedRefused = 'notify.bedGone';
    } else if (!isUsableBed(ctx, structure)) {
      bedRefused = 'notify.bedWrecked';
    } else if (structure.bed?.occupantId !== undefined && structure.bed.occupantId !== player.id) {
      bedRefused = 'notify.bedOccupied';
    } else {
      target = bedCenter(ctx, structure);
      label = `bed:${structure.id}`;
      // A player who died in their own bed leaves it occupied; free it on the way back.
      if (structure.bed?.occupantId === player.id) {
        delete structure.bed.occupantId;
        structure.bed.sleepStartTick = -1;
        bump(structure);
      }
    }
  }

  const spot = standableNear(ctx, target.x, target.y, label);
  resetPlayerForRespawn(player, spot.x, spot.y, ctx.state.tick);
  // Come back dressed. A respawn used to hand back a naked, empty-handed character
  // standing wherever they died, which is the one situation the game gives no way out of:
  // the first tool needs materials, the materials need a tool, and the thing that killed
  // you is still there. `onlyMissing` keeps a death that spared the inventory from paying
  // out a second kit.
  outfitPlayer(ctx.data, player, { onlyMissing: true });
  // `killPlayer` zeroed the carried weight when it spilled the inventory; a loaded
  // save or a `dropInventory: false` death did not, so recompute rather than assume.
  recomputeCarryWeight(player, ctx.data);
  bump(player);

  ctx.events.emit({ type: 'playerRespawned', playerId: player.id, x: player.x, y: player.y });
  // One code per reason rather than a reason glued in front of a shared sentence: the two
  // halves do not stay in that order in every language.
  if (bedRefused) notify(ctx, player, 'warn', bedRefused);
}

/**
 * The `setSpawnPoint` command: claim a bed as the place you come back to, without
 * lying down in it.
 *
 * Sleeping already claims the bed it happened in, which covers the common case. This
 * exists for the other one: a player who keeps a bed at base and a bedroll in the
 * field has to be able to choose which one they respawn at, and paying for that with a
 * night's sleep they do not need would be a strange price.
 *
 * Validated exactly like a sleep, minus the threat check - marking a bed is a second's
 * work, not a night's, so zombies in the next room do not prevent it.
 */
export function handleSetSpawnPoint(
  ctx: SimContext,
  player: PlayerState,
  command: CommandOf<'setSpawnPoint'>,
): void {
  if (!player.alive) {
    reject(ctx, player, 'setSpawnPoint', 'you are dead');
    return;
  }
  const structure = ctx.state.structures[command.structureId];
  if (!structure) {
    reject(ctx, player, 'setSpawnPoint', 'no such structure');
    return;
  }
  if (!isUsableBed(ctx, structure)) {
    reject(ctx, player, 'setSpawnPoint', 'that is not a usable bed');
    return;
  }
  const centre = bedCenter(ctx, structure);
  if (distance(player.x, player.y, centre.x, centre.y) > SLEEP_REACH) {
    reject(ctx, player, 'setSpawnPoint', 'too far from the bed');
    return;
  }
  // See the matching note in `sleep.ts`: two tiles of reach clears a one-tile wall, so
  // without this a spawn point could be claimed on a bed sealed inside someone's base.
  if (!hasLineOfSightToStructure(ctx, player, structure)) {
    reject(ctx, player, 'setSpawnPoint', 'something is in the way');
    return;
  }
  // Someone else's occupied bed is theirs. An unoccupied one is claimable by anyone
  // who can reach it, exactly as sleeping in it would be.
  const occupant = structure.bed?.occupantId;
  if (occupant !== undefined && occupant !== player.id) {
    reject(ctx, player, 'setSpawnPoint', 'someone is already in it');
    return;
  }

  player.bedStructureId = structure.id;
  player.spawnX = centre.x;
  player.spawnY = centre.y;
  bump(player);
  notify(ctx, player, 'success', 'notify.bedSet');
}
