import type {
  Command,
  CommandOf,
  CommandType,
  InputFrame,
  PlayerId,
  PlayerState,
  Rng,
  SimulationClock,
  SimulationConfig,
} from '@survive/protocol';
import type { GameData } from '@survive/game-data';
import type { WorldService } from '@survive/world';
import type { EventSink } from './events';
import type { IdAllocator } from './ids';
import type { Logger } from './logger';
import type { SimulationState } from './state';
import type { SpatialIndex } from './spatial';

/**
 * Continuous input for the current tick, one frame per player.
 *
 * The input system drains exactly one frame per player per tick so the server
 * consumes input at the same rate the client produced it, which is what makes
 * client-side prediction reconcile cleanly (spec section 17).
 */
export interface CurrentInputs {
  get(playerId: PlayerId): InputFrame | undefined;
  set(playerId: PlayerId, frame: InputFrame): void;
  /** The frame consumed on the previous tick, for edge detection (press vs hold). */
  previous(playerId: PlayerId): InputFrame | undefined;
  clear(): void;
  remove(playerId: PlayerId): void;
}

/** Pending input frames received from the network, not yet consumed. */
export interface InputBuffer {
  push(playerId: PlayerId, frames: readonly InputFrame[]): void;
  /** Take the next frame in sequence order, or undefined when starved. */
  take(playerId: PlayerId): InputFrame | undefined;
  pendingCount(playerId: PlayerId): number;
  remove(playerId: PlayerId): void;
}

/**
 * Everything a system is given.
 *
 * Nothing here reaches the filesystem, the network or the wall clock: a system that
 * only touches `SimContext` is automatically headless-testable (spec section 34).
 */
export interface SimContext {
  readonly state: SimulationState;
  readonly clock: SimulationClock;
  /** Master RNG. Prefer `rng.fork('subsystem')` for anything order-sensitive. */
  readonly rng: Rng;
  readonly data: GameData;
  readonly world: WorldService;
  readonly config: SimulationConfig;
  readonly events: EventSink;
  readonly ids: IdAllocator;
  readonly log: Logger;
  /** Rebuilt at the start of every tick. */
  readonly spatial: SpatialIndex;
  readonly inputs: CurrentInputs;
}

/** Handles one command variant. Runs with the sending player already resolved. */
export type CommandHandler<T extends CommandType> = (
  ctx: SimContext,
  player: PlayerState,
  command: CommandOf<T>,
) => void;

/** Where systems register their command handlers during `init`. */
export interface CommandRouter {
  on<T extends CommandType>(type: T, handler: CommandHandler<T>): void;
}

/**
 * A slice of game rules.
 *
 * Systems are the only place gameplay logic lives. They are pure with respect to the
 * outside world: they read and mutate {@link SimulationState} and emit events, and
 * nothing else.
 */
export interface System {
  readonly id: string;
  /** Ascending execution order within a tick. See {@link SystemOrder}. */
  readonly order: number;
  /** One-time setup. Also the place to register command handlers. */
  init?(ctx: SimContext, router: CommandRouter): void;
  /** Runs once per fixed tick, in `order`. */
  update?(ctx: SimContext): void;
  /** A player connected and their state has been installed. */
  onPlayerJoin?(ctx: SimContext, player: PlayerState): void;
  /** A player is about to be removed from the world. */
  onPlayerLeave?(ctx: SimContext, player: PlayerState): void;
  /** A chunk's dynamic contents were just installed from persistence. */
  onChunkLoaded?(ctx: SimContext, chunkKey: string): void;
  /** A chunk is about to be unloaded and saved. */
  onChunkUnload?(ctx: SimContext, chunkKey: string): void;
}

/**
 * Canonical per-tick system order.
 *
 * The gaps leave room to slot new systems in without renumbering. The ordering is
 * load-bearing: input is consumed before movement, movement before combat (so a swing
 * uses the post-move position), AI after players, survival after everything that can
 * wound, and cleanup last.
 */
export const SystemOrder = {
  Time: 100,
  Command: 150,
  Input: 200,
  Movement: 300,
  Combat: 400,
  Projectile: 450,
  Ai: 500,
  Survival: 600,
  Crafting: 700,
  Farming: 750,
  Structure: 800,
  Items: 850,
  Spawn: 900,
  Chunk: 950,
  Cleanup: 1000,
} as const;

/** A command paired with the player who sent it. */
export interface PendingCommand {
  playerId: PlayerId;
  command: Command;
}
