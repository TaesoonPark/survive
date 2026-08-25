import { describe, expect, it } from 'vitest';
import { AOI_RADIUS, DEFAULT_PORT, SIM_HZ, SNAPSHOT_HZ } from '@survive/protocol';
import { parseArgs, seedFromName, usage } from './args';

describe('parseArgs defaults', () => {
  it('defaults to a dedicated server on the standard port', () => {
    const { config, runtime } = parseArgs([]);
    expect(config.mode.singlePlayer).toBe(false);
    expect(config.network.host).toBe('0.0.0.0');
    expect(config.network.port).toBe(DEFAULT_PORT);
    expect(config.saveName).toBe('server01');
    expect(config.mode.maxPlayers).toBe(16);
    expect(config.mode.pvp).toBe(true);
    expect(config.mode.cheatsEnabled).toBe(false);
    expect(config.simHz).toBe(SIM_HZ);
    expect(config.snapshotHz).toBe(SNAPSHOT_HZ);
    expect(config.network.aoiRadius).toBe(AOI_RADIUS);
    expect(runtime.backend).toBe('fs');
  });

  it('shapes single-player mode from one flag', () => {
    const { config } = parseArgs(['--mode', 'singleplayer']);
    expect(config.mode.singlePlayer).toBe(true);
    expect(config.mode.maxPlayers).toBe(1);
    expect(config.mode.pauseWhenClientPaused).toBe(true);
    expect(config.mode.pvp).toBe(false);
    expect(config.mode.cheatsEnabled).toBe(true);
    expect(config.network.host).toBe('127.0.0.1');
    // Port 0 lets the OS pick, which is what the desktop shell wants.
    expect(config.network.port).toBe(0);
    expect(config.saveName).toBe('world01');
  });

  it('accepts the spec example command lines verbatim', () => {
    const single = parseArgs([
      '--mode',
      'singleplayer',
      '--bind',
      '127.0.0.1',
      '--save',
      'world01',
    ]);
    expect(single.config.mode.singlePlayer).toBe(true);
    expect(single.config.saveName).toBe('world01');

    const dedicated = parseArgs([
      '--mode',
      'dedicated',
      '--bind',
      '0.0.0.0',
      '--port',
      '27500',
      '--save',
      'server01',
    ]);
    expect(dedicated.config.network.host).toBe('0.0.0.0');
    expect(dedicated.config.network.port).toBe(27500);

    const withPlayers = parseArgs(['--port', '27500', '--save', 'world01', '--maxPlayers', '16']);
    expect(withPlayers.config.mode.maxPlayers).toBe(16);
  });
});

describe('parseArgs safety rules', () => {
  it('refuses to expose a single-player server on a public interface', () => {
    const { config, warnings } = parseArgs(['--mode', 'singleplayer', '--bind', '0.0.0.0']);
    expect(config.network.host).toBe('127.0.0.1');
    expect(warnings.join(' ')).toMatch(/loopback/);
  });

  it('allows loopback aliases for single-player', () => {
    expect(parseArgs(['--mode', 'singleplayer', '--bind', 'localhost']).config.network.host).toBe(
      'localhost',
    );
    expect(parseArgs(['--mode', 'singleplayer', '--bind', '::1']).config.network.host).toBe('::1');
  });

  it('never lets the snapshot rate exceed the simulation rate', () => {
    const { config, warnings } = parseArgs(['--simHz', '10', '--snapshotHz', '60']);
    expect(config.snapshotHz).toBe(10);
    expect(warnings.join(' ')).toMatch(/snapshotHz/);
  });
});

