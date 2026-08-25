import type { ClientVisibleConfig } from './config';
import type { Command, InputFrame } from './commands';
import type { ChunkPayload, EventBatch, WorldInfo, WorldSnapshot } from './snapshot';
import type { ChunkKey } from './state/ids';

/**
 * Wire message names and payloads.
 *
 * Transport-agnostic on purpose: Colyseus carries these today, an in-memory pipe
 * carries them in headless tests, and neither the simulation nor the renderer knows
 * the difference.
 */

/** Client -> server message names. */
export const ClientMessage = {
  /** Batched continuous input frames. */
  Inputs: 'in',
  /** A discrete intent. */
  Command: 'cmd',
  /** Latency probe. */
  Ping: 'ping',
  /** Ask for chunk terrain the client is missing. */
  RequestChunks: 'reqchunk',
} as const;

/** Server -> client message names. */
export const ServerMessage = {
  Welcome: 'hello',
  Snapshot: 'snap',
  Chunk: 'chunk',
  ChunkDrop: 'chunkdrop',
  Events: 'evt',
  Pong: 'pong',
  Kick: 'kick',
  Error: 'err',
} as const;

export interface InputsPayload {
  frames: InputFrame[];
}

export interface CommandPayload {
  command: Command;
}

export interface PingPayload {
  clientTimeMs: number;
}

export interface RequestChunksPayload {
  keys: ChunkKey[];
}

export interface WelcomePayload {
  protocolVersion: number;
  playerId: string;
  /** Server tick at the moment of the handshake. */
  tick: number;
  serverTimeMs: number;
  world: WorldInfo;
  config: ClientVisibleConfig;
  /** Hash of the loaded game-data tables. A mismatch means the client is stale. */
  dataVersion: string;
  /** Names of the other players currently online. */
  onlinePlayers: string[];
}

export type SnapshotPayload = WorldSnapshot;

export type ChunkPayloadMessage = ChunkPayload;

export interface ChunkDropPayload {
  keys: ChunkKey[];
}

export type EventsPayload = EventBatch;

export interface PongPayload {
  clientTimeMs: number;
  serverTimeMs: number;
  tick: number;
}

export interface KickPayload {
  reason: string;
}

export interface ErrorPayload {
  code: string;
  message: string;
}

/** Options a client sends when joining a room. */
export interface JoinOptions {
  protocolVersion: number;
  name: string;
  /** Stable player id, so a reconnect resumes the same character. */
  playerId?: string;
  /** Server password, when one is configured. */
  password?: string;
  /** Single-player one-shot token (spec section 13). */
  token?: string;
}

/** Reasons a join can be refused. Surfaced verbatim in the client UI. */
export const JoinError = {
  ProtocolMismatch: 'protocol_mismatch',
  BadPassword: 'bad_password',
  BadToken: 'bad_token',
  ServerFull: 'server_full',
  Banned: 'banned',
  NameTaken: 'name_taken',
  ShuttingDown: 'shutting_down',
} as const;

export type JoinErrorCode = (typeof JoinError)[keyof typeof JoinError];

/** Typed map from server message name to payload, for exhaustive client handlers. */
export interface ServerMessageMap {
  [ServerMessage.Welcome]: WelcomePayload;
  [ServerMessage.Snapshot]: SnapshotPayload;
  [ServerMessage.Chunk]: ChunkPayloadMessage;
  [ServerMessage.ChunkDrop]: ChunkDropPayload;
  [ServerMessage.Events]: EventsPayload;
  [ServerMessage.Pong]: PongPayload;
  [ServerMessage.Kick]: KickPayload;
  [ServerMessage.Error]: ErrorPayload;
}

/** Typed map from client message name to payload. */
export interface ClientMessageMap {
  [ClientMessage.Inputs]: InputsPayload;
  [ClientMessage.Command]: CommandPayload;
  [ClientMessage.Ping]: PingPayload;
  [ClientMessage.RequestChunks]: RequestChunksPayload;
}
