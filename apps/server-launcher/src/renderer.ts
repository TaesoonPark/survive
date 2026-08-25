import type { LauncherStatus, ServerMetrics, ServerSettings } from './ipc';

/**
 * Launcher UI.
 *
 * Plain DOM on purpose: an operator tool that has to start reliably is better served by
 * 200 lines of vanilla code than by a framework, and it keeps the launcher's bundle
 * independent of the game client entirely.
 */

const bridge = window.launcher;

const form = document.getElementById('settings') as HTMLFormElement;
const startButton = document.getElementById('start') as HTMLButtonElement;
const stopButton = document.getElementById('stop') as HTMLButtonElement;
const pickDirButton = document.getElementById('pick-dir') as HTMLButtonElement;
const openDirButton = document.getElementById('open-dir') as HTMLButtonElement;
const clearLogButton = document.getElementById('clear-log') as HTMLButtonElement;
const followCheckbox = document.getElementById('follow') as HTMLInputElement;
const stateLabel = document.getElementById('state') as HTMLElement;
const logView = document.getElementById('log') as HTMLElement;
const worldList = document.getElementById('worlds') as HTMLDataListElement;

const metricNodes = {
  players: document.getElementById('m-players') as HTMLElement,
  cpu: document.getElementById('m-cpu') as HTMLElement,
  ram: document.getElementById('m-ram') as HTMLElement,
  uptime: document.getElementById('m-uptime') as HTMLElement,
  time: document.getElementById('m-time') as HTMLElement,
  weather: document.getElementById('m-weather') as HTMLElement,
  chunks: document.getElementById('m-chunks') as HTMLElement,
  entities: document.getElementById('m-entities') as HTMLElement,
  tick: document.getElementById('m-tick') as HTMLElement,
  step: document.getElementById('m-step') as HTMLElement,
  dropped: document.getElementById('m-dropped') as HTMLElement,
  address: document.getElementById('m-address') as HTMLElement,
};

let status: LauncherStatus = {
  running: false,
  pid: undefined,
  port: 0,
  statusPort: 0,
  world: '',
  startedAtMs: null,
};

// ---------------------------------------------------------------------------
// Form <-> settings
// ---------------------------------------------------------------------------

function readForm(): ServerSettings {
  const data = new FormData(form);
  const text = (key: string) => String(data.get(key) ?? '').trim();
  const num = (key: string, fallback: number) => {
    const value = Number(data.get(key));
    return Number.isFinite(value) ? value : fallback;
  };
  const seedRaw = text('seed');
  return {
    serverName: text('serverName') || 'My Server',
    port: num('port', 27500),
    maxPlayers: num('maxPlayers', 16),
    password: text('password'),
    world: text('world') || 'server01',
    saveDir: text('saveDir'),
    pvp: data.get('pvp') === 'on',
    pauseWhenEmpty: data.get('pauseWhenEmpty') === 'on',
    backend: (text('backend') as ServerSettings['backend']) || 'fs',
    seed: seedRaw === '' ? null : Number(seedRaw),
    zombieDensity: num('zombieDensity', 1),
    lootAbundance: num('lootAbundance', 1),
    needRate: num('needRate', 1),
    logLevel: (text('logLevel') as ServerSettings['logLevel']) || 'info',
  };
}

function writeForm(settings: ServerSettings): void {
  for (const [key, value] of Object.entries(settings)) {
    const field = form.elements.namedItem(key);
    if (!field) continue;
    if (field instanceof HTMLInputElement && field.type === 'checkbox') {
      field.checked = Boolean(value);
    } else if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement) {
      field.value = value === null || value === undefined ? '' : String(value);
    }
  }
}

// ---------------------------------------------------------------------------
// Log panel
// ---------------------------------------------------------------------------

const MAX_LOG_LINES = 2000;