describe('parseArgs syntax', () => {
  it('accepts --key=value as well as --key value', () => {
    expect(parseArgs(['--port=1234']).config.network.port).toBe(1234);
    expect(parseArgs(['--port', '1234']).config.network.port).toBe(1234);
  });

  it('skips a bare -- separator, as npm scripts insert one', () => {
    const { config, warnings } = parseArgs(['--', '--port', '9999']);
    expect(config.network.port).toBe(9999);
    expect(warnings).toEqual([]);
  });

  it('parses negative numbers rather than treating them as flags', () => {
    expect(parseArgs(['--itemDespawnTicks', '-1']).config.tuning.itemDespawnTicks).toBe(-1);
  });

  it('handles boolean switches and their negations', () => {
    expect(parseArgs(['--no-pvp']).config.mode.pvp).toBe(false);
    expect(parseArgs(['--mode', 'singleplayer', '--pvp']).config.mode.pvp).toBe(true);
    expect(parseArgs(['--no-pauseEmpty']).config.mode.pauseWhenEmpty).toBe(false);
    expect(parseArgs(['--pvp', 'false']).config.mode.pvp).toBe(false);
    expect(parseArgs(['--pvp', 'yes']).config.mode.pvp).toBe(true);
  });

  it('reports --help without doing any work', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
    expect(usage()).toMatch(/Survive GameServer/);
  });

  it('warns rather than throwing on a bad number', () => {
    const { config, warnings } = parseArgs(['--port', 'banana']);
    expect(config.network.port).toBe(DEFAULT_PORT);
    expect(warnings.join(' ')).toMatch(/not a number/);
  });

  it('warns rather than throwing on an unknown enum value', () => {
    const { config, warnings } = parseArgs(['--backend', 'postgres']);
    expect(config).toBeDefined();
    expect(warnings.join(' ')).toMatch(/backend/);
  });

  it('warns about stray positional arguments', () => {
    expect(parseArgs(['world01']).warnings.join(' ')).toMatch(/stray/);
  });

  it('clamps out-of-range values instead of accepting nonsense', () => {
    expect(parseArgs(['--maxPlayers', '0']).config.mode.maxPlayers).toBe(1);
    expect(parseArgs(['--maxPlayers', '9999']).config.mode.maxPlayers).toBe(256);
    expect(parseArgs(['--simHz', '1']).config.simHz).toBe(5);
    expect(parseArgs(['--infectionChance', '5']).config.tuning.infectionChance).toBe(1);
    expect(parseArgs(['--aoiRadius', '1']).config.network.aoiRadius).toBe(256);
  });
});

describe('parseArgs tuning and world generation', () => {
  it('threads every tuning knob through', () => {
    const { config } = parseArgs([
      '--needRate',
      '2',
      '--xpRate',
      '3',
      '--cropGrowthRate',
      '4',
      '--craftSpeed',
      '0.5',
      '--damageTaken',
      '1.5',
      '--damageDealt',
      '0.5',
      '--infectionChance',
      '0.75',
    ]);
    expect(config.tuning).toMatchObject({
      needRate: 2,
      xpRate: 3,
      cropGrowthRate: 4,
      craftSpeed: 0.5,
      playerDamageTaken: 1.5,
      playerDamageDealt: 0.5,
      infectionChance: 0.75,
    });
  });

  it('threads world generation knobs through', () => {
    const { config } = parseArgs([
      '--seed',
      '4242',
      '--urbanization',
      '0.5',
      '--zombieDensity',
      '2',
      '--animalDensity',
      '0.25',
      '--resourceDensity',
      '3',
      '--lootAbundance',
      '1.5',
    ]);
    expect(config.world).toMatchObject({
      seed: 4242,
      urbanization: 0.5,
      zombieDensity: 2,
      animalDensity: 0.25,
      resourceDensity: 3,
      lootAbundance: 1.5,
    });
  });

  it('derives a stable seed from the world name when none is given', () => {
    const a = parseArgs(['--save', 'greenfield']).config.world.seed;
    const b = parseArgs(['--save', 'greenfield']).config.world.seed;
    const c = parseArgs(['--save', 'blackwater']).config.world.seed;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toBe(seedFromName('greenfield'));
  });
});

describe('parseArgs runtime options', () => {
  it('reads the storage and logging options', () => {
    const { runtime } = parseArgs([
      '--saveDir',
      '/tmp/worlds',
      '--backend',
      'sqlite',
      '--reset',
      '--log',
      'debug',
      '--name',
      'My Server',
      '--statusPort',
      '27600',
      '--quiet',
      '--exitAfterTicks',
      '500',
    ]);
    expect(runtime).toMatchObject({
      saveDir: '/tmp/worlds',
      backend: 'sqlite',
      reset: true,
      logLevel: 'debug',
      serverName: 'My Server',
      statusPort: 27600,
      announceReady: false,
      exitAfterTicks: 500,
    });
  });

  it('names the world sensibly per mode by default', () => {
    expect(parseArgs([]).runtime.serverName).toBe('Survive Server');
    expect(parseArgs(['--mode', 'singleplayer']).runtime.serverName).toBe('Single Player');
  });
});
