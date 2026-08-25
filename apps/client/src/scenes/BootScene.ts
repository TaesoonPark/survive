import Phaser from 'phaser';
import { createGameData, type GameData } from '@survive/game-data';
import { generateAllTextures } from '../art/textures';
import { hideBoot, setBootStatus, showBootError } from '../main';

/**
 * Boot: build the content tables and every texture, then hand over to the menu.
 *
 * There are no art files to load, so this scene draws the entire atlas procedurally
 * (see `art/canvasArt.ts`). That takes tens of milliseconds, which is why it happens
 * behind the HTML loading overlay rather than mid-game.
 */
export class BootScene extends Phaser.Scene {
  static readonly KEY = 'Boot';

  constructor() {
    super(BootScene.KEY);
  }

  create(): void {
    setBootStatus('loading content…');
    let data: GameData;
    try {
      data = createGameData();
    } catch (error) {
      // A content validation failure is a developer error, and the message lists every
      // broken reference - surface it verbatim rather than hiding it.
      showBootError(`Game data failed to load:\n${String(error)}`);
      return;
    }

    setBootStatus('drawing textures…');
    const started = performance.now();
    let textureCount = 0;
    try {
      textureCount = generateAllTextures(this, data);
    } catch (error) {
      showBootError(`Texture generation failed:\n${String(error)}`);
      return;
    }
    const elapsed = Math.round(performance.now() - started);

    // Everything downstream reads the tables from the registry rather than rebuilding
    // them, so validation and hashing happen exactly once per session.
    this.registry.set('gameData', data);
    this.registry.set('dataVersion', data.version);
    this.registry.set('textureCount', textureCount);

    console.info(
      `[boot] ${textureCount} textures in ${elapsed}ms, content version ${data.version}`,
    );

    hideBoot();
    this.scene.start('Menu');
  }
}
