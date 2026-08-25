/**
 * Launcher <-> renderer contract.
 *
 * The launcher supervises a *separate* GameServer process (spec section 16): it never
 * hosts the simulation itself. Everything here is process control and telemetry.
 */

export const LauncherChannel = {
  Start: 'launcher:start',
  Stop: 'launcher:stop',
  Status: 'launcher:status',
  Metrics: 'launcher:metrics',
  Log: 'launcher:log',
  Exit: 'launcher:exit',
  ListWorlds: 'launcher:listWorlds',
  LoadSettings: 'launcher:loadSettings',
  SaveSettings: 'launcher:saveSettings',
  PickSaveDir: 'launcher:pickSaveDir',
  OpenSaveDir: 'launcher:openSaveDir',
} as const;

/** Everything the operator can configure before pressing START. */
export interface ServerSettings {
  serverName: string;
  port: number;
  maxPlayers: number;
  password: string;
  world: string;
  saveDir: string;
  pvp: boolean;
  pauseWhenEmpty: boolean;
  backend: 'fs' | 'sqlite';
  seed: number | null;
  zombieDensity: number;
  lootAbundance: number;
  needRate: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export function defaultSettings(saveDir: string): ServerSettings {
  return {
    serverName: 'My Server',
    port: 27500,
    maxPlayers: 16,
    password: '',
    world: 'server01',
    saveDir,
    pvp: true,
    pauseWhenEmpty: true,
    backend: 'fs',
    seed: null,
    zombieDensity: 1,
    lootAbundance: 1,
    needRate: 1,
    logLevel: 'info',
  };
}

export interface LauncherStatus {
  running: boolean;
  pid: number | undefined;
  port: number;
  statusPort: number;
  world: string;
  startedAtMs: number | null;
}

/** Live telemetry, polled from the server's own status endpoint. */
export interface ServerMetrics {
  reachable: boolean;
  players: number;
  maxPlayers: number;
  tick: number;
  day: number;
  hour: number;
  weather: string;
  loadedChunks: number;
  entities: number;
  droppedTicks: number;
  averageStepMs: number;
  /** Percentage of one core, derived from two consecutive CPU-time samples. */
  cpuPercent: number;
  rssBytes: number;
  uptimeMs: number;
}

export interface WorldEntry {
  name: string;
  day: number;
  savedAtMs: number;
  seed: number;
}

export interface LauncherBridge {
  start(settings: ServerSettings): Promise<LauncherStatus>;
  stop(): Promise<void>;
  status(): Promise<LauncherStatus>;
  metrics(): Promise<ServerMetrics>;
  listWorlds(saveDir: string): Promise<WorldEntry[]>;
  loadSettings(): Promise<ServerSettings>;
  saveSettings(settings: ServerSettings): Promise<void>;
  pickSaveDir(): Promise<string | null>;
  openSaveDir(saveDir: string): Promise<void>;
  onLog(listener: (line: string, stream: 'out' | 'err') => void): () => void;
  onExit(listener: (info: { code: number | null }) => void): () => void;
}

declare global {
  interface Window {
    launcher: LauncherBridge;
  }
}
