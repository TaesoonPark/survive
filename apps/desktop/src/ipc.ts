/**
 * The renderer <-> main contract.
 *
 * Kept in its own file so the preload bridge and the main-process handlers cannot
 * drift apart, and so the client app can import the types without importing Electron.
 */

export const DesktopChannel = {
  StartSinglePlayer: 'survive:startSinglePlayer',
  StopServer: 'survive:stopServer',
  ServerStatus: 'survive:serverStatus',
  ListWorlds: 'survive:listWorlds',
  DeleteWorld: 'survive:deleteWorld',
  ServerLog: 'survive:serverLog',
  ServerExit: 'survive:serverExit',
  AppInfo: 'survive:appInfo',
  Quit: 'survive:quit',
  ToggleFullscreen: 'survive:toggleFullscreen',
} as const;

/** Where a client should connect, once a local server is up. */
export interface LocalConnection {
  /** Base URL for Colyseus matchmaking, e.g. `http://127.0.0.1:54321`. */
  url: string;
  room: string;
  /** One-shot token the server requires from the local client. */
  token: string;
  world: string;
  port: number;
}

export interface WorldListEntry {
  name: string;
  seed: number;
  day: number;
  savedAtMs: number;
  playerCount: number;
  sizeBytes: number;
}

export interface StartSinglePlayerRequest {
  /** World folder name. Created if it does not exist. */
  world: string;
  /** Seed for a brand-new world. Ignored when the world already exists. */
  seed?: number;
}

export interface AppInfo {
  version: string;
  platform: string;
  saveDir: string;
  isPackaged: boolean;
}

export interface ServerStatusInfo {
  running: boolean;
  connection: LocalConnection | null;
  pid: number | undefined;
}

/** The API the preload script exposes on `window.survive`. */
export interface DesktopBridge {
  startSinglePlayer(request: StartSinglePlayerRequest): Promise<LocalConnection>;
  stopServer(): Promise<void>;
  serverStatus(): Promise<ServerStatusInfo>;
  listWorlds(): Promise<WorldListEntry[]>;
  deleteWorld(name: string): Promise<void>;
  appInfo(): Promise<AppInfo>;
  quit(): Promise<void>;
  toggleFullscreen(): Promise<boolean>;
  /** Subscribe to server stdout/stderr. Returns an unsubscribe function. */
  onServerLog(listener: (line: string, stream: 'out' | 'err') => void): () => void;
  /** Subscribe to the server process exiting unexpectedly. */
  onServerExit(listener: (info: { code: number | null }) => void): () => void;
}

declare global {
  interface Window {
    /** Present only in the Electron build; the browser build leaves it undefined. */
    survive?: DesktopBridge;
  }
}
