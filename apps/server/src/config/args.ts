import {
  AOI_RADIUS,
  CHUNK_LOAD_RADIUS,
  DEFAULT_PORT,
  SIM_HZ,
  SNAPSHOT_HZ,
  defaultSurvivalTuning,
  defaultWorldGenConfig,
  type SimulationConfig,
} from '@survive/protocol';

/**
 * Command-line configuration.
 *
 * There is exactly one server binary. Single-player and dedicated hosting differ only
 * in the flags passed here (spec sections 11 and 12), which is what keeps the two
 * modes from drifting apart:
 *
 *   GameServer --mode singleplayer --bind 127.0.0.1 --save world01
 *   GameServer --mode dedicated --bind 0.0.0.0 --port 27500 --save server01
 */

export type StorageBackend = 'fs' | 'sqlite' | 'memory';
export type LogLevelArg = 'debug' | 'info' | 'warn' | 'error';

export interface RuntimeOptions {
  /** Directory that holds world folders. */
  saveDir: string;
  backend: StorageBackend;
  /** Delete the world before starting. Used by the e2e suite. */
  reset: boolean;
  logLevel: LogLevelArg;
  /** Human-readable server name, shown in the client's server list. */
  serverName: string;
  /** Extra port for the plain-HTTP status endpoint. 0 disables it. */
  statusPort: number;
  /** Print the machine-readable ready line on stdout. */
  announceReady: boolean;
  /** Exit after this many ticks. Used by profiling and smoke tests. */
  exitAfterTicks: number;
}

export interface ParsedArgs {
  config: SimulationConfig;
  runtime: RuntimeOptions;
  /** Set when `--help` was passed; the caller should print usage and exit. */
  help: boolean;
  /** Non-fatal complaints about the arguments, for logging. */
  warnings: string[];
}

const USAGE = `
Survive GameServer

Usage:
  survive-server [options]

Modes:
  --mode <singleplayer|dedicated>   Default: dedicated
                                    singleplayer implies --bind 127.0.0.1,
                                    --maxPlayers 1, pausing enabled, PvP off.

Network:
  --bind <host>                     Interface to bind. Default: mode-dependent
  --port <n>                        Port. 0 picks a free one. Default: ${DEFAULT_PORT}
  --password <secret>               Require a password to join
  --token <secret>                  Require a one-shot token (single-player)
  --maxPlayers <n>                  Player cap
  --aoiRadius <px>                  Replication radius. Default: ${AOI_RADIUS}
  --statusPort <n>                  Serve /health and /status on this port. 0 = off

World:
  --save <name>                     World folder name. Default: world01
  --saveDir <path>                  Where world folders live. Default: ./saves
  --backend <fs|sqlite|memory>      Storage backend. Default: fs
  --reset                           Delete the world before starting
  --seed <n>                        World seed for a new world
  --urbanization <0..1>             Town density
  --zombieDensity <n>               Zombie population multiplier
  --animalDensity <n>               Animal population multiplier
  --resourceDensity <n>             Resource node multiplier
  --lootAbundance <n>               Container loot multiplier

Rules:
  --pvp / --no-pvp                  Players can damage players
  --pauseEmpty / --no-pauseEmpty    Stop simulating with nobody connected
  --cheats                          Enable the debug command family
  --needRate <n>                    Hunger/thirst/fatigue rate multiplier
  --xpRate <n>                      Skill XP multiplier
  --cropGrowthRate <n>              Crop growth multiplier
  --craftSpeed <n>                  Crafting speed multiplier
  --infectionChance <0..1>          Chance a bite infects

Performance:
  --simHz <n>                       Simulation rate. Default: ${SIM_HZ}
  --snapshotHz <n>                  Snapshot rate. Default: ${SNAPSHOT_HZ}
  --chunkRadius <n>                 Chunks kept loaded around a player

Other:
  --name <text>                     Server name shown to clients
  --log <debug|info|warn|error>     Log level. Default: info
  --exitAfterTicks <n>              Run this many ticks then exit (profiling)
  --quiet                           Do not print the machine-readable ready line
  -h, --help                        This text
`.trimStart();

export function usage(): string {
  return USAGE;
}

