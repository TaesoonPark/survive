/**
 * `@survive/netcode` - the client half of the network.
 *
 * Four pieces, each usable on its own:
 *
 * - {@link connectToServer} opens a Colyseus room and turns the protocol's messages
 *   into typed callbacks (including the 0.17-server/0.16-client seat reservation
 *   fix-up described in AGENTS.md).
 * - {@link InputPredictor} predicts local movement and reconciles it against the
 *   authoritative state.
 * - {@link EntityInterpolator} smooths remote entities between snapshots.
 * - {@link SnapshotStore} mirrors the authoritative world for the renderer.
 * - {@link ClientClock} estimates the server's tick from the handshake and pongs.
 *
 * No Phaser, no DOM: a headless bot client imports exactly the same code as the game.
 */
export {
  connectToServer,
  requestSeatReservation,
  nestSeatReservation,
  parseFlatSeatReservation,
  isJoinErrorCode,
  toHttpUrl,
  JoinRejectedError,
} from './connection';
export type {
  ConnectOptions,
  FetchLike,
  FetchLikeResponse,
  FlatSeatReservation,
  MatchmakeMethod,
  NestedSeatReservation,
  RoomLike,
  SeatConsumingClient,
  SeatReservationRequest,
  ServerConnection,
} from './connection';

export { ClientClock, defaultTimeSource } from './clientClock';
export type { ClientClockOptions } from './clientClock';

export { InputPredictor, DEFAULT_RECONCILE_EPSILON } from './predictor';
export type {
  InputIntent,
  InputPredictorOptions,
  PredictedState,
  ReconcileResult,
  ReplayStep,
} from './predictor';

export { EntityInterpolator, snapshotTransform } from './interpolator';
export type { EntityInterpolatorOptions, Transform } from './interpolator';

export { SnapshotStore } from './snapshotStore';
export type { SnapshotStoreListener } from './snapshotStore';
