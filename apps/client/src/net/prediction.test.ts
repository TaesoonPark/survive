import { describe, expect, it } from 'vitest';
import { CHUNK_TILES, Tile, defaultWorldGenConfig, tileProps } from '@survive/protocol';
import { createGameData } from '@survive/game-data';
import { createCollisionGrid, createWorld } from '@survive/world';
import { SnapshotStore } from '@survive/netcode';
import { PredictionWorld } from './session';

/**
 * The client's prediction world has to answer like the server's, tile for tile.
 *
 * Prediction converges only because both sides run the *same* movement function over the
 * *same* world. The movement function is genuinely shared (`stepMovement` out of
 * `@survive/simulation`), but the world is not: the client reconstructs one from replicated
 * chunks. Any disagreement there is a per-tick error, and a per-tick error is a per-tick
 * correction - the player creeping backwards on every snapshot, which reads as latency and
 * is not.
 *
 * That happened. The client carried a hand-copied speed table ("mirrors TILE_PROPS without
 * importing it all") that was missing FarmlandDry, FarmlandWet and Ice, so it predicted
 * full speed on farmland where the server applied 0.95 - five percent ahead, every tick,
 * for as long as you walked on your own farm. The table is gone; this holds the rest of the
 * surface to the same standard.
 */
describe('the prediction world agrees with the authoritative one', () => {
  function clientWorldSeededWith(tile: number): PredictionWorld {
    const store = new SnapshotStore();
    const tiles = new Array<number>(CHUNK_TILES * CHUNK_TILES).fill(tile);
    store.applyChunk({
      key: '0,0',
      cx: 0,
      cy: 0,
      tiles,
      biomes: new Array<number>(CHUNK_TILES * CHUNK_TILES).fill(0),
      version: 1,
    });
    return new PredictionWorld(store, createGameData());
  }

  /** Centre of the one non-solid tile in the world built by `clientWorldSeededWithHole`. */
  const HOLE_TILE_X = 5;
  const HOLE_X = HOLE_TILE_X * 32 + 16;
  const HOLE_Y = 5 * 32 + 16;

  /** `tile` everywhere except one guaranteed-open tile to stand in and step out of. */
  function clientWorldSeededWithHole(tile: number): PredictionWorld {
    const store = new SnapshotStore();
    const tiles = new Array<number>(CHUNK_TILES * CHUNK_TILES).fill(tile);
    tiles[5 * CHUNK_TILES + HOLE_TILE_X] = Tile.Dirt;
    store.applyChunk({
      key: '0,0',
      cx: 0,
      cy: 0,
      tiles,
      biomes: new Array<number>(CHUNK_TILES * CHUNK_TILES).fill(0),
      version: 1,
    });
    return new PredictionWorld(store, createGameData());
  }

  const TILE_IDS: number[] = Object.values(Tile).filter((id) => typeof id === 'number') as number[];

  it('covers every tile the game defines, so this is not a spot check', () => {
    expect(TILE_IDS.length).toBeGreaterThan(20);
  });

  it.each(TILE_IDS.map((id) => [id] as const))(
    'reports the authoritative speed and solidity for tile %i',
    (id) => {
      const client = clientWorldSeededWith(id);
      // Somewhere inside chunk 0,0, away from its edges.
      const x = 5 * 32 + 16;
      const y = 5 * 32 + 16;
      expect(client.speedAt(x, y)).toBe(tileProps(id).speed);
      // Solidity through the public surface: approached from outside, a step into the
      // tile is blocked exactly when the tile is solid.
      //
      // Probed from *outside* deliberately. Starting on the tile no longer reports it as
      // blocking, because a body already embedded in geometry is handed free movement
      // until it is clear - otherwise a wall built on top of someone would strand them
      // for good. The server has always done that; the client only recently started to,
      // and this probe used to rely on it not doing so.
      const client2 = clientWorldSeededWithHole(id);
      const moved = client2.moveCircle(HOLE_X, HOLE_Y, 12, 0, 11);
      expect(moved.blockedX, `solidity for tile ${id}`).toBe(tileProps(id).solid);
    },
  );

  it('matches the real world service tile for tile', () => {
    // Belt to the braces above: compare against `createWorld` itself rather than against
    // the same table the client now reads.
    const config = defaultWorldGenConfig();
    config.seed = 4242;
    const server = createWorld(config);
    for (const id of TILE_IDS) {
      const client = clientWorldSeededWith(id);
      server.setTile(5, 5, id);
      const x = 5 * 32 + 16;
      const y = 5 * 32 + 16;
      expect(client.speedAt(x, y), `speed for tile ${id}`).toBe(server.speedAt(x, y));
    }
  });
});

