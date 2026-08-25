// src/renderer.ts
var bridge = window.launcher;
var form = document.getElementById("settings");
var startButton = document.getElementById("start");
var stopButton = document.getElementById("stop");
var pickDirButton = document.getElementById("pick-dir");
var openDirButton = document.getElementById("open-dir");
var clearLogButton = document.getElementById("clear-log");
var followCheckbox = document.getElementById("follow");
var stateLabel = document.getElementById("state");
var logView = document.getElementById("log");
var worldList = document.getElementById("worlds");
var metricNodes = {
  players: document.getElementById("m-players"),
  cpu: document.getElementById("m-cpu"),
  ram: document.getElementById("m-ram"),
  uptime: document.getElementById("m-uptime"),
  time: document.getElementById("m-time"),
  weather: document.getElementById("m-weather"),
  chunks: document.getElementById("m-chunks"),
  entities: document.getElementById("m-entities"),
  tick: document.getElementById("m-tick"),
  step: document.getElementById("m-step"),
  dropped: document.getElementById("m-dropped"),
  address: document.getElementById("m-address")
};
var status = {
  running: false,
  pid: void 0,
  port: 0,
  statusPort: 0,
  world: "",
  startedAtMs: null
};
function readForm() {
  const data = new FormData(form);
  const text = (key) => String(data.get(key) ?? "").trim();
  const num = (key, fallback) => {
    const value = Number(data.get(key));
    return Number.isFinite(value) ? value : fallback;
  };
  const seedRaw = text("seed");
  return {
    serverName: text("serverName") || "My Server",
    port: num("port", 27500),
    maxPlayers: num("maxPlayers", 16),
    password: text("password"),
    world: text("world") || "server01",
    saveDir: text("saveDir"),
    pvp: data.get("pvp") === "on",
    pauseWhenEmpty: data.get("pauseWhenEmpty") === "on",
    backend: text("backend") || "fs",
    seed: seedRaw === "" ? null : Number(seedRaw),
    zombieDensity: num("zombieDensity", 1),
    lootAbundance: num("lootAbundance", 1),
    needRate: num("needRate", 1),
    logLevel: text("logLevel") || "info"
  };
}
function writeForm(settings) {
  for (const [key, value] of Object.entries(settings)) {
    const field = form.elements.namedItem(key);
    if (!field) continue;
    if (field instanceof HTMLInputElement && field.type === "checkbox") {
      field.checked = Boolean(value);
    } else if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement) {
      field.value = value === null || value === void 0 ? "" : String(value);
    }
  }
}
var MAX_LOG_LINES = 2e3;
function appendLog(line, kind) {
  const element = document.createElement("span");
  if (kind !== "out") element.className = kind === "err" ? "err" : "sys";
  element.textContent = `${line}
`;
  logView.append(element);
  while (logView.childElementCount > MAX_LOG_LINES) logView.firstElementChild?.remove();
  if (followCheckbox.checked) logView.scrollTop = logView.scrollHeight;
}
function formatBytes(bytes) {
  if (bytes <= 0) return "-";
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.round(mb)} MB`;
}
function formatDuration(ms) {
  if (ms <= 0) return "-";
  const total = Math.floor(ms / 1e3);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total % 3600 / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
function setRunning(running, errored = false) {
  startButton.disabled = running;
  stopButton.disabled = !running;
  for (const element of Array.from(form.elements)) {
    if (element === startButton || element === stopButton) continue;
    if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLButtonElement) {
      element.disabled = running;
    }
  }
  openDirButton.disabled = false;
  stateLabel.textContent = errored ? "Error" : running ? "Running" : "Stopped";
  stateLabel.className = `pill ${errored ? "pill--error" : running ? "pill--running" : "pill--idle"}`;
}
function renderMetrics(metrics) {
  if (!metrics.reachable) {
    metricNodes.players.textContent = status.running ? "starting\u2026" : "0 / 0";
    return;
  }
  metricNodes.players.textContent = `${metrics.players} / ${metrics.maxPlayers}`;
  metricNodes.cpu.textContent = `${metrics.cpuPercent.toFixed(0)}%`;
  metricNodes.ram.textContent = formatBytes(metrics.rssBytes);
  metricNodes.uptime.textContent = formatDuration(metrics.uptimeMs);
  metricNodes.time.textContent = `Day ${metrics.day}, ${String(metrics.hour).padStart(2, "0")}:00`;
  metricNodes.weather.textContent = metrics.weather;
  metricNodes.chunks.textContent = String(metrics.loadedChunks);
  metricNodes.entities.textContent = String(metrics.entities);
  metricNodes.tick.textContent = String(metrics.tick);
  metricNodes.step.textContent = `${metrics.averageStepMs.toFixed(2)} ms`;
  metricNodes.dropped.textContent = String(metrics.droppedTicks);
}
async function refreshWorlds() {
  const settings = readForm();
  if (!settings.saveDir) return;
  const worlds = await bridge.listWorlds(settings.saveDir);
  worldList.replaceChildren(
    ...worlds.map((world) => {
      const option = document.createElement("option");
      option.value = world.name;
      option.label = world.day > 0 ? `${world.name} \u2014 day ${world.day}` : world.name;
      return option;
    })
  );
}
startButton.addEventListener("click", async () => {
  const settings = readForm();
  await bridge.saveSettings(settings);
  appendLog(`starting ${settings.serverName} on port ${settings.port}\u2026`, "sys");
  setRunning(true);
  try {
    status = await bridge.start(settings);
    metricNodes.address.textContent = `0.0.0.0:${status.port}`;
    appendLog(`server started (pid ${status.pid ?? "?"})`, "sys");
  } catch (error) {
    appendLog(`failed to start: ${String(error)}`, "err");
    setRunning(false, true);
  }
});
stopButton.addEventListener("click", async () => {
  appendLog("stopping server\u2026", "sys");
  stopButton.disabled = true;
  await bridge.stop();
});
pickDirButton.addEventListener("click", async () => {
  const picked = await bridge.pickSaveDir();
  if (!picked) return;
  const field = form.elements.namedItem("saveDir");
  if (field instanceof HTMLInputElement) field.value = picked;
  await refreshWorlds();
});
openDirButton.addEventListener("click", async () => {
  await bridge.openSaveDir(readForm().saveDir);
});
clearLogButton.addEventListener("click", () => logView.replaceChildren());
form.addEventListener("change", () => {
  void bridge.saveSettings(readForm());
});
bridge.onLog((line, stream) => appendLog(line, stream));
bridge.onExit((info) => {
  const clean = info.code === 0 || info.code === null;
  appendLog(`server exited (code ${String(info.code)})`, clean ? "sys" : "err");
  status = { ...status, running: false, pid: void 0 };
  setRunning(false, !clean);
  metricNodes.address.textContent = "-";
});
async function poll() {
  status = await bridge.status();
  setRunning(status.running);
  renderMetrics(await bridge.metrics());
}
async function boot() {
  writeForm(await bridge.loadSettings());
  await refreshWorlds();
  await poll();
  setInterval(() => void poll(), 1e3);
}
void boot();
//# sourceMappingURL=renderer.js.map