/** Flags that take no value. */
const BOOLEAN_FLAGS = new Set([
  'reset',
  'cheats',
  'pvp',
  'no-pvp',
  'pauseEmpty',
  'no-pauseEmpty',
  'quiet',
  'help',
  'h',
]);

interface RawArgs {
  values: Map<string, string>;
  flags: Set<string>;
  warnings: string[];
}

/**
 * Tokenise argv.
 *
 * Accepts `--key value`, `--key=value` and bare boolean flags. A leading `--`
 * separator is skipped, so `npm run start:server -- --port 1234` works.
 */
function tokenise(argv: readonly string[]): RawArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const warnings: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token) continue;
    if (token === '--') continue;
    if (!token.startsWith('-')) {
      warnings.push(`ignoring stray argument: ${token}`);
      continue;
    }
    const bare = token.replace(/^--?/, '');
    const eq = bare.indexOf('=');
    if (eq >= 0) {
      values.set(bare.slice(0, eq), bare.slice(eq + 1));
      continue;
    }
    if (BOOLEAN_FLAGS.has(bare)) {
      // `--pvp` is a switch, but `--pvp false` should still work: consume the next
      // token only when it actually reads as a boolean.
      const next = argv[i + 1];
      if (next !== undefined && /^(true|false|yes|no|on|off|1|0)$/i.test(next)) {
        values.set(bare, next);
        i++;
      } else {
        flags.add(bare);
      }
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || (next.startsWith('-') && !/^-?\d/.test(next))) {
      warnings.push(`flag --${bare} expects a value; treating it as a switch`);
      flags.add(bare);
      continue;
    }
    values.set(bare, next);
    i++;
  }
  return { values, flags, warnings };
}

function readNumber(
  raw: RawArgs,
  key: string,
  fallback: number,
  { min, max, integer }: { min?: number; max?: number; integer?: boolean } = {},
): number {
  const text = raw.values.get(key);
  if (text === undefined) return fallback;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) {
    raw.warnings.push(`--${key} is not a number (${text}); using ${fallback}`);
    return fallback;
  }
  let value = integer ? Math.round(parsed) : parsed;
  if (min !== undefined && value < min) {
    raw.warnings.push(`--${key} clamped up to ${min}`);
    value = min;
  }
  if (max !== undefined && value > max) {
    raw.warnings.push(`--${key} clamped down to ${max}`);
    value = max;
  }
  return value;
}

function readString(raw: RawArgs, key: string, fallback: string): string {
  return raw.values.get(key) ?? fallback;
}

function readBool(raw: RawArgs, key: string, fallback: boolean): boolean {
  if (raw.flags.has(key)) return true;
  if (raw.flags.has(`no-${key}`)) return false;
  const text = raw.values.get(key);
  if (text === undefined) return fallback;
  if (/^(true|yes|1|on)$/i.test(text)) return true;
  if (/^(false|no|0|off)$/i.test(text)) return false;
  raw.warnings.push(`--${key} expects a boolean (${text}); using ${fallback}`);
  return fallback;
}

function readEnum<T extends string>(
  raw: RawArgs,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const text = raw.values.get(key);
  if (text === undefined) return fallback;
  if ((allowed as readonly string[]).includes(text)) return text as T;
  raw.warnings.push(
    `--${key} must be one of ${allowed.join('|')} (got ${text}); using ${fallback}`,
  );
  return fallback;
}

