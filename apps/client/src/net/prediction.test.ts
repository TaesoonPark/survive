import { describe, expect, it } from 'vitest';
import { CHUNK_TILES, Tile, defaultWorldGenConfig, tileProps } from '@survive/protocol';
import { createGameData } from '@survive/game-data';
import { createWorld } from '@survive/world';
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
      // Solidity through the public surface: a zero-length move is blocked exactly when
      // the tile under it is solid.
      const moved = client.moveCircle(x, y, 4, 0, 11);
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
