import type { PlayerState } from '@survive/protocol';
import { SystemOrder, type CommandRouter, type SimContext, type System } from '../../core/context';
import { syncHealthFromBody } from '../../core/damage';
import { killPlayer } from '../../core/death';
import { expireEffects } from '../../core/effects';
import { bump } from '../../core/queries';
import { applyConditionEffects } from './conditions';
import { handleTreat } from './consumption';
import { stepBleeding, stepHealing, stepInfection, stepPain } from './injury';
import { stepNeeds, stepTemperature } from './needs';
import { handleRespawn, handleSetSpawnPoint } from './respawn';
import {
  endSleep,
  handleSleep,
  handleWake,
  holdSleeper,
  sleepInterruption,
  sleepingBed,
  type SleeperSet,
} from './sleep';
import { createSurvivalTick } from './tick';

/**
 * The clock of doom.
 *
 * Everything that gets worse on its own runs here, once per tick, per player, in a
 * fixed order that is itself a design decision:
 *
 * 1. **Effects expire** first, so every later step reads a current effect list. A
 *    painkiller that ran out this tick must not still be dulling pain below.
 * 2. **Sleep** is resolved next, because whether the player is asleep changes the rate
 *    of almost everything after it.
 * 3. **Needs**, then **temperature**: hunger, thirst and fatigue, then the environment.
 *    Needs read the temperature settled at the end of the *previous* tick, which is one
 *    fixed step of lag and the price of not having to iterate the pair to a fixed point.
 * 4. **Wounds**: bleeding, then infection. Blood loss can kill inside a minute and
 *    infection over hours, so the fast one goes first and the slow one never gets a
 *    tick the player did not survive.
 * 5. **Pain**, then **healing**: what the body is coping with, then what it repairs.
 * 6. **Conditions** last, projecting the tick's final numbers into the effect list the
 *    HUD, movement and AI all read.
 *
 * Every step that can kill returns a boolean and the loop stops on it: a dead player
 * must not then be dehydrated, infected and healed in the same tick.
 *
 * Attrition damage is applied through `damagePlayer` with `ignoreArmor` and `silent` -
 * a vest does nothing about dehydration, and a `damage` event twenty times a second
 * would bury the event feed. The player is told what is happening by `notification` on
 * crossing a threshold instead: one event per meaningful change, not per tick.
 */
export function createSurvivalSystem(): System {
  // See sleep.ts: transient, derived from state on join, and authoritative over
  // nothing. It exists so a bed destroyed under a sleeper still fires `sleepEnded`.
  const sleepers: SleeperSet = new Set();

  return {
    id: 'survival',
    order: SystemOrder.Survival,

    init(_ctx: SimContext, router: CommandRouter): void {
      // `useItem` belongs to the inventory system, which owns the slot the item came
      // out of; it calls `consumeItem` from ./consumption. `treat` is ours, because
      // deciding what a bandage does to a wound is a survival rule, not an inventory one.
      router.on('treat', handleTreat);
      router.on('sleep', (ctx, player, command) => {
        handleSleep(ctx, player, command, sleepers);
      });
      router.on('wake', (ctx, player) => {
        handleWake(ctx, player, sleepers);
      });
      router.on('respawn', handleRespawn);
      // Beds are survival's business at both ends: where you lie down and where you
      // come back. `setSpawnPoint` is the second one without the first.
      router.on('setSpawnPoint', handleSetSpawnPoint);
    },

    onPlayerJoin(ctx: SimContext, player: PlayerState): void {
      // A save can restore a player mid-sleep: the bed's `occupantId` and the player's
      // `bedStructureId` both persist, so rebuild the transient set from them.
      if (sleepingBed(ctx, player)) sleepers.add(player.id);
    },

    onPlayerLeave(ctx: SimContext, player: PlayerState): void {
      // Never leave a bed occupied by someone who is no longer in the world.
      const bed = sleepingBed(ctx, player);
      if (bed || sleepers.has(player.id)) {
        endSleep(ctx, player, bed, 'commanded', sleepers);
      }
    },

    update(ctx: SimContext): void {
      stepSurvival(ctx, sleepers);
    },
  };
}

/**
 * One tick of survival for every player.
 *
 * Iterated in sorted id order: the steps emit noise-free events, but they do consume
 * RNG forks and can kill, and "which player starved first" must not depend on the
 * order a `Record` happens to have been built in (determinism rule).
 */
export function stepSurvival(ctx: SimContext, sleepers: SleeperSet): void {
  for (const playerId of Object.keys(ctx.state.players).sort()) {
    const player = ctx.state.players[playerId];
    if (!player) continue;
    stepPlayerSurvival(ctx, player, sleepers);
  }
}

/** One tick of survival for one player. Exported for focused tests. */
export function stepPlayerSurvival(
  ctx: SimContext,
  player: PlayerState,
  sleepers: SleeperSet,
): void {
  expireEffects(ctx, player);

  if (!player.alive) {
    // Died this tick or earlier. Release the bed once, then leave the corpse alone:
    // a dead player has no needs and their body must stay exactly as it fell.
    if (sleepers.has(player.id)) {
      endSleep(ctx, player, sleepingBed(ctx, player), 'died', sleepers);
    }
    return;
  }

  let bed = sleepingBed(ctx, player);
  if (!bed && sleepers.has(player.id)) {
    // The link broke without anyone asking - the bed burnt down, or something else
    // freed it. The player is already awake; this is only the announcement.
    endSleep(ctx, player, undefined, 'bedLost', sleepers);
  }
  if (bed) {
    const reason = sleepInterruption(ctx, player, bed);
    if (reason) {
      endSleep(ctx, player, bed, reason, sleepers);
      bed = undefined;
    } else {
      holdSleeper(ctx, player);
    }
  }

  const tick = createSurvivalTick(ctx, player, bed);

  if (stepNeeds(ctx, player, tick)) return;
  if (stepTemperature(ctx, player, tick)) return;
  if (stepBleeding(ctx, player, tick)) return;
  if (stepInfection(ctx, player, tick)) return;
  stepPain(ctx, player, tick);
  stepHealing(ctx, player, tick);
  applyConditionEffects(ctx, player);

  // Backstop. Every step above that can be fatal kills the player itself, but a wound
  // dealt earlier in the same tick by a system that failed to check its own damage
  // result would otherwise leave a corpse walking around at zero health.
  if (syncHealthFromBody(player)) {
    killPlayer(ctx, player, player.deathCause ?? 'wounds');
    return;
  }

  // One bump for the whole pass. Needs, temperature and blood change every single
  // tick, so there is no point paying for a dirty check per field.
  bump(player);
}