/** A world seed derived from the save name, so a named world is reproducible. */
export function seedFromName(name: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const raw = tokenise(argv);
  const help = raw.flags.has('help') || raw.flags.has('h');

  const mode = readEnum(raw, 'mode', ['singleplayer', 'dedicated'] as const, 'dedicated');
  const singlePlayer = mode === 'singleplayer';
  const saveName = readString(raw, 'save', singlePlayer ? 'world01' : 'server01');

  const tuning = defaultSurvivalTuning();
  tuning.needRate = readNumber(raw, 'needRate', tuning.needRate, { min: 0, max: 20 });
  tuning.xpRate = readNumber(raw, 'xpRate', tuning.xpRate, { min: 0, max: 100 });
  tuning.cropGrowthRate = readNumber(raw, 'cropGrowthRate', tuning.cropGrowthRate, {
    min: 0.01,
    max: 100,
  });
  tuning.craftSpeed = readNumber(raw, 'craftSpeed', tuning.craftSpeed, { min: 0.01, max: 100 });
  tuning.playerDamageTaken = readNumber(raw, 'damageTaken', tuning.playerDamageTaken, {
    min: 0,
    max: 20,
  });
  tuning.playerDamageDealt = readNumber(raw, 'damageDealt', tuning.playerDamageDealt, {
    min: 0,
    max: 20,
  });
  tuning.infectionChance = readNumber(raw, 'infectionChance', tuning.infectionChance, {
    min: 0,
    max: 1,
  });
  tuning.itemDespawnTicks = readNumber(raw, 'itemDespawnTicks', tuning.itemDespawnTicks, {
    min: -1,
    integer: true,
  });

  const world = defaultWorldGenConfig(seedFromName(saveName));
  world.seed = readNumber(raw, 'seed', world.seed, { integer: true });
  world.urbanization = readNumber(raw, 'urbanization', world.urbanization, { min: 0, max: 1 });
  world.zombieDensity = readNumber(raw, 'zombieDensity', world.zombieDensity, { min: 0, max: 20 });
  world.animalDensity = readNumber(raw, 'animalDensity', world.animalDensity, { min: 0, max: 20 });
  world.resourceDensity = readNumber(raw, 'resourceDensity', world.resourceDensity, {
    min: 0,
    max: 20,
  });
  world.lootAbundance = readNumber(raw, 'lootAbundance', world.lootAbundance, { min: 0, max: 20 });

  const requestedHost = readString(raw, 'bind', singlePlayer ? '127.0.0.1' : '0.0.0.0');
  // Rule from spec section 13: a single-player server never listens on a public
  // interface, whatever the flags say.
  let host = requestedHost;
  if (singlePlayer && host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    raw.warnings.push(`single-player servers only bind loopback; ignoring --bind ${requestedHost}`);
    host = '127.0.0.1';
  }

  const config: SimulationConfig = {
    mode: {
      singlePlayer,
      maxPlayers: readNumber(raw, 'maxPlayers', singlePlayer ? 1 : 16, {
        min: 1,
        max: 256,
        integer: true,
      }),
      pauseWhenClientPaused: readBool(raw, 'allowPause', singlePlayer),
      pauseWhenEmpty: readBool(raw, 'pauseEmpty', true),
      pvp: readBool(raw, 'pvp', !singlePlayer),
      cheatsEnabled: readBool(raw, 'cheats', singlePlayer),
    },
    network: {
      host,
      port: readNumber(raw, 'port', singlePlayer ? 0 : DEFAULT_PORT, {
        min: 0,
        max: 65535,
        integer: true,
      }),
      password: readString(raw, 'password', ''),
      token: readString(raw, 'token', ''),
      aoiRadius: readNumber(raw, 'aoiRadius', AOI_RADIUS, { min: 256, max: 8192 }),
    },
    world,
    tuning,
    simHz: readNumber(raw, 'simHz', SIM_HZ, { min: 5, max: 120, integer: true }),
    snapshotHz: readNumber(raw, 'snapshotHz', SNAPSHOT_HZ, { min: 1, max: 60, integer: true }),
    chunkLoadRadius: readNumber(raw, 'chunkRadius', CHUNK_LOAD_RADIUS, {
      min: 1,
      max: 8,
      integer: true,
    }),
    saveName,
  };

  if (config.snapshotHz > config.simHz) {
    raw.warnings.push('--snapshotHz cannot exceed --simHz; clamping');
    config.snapshotHz = config.simHz;
  }

  const runtime: RuntimeOptions = {
    saveDir: readString(raw, 'saveDir', './saves'),
    backend: readEnum(raw, 'backend', ['fs', 'sqlite', 'memory'] as const, 'fs'),
    reset: readBool(raw, 'reset', false),
    logLevel: readEnum(raw, 'log', ['debug', 'info', 'warn', 'error'] as const, 'info'),
    serverName: readString(raw, 'name', singlePlayer ? 'Single Player' : 'Survive Server'),
    statusPort: readNumber(raw, 'statusPort', 0, { min: 0, max: 65535, integer: true }),
    announceReady: !raw.flags.has('quiet'),
    exitAfterTicks: readNumber(raw, 'exitAfterTicks', 0, { min: 0, integer: true }),
  };

  return { config, runtime, help, warnings: raw.warnings };
}
