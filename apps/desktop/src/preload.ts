import { contextBridge, ipcRenderer } from 'electron';
import {
  DesktopChannel,
  type AppInfo,
  type DesktopBridge,
  type LocalConnection,
  type ServerStatusInfo,
  type StartSinglePlayerRequest,
  type WorldListEntry,
} from './ipc';

/**
 * The only bridge between the renderer and the OS.
 *
 * Context isolation stays on and `nodeIntegration` stays off: the renderer runs the
 * Phaser client and untrusted-ish content, and gets exactly the handful of calls listed
 * here. Nothing about the game is decided on this side.
 */
const bridge: DesktopBridge = {
  startSinglePlayer: (request: StartSinglePlayerRequest) =>
    ipcRenderer.invoke(DesktopChannel.StartSinglePlayer, request) as Promise<LocalConnection>,
  stopServer: () => ipcRenderer.invoke(DesktopChannel.StopServer) as Promise<void>,
  serverStatus: () => ipcRenderer.invoke(DesktopChannel.ServerStatus) as Promise<ServerStatusInfo>,
  listWorlds: () => ipcRenderer.invoke(DesktopChannel.ListWorlds) as Promise<WorldListEntry[]>,
  deleteWorld: (name: string) =>
    ipcRenderer.invoke(DesktopChannel.DeleteWorld, name) as Promise<void>,
  appInfo: () => ipcRenderer.invoke(DesktopChannel.AppInfo) as Promise<AppInfo>,
  quit: () => ipcRenderer.invoke(DesktopChannel.Quit) as Promise<void>,
  toggleFullscreen: () => ipcRenderer.invoke(DesktopChannel.ToggleFullscreen) as Promise<boolean>,
  onServerLog: (listener) => {
    const handler = (_event: unknown, line: string, stream: 'out' | 'err') =>
      listener(line, stream);
    ipcRenderer.on(DesktopChannel.ServerLog, handler);
    return () => ipcRenderer.removeListener(DesktopChannel.ServerLog, handler);
  },
  onServerExit: (listener) => {
    const handler = (_event: unknown, info: { code: number | null }) => listener(info);
    ipcRenderer.on(DesktopChannel.ServerExit, handler);
    return () => ipcRenderer.removeListener(DesktopChannel.ServerExit, handler);
  },
};

contextBridge.exposeInMainWorld('survive', bridge);
