/**
 * How the game scene is told where to connect.
 *
 * Mirrors the desktop shell's IPC payload so single-player and multiplayer arrive at the
 * game scene in exactly the same shape - the client genuinely cannot tell them apart
 * beyond the address it dials.
 */
export interface LocalConnection {
  /** Base HTTP URL for Colyseus matchmaking, e.g. `http://127.0.0.1:27500`. */
  url: string;
  room: string;
  /** One-shot token, for a locally spawned single-player server. */
  token: string;
  world: string;
  port: number;
}

export interface GameSceneData {
  connection: LocalConnection;
  name: string;
  password: string;
}
