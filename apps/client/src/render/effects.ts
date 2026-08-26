import type Phaser from 'phaser';
import { SIM_HZ, type SimEvent } from '@survive/protocol';
import type { GameData } from '@survive/game-data';
import { UNARMED } from '@survive/simulation/systems/combat/weapons';
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

/** Name given to the swing-arc graphic, so a test can find exactly that object. */
export const MELEE_ARC_NAME = 'melee-arc';

/**
 * The sector a melee swing is tested against: radius, half-angle, and how long it lasts.
 *
 * Pulled out of the drawing so it can be checked against the weapon table directly. The
 * whole point of this marker is that it shows the *real* reach - `weapon.range` and
 * `weapon.arcDegrees` are the same two numbers `livingTargetsInArc` uses on the server - so
 * a shape that merely looks plausible would be worse than none at all: it would teach the
 * player a reach their weapon does not have.
 *
 * `weaponDefId` is absent when swinging bare-handed, hence the fallback to the simulation's
 * own `UNARMED` rather than a pair of numbers restated here. Returns null for anything that
 * is not a melee weapon.
 */
export function meleeArcShape(
  weaponDefId: string | undefined,
  data: GameData,
): { radius: number; halfAngle: number; swingMs: number } | null {
  const weapon = (weaponDefId ? data.items.get(weaponDefId)?.weapon : null) ?? UNARMED;
  if (weapon.kind !== 'melee') return null;
  // A zero-degree arc is a thrust, and the server widens it to 20 for the same reason: a
  // sector of no width cannot be hit and cannot be drawn.
  const degrees = weapon.arcDegrees > 0 ? weapon.arcDegrees : 20;
  return {
    radius: weapon.range,
    halfAngle: ((degrees / 2) * Math.PI) / 180,
    swingMs: Math.max(160, (weapon.attackTicks / SIM_HZ) * 1000),
  };
}

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
    private readonly data: GameData,
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
        // Only the local player's. Drawing every walker's swing as well would paint the
        // screen white in a horde, and the point of this one is to answer "where does my
        // weapon actually reach", which is a question about your own weapon.
        if (event.attackerId === this.selfId()) {
          this.swingArc(event.x, event.y, event.angle, event.weaponDefId);
        }
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

  /**
   * The reach and spread of a melee swing, drawn as it was actually tested.
   *
   * Radius and angle come from the weapon's own `range` and `arcDegrees` - the same two
   * numbers `livingTargetsInArc` uses - rather than from a shape chosen to look right, so
   * what is drawn is what would have been hit. A spear's narrow lunge and a club's wide
   * sweep look as different as they behave.
   *
   * Left at the position the swing was made from rather than following the player: it is a
   * record of where the swing landed, and a cone that trails after you says nothing.
   *
   * `weaponDefId` is absent when swinging bare-handed, which is why the fallback is the
   * simulation's own `UNARMED` rather than a pair of numbers copied over here.
   */
  private swingArc(x: number, y: number, angle: number, weaponDefId: string | undefined): void {
    const shape = meleeArcShape(weaponDefId, this.data);
    if (!shape) return;
    const { radius, halfAngle: half, swingMs } = shape;

    const arc = this.scene.add
      .graphics({ x, y })
      .setName(MELEE_ARC_NAME)
      .setDepth(EntityDepth.overlay - 6);
    arc.fillStyle(0xffffff, 0.3);
    arc.slice(0, 0, radius, angle - half, angle + half, false);
    arc.fillPath();
    // The outline carries the shape; the fill only tints what it encloses. Both edges are
    // drawn, not just the far arc, so a narrow thrust still reads as a wedge rather than as
    // a stray line floating in front of the player.
    arc.lineStyle(2, 0xffffff, 0.85);
    arc.beginPath();
    arc.moveTo(Math.cos(angle - half) * radius, Math.sin(angle - half) * radius);
    arc.arc(0, 0, radius, angle - half, angle + half, false);
    arc.lineTo(0, 0);
    arc.closePath();
    arc.strokePath();

    // Held at full strength for the first part of the swing, then faded. Fading from the
    // first frame means the shape is already half gone by the time the eye finds it - the
    // first attempt at this was drawn correctly and still read as "nothing happened".
    this.scene.tweens.add({
      targets: arc,
      alpha: 0,
      delay: swingMs * 0.35,
      duration: swingMs * 0.55,
      ease: 'Quad.easeOut',
      onComplete: () => arc.destroy(),
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
