import type Phaser from 'phaser';
import type { SimEvent } from '@survive/protocol';
import { TextureKey } from '../art/textures';
import { UI, cssColor } from '../art/palette';
import { EntityDepth } from './entityRenderer';

/**
 * Visual and audible feedback.
 *
 * Driven entirely by the simulation's event stream, never by diffing state: the server
 * already says "this took 14 slashing damage to the left arm", and reconstructing that
 * from two snapshots would be both harder and wrong. Nothing here is load-bearing - a
 * client that drops every event still ends up in the right state, it just looks flat.
 */

export interface FloatingText {
  text: Phaser.GameObjects.Text;
  life: number;
}

export class EffectsRenderer {
  private readonly floaters: FloatingText[] = [];
  private readonly toasts: string[] = [];
  private hitFlash: Phaser.GameObjects.Rectangle | null = null;
  private hitFlashLife = 0;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly selfId: () => string | null,
  ) {}

  /** Handle one tick's worth of events. */
  handle(events: readonly SimEvent[]): void {
    for (const event of events) this.handleOne(event);
  }

  private handleOne(event: SimEvent): void {
    switch (event.type) {
      case 'damage': {
        const isSelf = event.targetId === this.selfId();
        this.floatingNumber(
          event.x,
          event.y,
          `${Math.round(event.amount)}`,
          event.critical ? UI.warn : isSelf ? UI.danger : UI.text,
          event.critical ? 15 : 12,
        );
        this.burst(event.x, event.y, TextureKey.bloodPuff, event.critical ? 1.4 : 0.9, 240);
        if (isSelf) this.flashScreen(UI.danger, 0.22);
        break;
      }
      case 'heal':
        this.floatingNumber(0, 0, '', UI.accent, 12);
        break;
      case 'death':
        this.burst(event.x, event.y, TextureKey.bloodPuff, 2, 500);
        break;
      case 'attackSwing':
        if (event.hit) this.spark(event.x, event.y, event.angle);
        break;
      case 'projectileFired':
        this.burst(event.x, event.y, TextureKey.muzzle, 0.7, 110);
        break;
      case 'projectileHit':
        this.burst(event.x, event.y, TextureKey.dust, 0.8, 200);
        break;
      case 'structureDamaged':
      case 'nodeHarvested':
        // Positionless in the payload; the entity renderer already shows the health bar.
        break;
      case 'lightning':
        this.flashScreen(0xffffff, 0.5);
        break;
      case 'levelUp':
        this.toast(`${event.skill} level ${event.level}`);
        break;
      case 'notification':
        this.toast(event.text);
        break;
      case 'craftCompleted':
        this.toast(`crafted ${event.output.defId.replace(/_/g, ' ')}`);
        break;
      case 'buildRejected':
      case 'craftFailed':
        this.toast(event.reason);
        break;
      case 'commandRejected':
        this.toast(event.reason);
        break;
      case 'cropHarvested':
        this.toast('harvested');
        break;
      case 'itemPickedUp':
        if (event.playerId === this.selfId()) {
          this.toast(`+${event.stack.count} ${event.stack.defId.replace(/_/g, ' ')}`);
        }
        break;
      default:
        break;
    }
  }

  /** A damage number that rises and fades. */
  floatingNumber(x: number, y: number, label: string, color: number, size: number): void {
    if (!label) return;
    const text = this.scene.add
      .text(x, y - 12, label, {
        fontFamily: 'monospace',
        fontSize: `${size}px`,
        color: cssColor(color),
        stroke: '#000000',
        strokeThickness: 3,
      })
      .setOrigin(0.5, 1)
      .setDepth(EntityDepth.overlay);
    this.floaters.push({ text, life: 800 });
  }

  private burst(x: number, y: number, textureKey: string, scale: number, durationMs: number): void {
    if (!this.scene.textures.exists(textureKey)) return;
    const sprite = this.scene.add
      .sprite(x, y, textureKey)
      .setDepth(EntityDepth.overlay - 2)
      .setScale(scale * 0.5)
      .setAlpha(0.9);
    this.scene.tweens.add({
      targets: sprite,
      scale: scale,
      alpha: 0,
      duration: durationMs,
      onComplete: () => sprite.destroy(),
    });
  }

  private spark(x: number, y: number, angle: number): void {
    if (!this.scene.textures.exists(TextureKey.spark)) return;
    for (let i = 0; i < 4; i++) {
      const spread = (i - 1.5) * 0.22;
      const sprite = this.scene.add
        .sprite(x, y, TextureKey.spark)
        .setDepth(EntityDepth.overlay - 3);
      this.scene.tweens.add({
        targets: sprite,
        x: x + Math.cos(angle + spread) * 22,
        y: y + Math.sin(angle + spread) * 22,
        alpha: 0,
        duration: 180,
        onComplete: () => sprite.destroy(),
      });
    }
  }

  /** A full-screen tint, for taking a hit or a lightning strike. */
  flashScreen(color: number, alpha: number): void {
    const camera = this.scene.cameras.main;
    if (!this.hitFlash) {
      this.hitFlash = this.scene.add
        .rectangle(0, 0, camera.width, camera.height, color, alpha)
        .setOrigin(0, 0)
        .setScrollFactor(0)
        .setDepth(EntityDepth.overlay + 50);
    }
    this.hitFlash.setFillStyle(color, alpha);
    this.hitFlash.setSize(camera.width, camera.height);
    this.hitFlash.setVisible(true);
    this.hitFlashLife = 180;
  }

  /** Queue a short message for the HUD to display. */
  toast(text: string): void {
    this.toasts.push(text);
    // The HUD only shows a handful; drop the oldest rather than growing without bound.
    if (this.toasts.length > 16) this.toasts.shift();
  }

  /** Take the queued toasts, for the HUD to render. */
  drainToasts(): string[] {
    if (this.toasts.length === 0) return [];
    return this.toasts.splice(0, this.toasts.length);
  }

  update(deltaMs: number): void {
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const floater = this.floaters[i];
      if (!floater) continue;
      floater.life -= deltaMs;
      floater.text.y -= deltaMs * 0.028;
      floater.text.setAlpha(Math.max(0, floater.life / 800));
      if (floater.life <= 0) {
        floater.text.destroy();
        this.floaters.splice(i, 1);
      }
    }

    if (this.hitFlash && this.hitFlashLife > 0) {
      this.hitFlashLife -= deltaMs;
      this.hitFlash.setAlpha(Math.max(0, (this.hitFlashLife / 180) * 0.25));
      if (this.hitFlashLife <= 0) this.hitFlash.setVisible(false);
    }
  }

  destroy(): void {
    for (const floater of this.floaters) floater.text.destroy();
    this.floaters.length = 0;
    this.hitFlash?.destroy();
    this.hitFlash = null;
  }
}
