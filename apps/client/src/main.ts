import Phaser from 'phaser';
import { BootScene } from './scenes/BootScene';
import { MenuScene } from './scenes/MenuScene';
import { GameScene } from './scenes/GameScene';
import { UiScene } from './scenes/UiScene';

/**
 * Client entry point.
 *
 * Phaser's job starts and ends here: rendering, input, audio and camera work. Not one
 * game rule lives in this app (Architecture Guard rules 1 and 2) - the authoritative
 * simulation runs in the server process, and everything on screen is a projection of the
 * state it sends.
 */

const bootOverlay = document.getElementById('boot');
const bootStatus = document.getElementById('boot-status');
const bootError = document.getElementById('boot-error');

export function setBootStatus(text: string): void {
  if (bootStatus) bootStatus.textContent = text;
}

export function showBootError(message: string): void {
  if (bootError) bootError.textContent = message;
  if (bootOverlay) bootOverlay.hidden = false;
}

export function hideBoot(): void {
  if (bootOverlay) bootOverlay.hidden = true;
}

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: '#07090a',
  // Pixel art at integer-ish zoom: smoothing would turn the procedural textures to mush.
  pixelArt: true,
  roundPixels: true,
  antialias: false,
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: '100%',
    height: '100%',
  },
  render: {
    powerPreference: 'high-performance',
  },
  // No Arcade or Matter physics: collision is the server's business, and the client
  // resolves its own prediction against the shared movement function instead.
  fps: {
    target: 60,
    forceSetTimeOut: false,
  },
  disableContextMenu: true,
  audio: {
    disableWebAudio: false,
  },
  scene: [BootScene, MenuScene, GameScene, UiScene],
};

const game = new Phaser.Game(config);

declare global {
  interface Window {
    /** The Phaser instance, for the console and for the Playwright gameplay suite. */
    game?: Phaser.Game;
  }
}

// Read-only in practice: the gameplay tests read the texture count and the content
// version off the registry, and having the instance to hand is what makes debugging a
// rendering problem in a packaged build possible at all.
window.game = game;

// Losing WebGL is recoverable in principle but not worth the complexity here; tell the
// player rather than leaving them looking at a frozen canvas.
game.canvas?.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  showBootError('The graphics context was lost. Reload the page to continue.');
});

window.addEventListener('error', (event) => {
  showBootError(`Unexpected error: ${event.message}`);
});
window.addEventListener('unhandledrejection', (event) => {
  showBootError(`Unexpected error: ${String(event.reason)}`);
});

export { game };