/**
 * The client resolves movement with the server's own sweep, so it has to land in exactly
 * the same place - not merely a similar one.
 *
 * The three implementations that need to agree are the authoritative grid, this client
 * prediction, and the flat-world test double. All three used to carry their own
 * transcription of the sweep loop and all three had drifted; these cases are the ones where
 * the client's copy actually differed, measured before the loop was shared.
 */
describe('the prediction world resolves collisions like the authoritative one', () => {
  const R = 11;
  const WALL_TILE_X = 5;

  /** A client world with one solid column, matching the grid built below. */
  function clientWithWall(): PredictionWorld {
    const store = new SnapshotStore();
    const tiles = new Array<number>(CHUNK_TILES * CHUNK_TILES).fill(Tile.Grass);
    for (let ty = 0; ty < CHUNK_TILES; ty++) tiles[ty * CHUNK_TILES + WALL_TILE_X] = Tile.WallBrick;
    store.applyChunk({
      key: '0,0',
      cx: 0,
      cy: 0,
      tiles,
      biomes: new Array<number>(CHUNK_TILES * CHUNK_TILES).fill(0),
      version: 1,
    });
    return new PredictionWorld(store, createGameData());
  }

  function serverWithWall(): ReturnType<typeof createCollisionGrid> {
    const grid = createCollisionGrid();
    const tiles = new Uint16Array(CHUNK_TILES * CHUNK_TILES).fill(Tile.Grass);
    for (let ty = 0; ty < CHUNK_TILES; ty++) tiles[ty * CHUNK_TILES + WALL_TILE_X] = Tile.WallBrick;
    grid.seedChunk(0, 0, Array.from(tiles));
    return grid;
  }

  // Both sides must agree that Rock is what blocks here, or the comparison is vacuous.
  it('is set up so the wall actually blocks', () => {
    expect(tileProps(Tile.WallBrick).solid).toBe(true);
    expect(tileProps(Tile.Grass).solid).toBe(false);
  });

  const y = 10 * 32 + 16;

  // 5.25 px is a walking step, 9.3 px a run, and about 25 px is the heaviest knockback
  // taken at a run - the largest displacement the game can produce in one tick. Only the
  // last of these exceeded the half-tile sub-step threshold, which is why the divergence
  // never showed up in ordinary play.
  it.each([[5.25], [9.3], [16], [20], [25], [40], [64], [128]])(
    'lands in the same place for a %s px step into a wall',
    (span) => {
      const client = clientWithWall();
      const server = serverWithWall();
      for (let off = 0; off < 64; off++) {
        const x = WALL_TILE_X * 32 - 64 + off;
        const c = client.moveCircle(x, y, span, 0, R);
        const s = server.moveCircle(x, y, span, 0, R);
        expect({ off, x: c.x, blocked: c.blockedX }).toEqual({
          off,
          x: s.x,
          blocked: s.blockedX,
        });
      }
    },
  );

  it('slides along a corner identically on a diagonal', () => {
    const client = clientWithWall();
    const server = serverWithWall();
    for (const span of [5.25, 16, 25, 40]) {
      for (let off = 0; off < 64; off++) {
        const x = WALL_TILE_X * 32 - 64 + off;
        const c = client.moveCircle(x, y, span, span, R);
        const s = server.moveCircle(x, y, span, span, R);
        expect({ span, off, x: c.x, y: c.y }).toEqual({ span, off, x: s.x, y: s.y });
      }
    }
  });

  it('walks a body embedded in a wall back out, rather than freezing it', () => {
    const client = clientWithWall();
    const server = serverWithWall();
    // Standing in the middle of the wall tile: every candidate position overlaps, so
    // without the escape rule each step is rejected and the body never gets out. The
    // client predicted exactly that while the server walked clear at full speed - a
    // divergence that grows for as long as it lasts.
    let cx = WALL_TILE_X * 32 + 16;
    let sx = cx;
    for (let step = 0; step < 20; step++) {
      cx = client.moveCircle(cx, y, -5.25, 0, R).x;
      sx = server.moveCircle(sx, y, -5.25, 0, R).x;
    }
    expect(cx).toBe(sx);
    // One second of walking, actually travelled.
    expect(WALL_TILE_X * 32 + 16 - cx).toBeCloseTo(105, 5);
  });

  it('returns the body untouched for a non-finite delta instead of hanging', () => {
    const client = clientWithWall();
    const x = 2 * 32 + 16;
    for (const bad of [Infinity, -Infinity, NaN]) {
      expect(client.moveCircle(x, y, bad, 0, R)).toEqual({
        x,
        y,
        blockedX: false,
        blockedY: false,
      });
    }
  });
});
