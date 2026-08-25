import {
  chunkKeyAtPixel,
  createBody,
  type AnimalState,
  type Rng,
  type ZombieState,
} from '@survive/protocol';
import type { AnimalDef, ZombieDef } from '@survive/game-data';
import type { SimContext } from '../../core/context';
import { markDirtyAt } from '../../core/queries';

/**
 * Creature construction.
 *
 * Both the one-time chunk population pass and the ongoing spawn system need to put a
 * zombie or an animal into the world, and they must produce byte-identical state when
 * they do: a chunk that was populated at load and one that was topped up an hour later
 * have to be indistinguishable in a save file. That is the whole reason these live in
 * one place rather than being inlined twice.
 *
 * Neither function decides *where* the creature goes or *whether* it is allowed - the
 * callers own concealment, budgets and collision checks. These just build the state.
 */

/** Ticks of AI think delay spread over new spawns so a group does not think in lockstep. */
const THINK_JITTER_TICKS = 10;

/**
 * Create, register and announce a zombie.
 *
 * `rng` is the caller's stream, so a spawn roll and the zombie it produces stay on the
 * same deterministic sequence.
 */
export function spawnZombieAt(
  ctx: SimContext,
  def: ZombieDef,
  x: number,
  y: number,
  rng: Rng,
  hordeId?: string,
): ZombieState {
  const zombie: ZombieState = {
    id: ctx.ids.zombie(),
    defId: def.id,
    x,
    y,
    vx: 0,
    vy: 0,
    facing: rng.angle(),
    health: def.maxHealth,
    maxHealth: def.maxHealth,
    // Fresh spawns start idle rather than dormant: dormant is the AI system's own
    // far-LOD state, and claiming it here would suppress the first think.
    ai: 'idle',
    lod: 2,
    nextThinkTick: ctx.state.tick + rng.int(0, THINK_JITTER_TICKS),
    loseInterestTick: 0,
    attackReadyTick: ctx.state.tick,
    staggerUntilTick: 0,
    homeChunk: chunkKeyAtPixel(x, y),
    homeX: x,
    homeY: y,
    body: createBody(def.bodyScale),
    crawling: false,
    path: [],
    pathIndex: 0,
    pathTick: 0,
    rev: 1,
  };
  if (hordeId) zombie.hordeId = hordeId;

  ctx.state.zombies[zombie.id] = zombie;
  markDirtyAt(ctx.state, x, y);
  ctx.events.emit({ type: 'zombieSpawned', zombieId: zombie.id, defId: def.id, x, y });
  return zombie;
}

/** Create, register and announce an animal. */
export function spawnAnimalAt(
  ctx: SimContext,
  def: AnimalDef,
  x: number,
  y: number,
  rng: Rng,
): AnimalState {
  const animal: AnimalState = {
    id: ctx.ids.animal(),
    defId: def.id,
    x,
    y,
    vx: 0,
    vy: 0,
    facing: rng.angle(),
    health: def.maxHealth,
    maxHealth: def.maxHealth,
    ai: 'idle',
    lod: 2,
    nextThinkTick: ctx.state.tick + rng.int(0, THINK_JITTER_TICKS),
    fleeUntilTick: 0,
    attackReadyTick: ctx.state.tick,
    homeChunk: chunkKeyAtPixel(x, y),
    homeX: x,
    homeY: y,
    // Wander anchor starts on the spawn point so an animal nobody has disturbed grazes
    // where it was generated instead of drifting off across the map.
    wanderX: x,
    wanderY: y,
    rev: 1,
  };

  ctx.state.animals[animal.id] = animal;
  markDirtyAt(ctx.state, x, y);
  ctx.events.emit({ type: 'animalSpawned', animalId: animal.id, defId: def.id, x, y });
  return animal;
}
