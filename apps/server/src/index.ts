/**
 * `@survive/server` - the GameServer.
 *
 * One binary serves both modes: single-player runs it as a child process bound to
 * loopback, a dedicated host runs it directly (spec sections 9-11). The pieces are
 * exported individually so integration tests can use the headless
 * {@link GameServer} with no sockets at all, or {@link listen} for a real one.
 */
export { GameServer } from './game/gameServer';
export type { GameServerOptions, JoinResult, ServerStats } from './game/gameServer';
export { bootstrap, createStore } from './game/bootstrap';
export type { BootstrapResult } from './game/bootstrap';
export { AoiTracker } from './net/aoi';
export type { AoiOptions, ChunkDelta } from './net/aoi';
export { GameRoom } from './net/room';
export type { GameRoomContext } from './net/room';
export { JoinGate, joinGate, sanitizeName, sanitizePlayerId, CLAIM_TTL_MS } from './net/joinGate';
export type { JoinDecision } from './net/joinGate';
export { listen } from './net/listen';
export type { ListenOptions, ListeningServer } from './net/listen';
export { startStatusServer } from './net/status';
export type { StatusServer, StatusServerOptions } from './net/status';
export { parseArgs, usage, seedFromName } from './config/args';
export type { ParsedArgs, RuntimeOptions, StorageBackend } from './config/args';