function appendLog(line: string, kind: 'out' | 'err' | 'sys'): void {
  const element = document.createElement('span');
  if (kind !== 'out') element.className = kind === 'err' ? 'err' : 'sys';
  element.textContent = `${line}\n`;
  logView.append(element);
  while (logView.childElementCount > MAX_LOG_LINES) logView.firstElementChild?.remove();
  if (followCheckbox.checked) logView.scrollTop = logView.scrollHeight;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '-';
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.round(mb)} MB`;
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '-';
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function setRunning(running: boolean, errored = false): void {
  startButton.disabled = running;
  stopButton.disabled = !running;
  for (const element of Array.from(form.elements)) {
    if (element === startButton || element === stopButton) continue;
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLButtonElement
    ) {
      element.disabled = running;
    }
  }
  openDirButton.disabled = false;
  stateLabel.textContent = errored ? 'Error' : running ? 'Running' : 'Stopped';
  stateLabel.className = `pill ${errored ? 'pill--error' : running ? 'pill--running' : 'pill--idle'}`;
}

function renderMetrics(metrics: ServerMetrics): void {
  if (!metrics.reachable) {
    metricNodes.players.textContent = status.running ? 'starting…' : '0 / 0';
    return;
  }
  metricNodes.players.textContent = `${metrics.players} / ${metrics.maxPlayers}`;
  metricNodes.cpu.textContent = `${metrics.cpuPercent.toFixed(0)}%`;
  metricNodes.ram.textContent = formatBytes(metrics.rssBytes);
  metricNodes.uptime.textContent = formatDuration(metrics.uptimeMs);
  metricNodes.time.textContent = `Day ${metrics.day}, ${String(metrics.hour).padStart(2, '0')}:00`;
  metricNodes.weather.textContent = metrics.weather;
  metricNodes.chunks.textContent = String(metrics.loadedChunks);
  metricNodes.entities.textContent = String(metrics.entities);
  metricNodes.tick.textContent = String(metrics.tick);
  metricNodes.step.textContent = `${metrics.averageStepMs.toFixed(2)} ms`;
  metricNodes.dropped.textContent = String(metrics.droppedTicks);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

async function refreshWorlds(): Promise<void> {
  const settings = readForm();
  if (!settings.saveDir) return;
  const worlds = await bridge.listWorlds(settings.saveDir);
  worldList.replaceChildren(
    ...worlds.map((world) => {
      const option = document.createElement('option');
      option.value = world.name;
      option.label = world.day > 0 ? `${world.name} — day ${world.day}` : world.name;
      return option;
    }),
  );
}

startButton.addEventListener('click', async () => {
  const settings = readForm();
  await bridge.saveSettings(settings);
  appendLog(`starting ${settings.serverName} on port ${settings.port}…`, 'sys');
  setRunning(true);
  try {
    status = await bridge.start(settings);
    metricNodes.address.textContent = `0.0.0.0:${status.port}`;
    appendLog(`server started (pid ${status.pid ?? '?'})`, 'sys');
  } catch (error) {
    appendLog(`failed to start: ${String(error)}`, 'err');
    setRunning(false, true);
  }
});

stopButton.addEventListener('click', async () => {
  appendLog('stopping server…', 'sys');
  stopButton.disabled = true;
  await bridge.stop();
});

pickDirButton.addEventListener('click', async () => {
  const picked = await bridge.pickSaveDir();
  if (!picked) return;
  const field = form.elements.namedItem('saveDir');
  if (field instanceof HTMLInputElement) field.value = picked;
  await refreshWorlds();
});

openDirButton.addEventListener('click', async () => {
  await bridge.openSaveDir(readForm().saveDir);
});

clearLogButton.addEventListener('click', () => logView.replaceChildren());

form.addEventListener('change', () => {
  void bridge.saveSettings(readForm());
});

bridge.onLog((line, stream) => appendLog(line, stream));

bridge.onExit((info) => {
  const clean = info.code === 0 || info.code === null;
  appendLog(`server exited (code ${String(info.code)})`, clean ? 'sys' : 'err');
  status = { ...status, running: false, pid: undefined };
  setRunning(false, !clean);
  metricNodes.address.textContent = '-';
});

async function poll(): Promise<void> {
  status = await bridge.status();
  setRunning(status.running);
  renderMetrics(await bridge.metrics());
}

async function boot(): Promise<void> {
  writeForm(await bridge.loadSettings());
  await refreshWorlds();
  await poll();
  // One second is responsive enough for an operator view and cheap for the server.
  setInterval(() => void poll(), 1000);
}

void boot();
