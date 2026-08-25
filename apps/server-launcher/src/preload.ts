import { contextBridge, ipcRenderer } from 'electron';
import {
  LauncherChannel,
  type LauncherBridge,
  type LauncherStatus,
  type ServerMetrics,
  type ServerSettings,
  type WorldEntry,
} from './ipc';

const bridge: LauncherBridge = {
  start: (settings: ServerSettings) =>
    ipcRenderer.invoke(LauncherChannel.Start, settings) as Promise<LauncherStatus>,
  stop: () => ipcRenderer.invoke(LauncherChannel.Stop) as Promise<void>,
  status: () => ipcRenderer.invoke(LauncherChannel.Status) as Promise<LauncherStatus>,
  metrics: () => ipcRenderer.invoke(LauncherChannel.Metrics) as Promise<ServerMetrics>,
  listWorlds: (saveDir: string) =>
    ipcRenderer.invoke(LauncherChannel.ListWorlds, saveDir) as Promise<WorldEntry[]>,
  loadSettings: () => ipcRenderer.invoke(LauncherChannel.LoadSettings) as Promise<ServerSettings>,
  saveSettings: (settings: ServerSettings) =>
    ipcRenderer.invoke(LauncherChannel.SaveSettings, settings) as Promise<void>,
  pickSaveDir: () => ipcRenderer.invoke(LauncherChannel.PickSaveDir) as Promise<string | null>,
  openSaveDir: (saveDir: string) =>
    ipcRenderer.invoke(LauncherChannel.OpenSaveDir, saveDir) as Promise<void>,
  onLog: (listener) => {
    const handler = (_event: unknown, line: string, stream: 'out' | 'err') =>
      listener(line, stream);
    ipcRenderer.on(LauncherChannel.Log, handler);
    return () => ipcRenderer.removeListener(LauncherChannel.Log, handler);
  },
  onExit: (listener) => {
    const handler = (_event: unknown, info: { code: number | null }) => listener(info);
    ipcRenderer.on(LauncherChannel.Exit, handler);
    return () => ipcRenderer.removeListener(LauncherChannel.Exit, handler);
  },
};

contextBridge.exposeInMainWorld('launcher', bridge);
