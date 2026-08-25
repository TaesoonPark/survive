import type Phaser from 'phaser';
import { TILE_SIZE, type EntitySnapshot } from '@survive/protocol';
import type { GameData } from '@survive/game-data';
import { TextureKey } from '../art/textures';
import { UI, cssColor } from '../art/palette';
import type { RenderEntity } from '../net/session';

/**
 * Entities.
 *
 * One pooled sprite per live entity id, created on first sight and destroyed when the
 * server says the entity is gone. Depth is derived from Y so a player walking behind a
 * tree is drawn behind it, which is the whole trick that makes a top-down scene read as
 * having a third dimension.
 */

interface EntityView {
  sprite: Phaser.GameObjects.Sprite;
  /** Health bar, created lazily: most entities never need one. */
  healthBar?: Phaser.GameObjects.Graphics;
  nameLabel?: Phaser.GameObjects.Text;
  /** Crop overlay for a farm plot. */
  overlay?: Phaser.GameObjects.Sprite;
  kind: EntitySnapshot['k'];
  lastTextureKey: string;
  /** Tick of the last update, so stale views can be swept. */
  seenAt: number;
}

/** Depth bands, so classes of thing layer predictably. */
const DEPTH = {
  ground: -50,
  node: 0,
  structureFloor: -40,
  structure: 0,
  item: -10,
  creature: 0,
  projectile: 500,
  overlay: 900,
} as const;

export class EntityRenderer {
  private readonly views = new Map<string, EntityView>();
  private frame = 0;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly data: GameData,
  ) {}

  get count(): number {
    return this.views.size;
  }

  /**
   * Reconcile the sprite pool against this frame's entity list.
   *
   * `removed` comes from the snapshot; anything else missing is simply out of the area of
   * interest and its view is swept below.
   */
  sync(entities: readonly RenderEntity[], removed: readonly string[]): void {
    this.frame++;
    for (const id of removed) this.destroyView(id);

    for (const entry of entities) {
      const view = this.ensureView(entry.snapshot);
      if (!view) continue;
      view.seenAt = this.frame;
      this.updateView(view, entry);
    }

    // Sweep anything the server stopped sending without an explicit removal.
    for (const [id, view] of this.views) {
      if (view.seenAt !== this.frame) this.destroyView(id);
    }
  }

  private textureFor(snapshot: EntitySnapshot): string | null {
    switch (snapshot.k) {
      case 'player':
        return TextureKey.playerRemote;
      case 'zombie':
        return TextureKey.zombie(snapshot.defId, snapshot.crawling);
      case 'animal':
        return TextureKey.animal(snapshot.defId);
      case 'item':
        return TextureKey.item(snapshot.stack.defId);
      case 'projectile':
        return TextureKey.projectile(snapshot.defId);
      case 'structure':
        return TextureKey.structure(snapshot.defId, snapshot.door?.open ?? false);
      case 'node':
        return TextureKey.node(snapshot.defId, snapshot.variant);
      default:
        return null;
    }
  }

  private depthFor(snapshot: EntitySnapshot, y: number): number {
    // Y-sorting inside a band: the further down the screen, the closer to the camera.
    const band = (() => {
      switch (snapshot.k) {
        case 'projectile':
          return DEPTH.projectile;
        case 'item':
          return DEPTH.item;
        case 'structure': {
          const def = this.data.structures.get(snapshot.defId);
          return def &&
            (def.category === 'floor' || def.category === 'foundation' || def.category === 'farm')
            ? DEPTH.structureFloor
            : DEPTH.structure;
        }
        default:
          return DEPTH.creature;
      }
    })();
    return band + y * 0.001;
  }

  private ensureView(snapshot: EntitySnapshot): EntityView | null {
    const existing = this.views.get(snapshot.id);
    const textureKey = this.textureFor(snapshot);
    if (!textureKey || !this.scene.textures.exists(textureKey)) return existing ?? null;

    if (existing) {
      if (existing.lastTextureKey !== textureKey) {
        existing.sprite.setTexture(textureKey);
        existing.lastTextureKey = textureKey;
      }
      return existing;
    }

    const sprite = this.scene.add.sprite(0, 0, textureKey);
    // Structures are anchored at their footprint's top-left; everything else is centred.
    sprite.setOrigin(snapshot.k === 'structure' ? 0 : 0.5, snapshot.k === 'structure' ? 0 : 0.5);
    const view: EntityView = {
      sprite,
      kind: snapshot.k,
      lastTextureKey: textureKey,
      seenAt: this.frame,
    };

    if (snapshot.k === 'player') {
      view.nameLabel = this.scene.add
        .text(0, 0, snapshot.name, {
          fontFamily: 'monospace',
          fontSize: '11px',
          color: cssColor(UI.text),
        })
        .setOrigin(0.5, 1)
        .setDepth(DEPTH.overlay);
    }

    this.views.set(snapshot.id, view);
    return view;
  }

  private updateView(view: EntityView, entry: RenderEntity): void {
    const { snapshot, x, y, facing } = entry;
    const sprite = view.sprite;

    if (snapshot.k === 'structure') {
      // Tile-anchored, and never rotated: the art already accounts for the footprint.
      sprite.setPosition(snapshot.tileX * TILE_SIZE, snapshot.tileY * TILE_SIZE);
      sprite.setRotation(0);
      sprite.setAlpha(snapshot.progress < 1 ? 0.45 : 1);
      this.syncCropOverlay(view, snapshot);
    } else {
      sprite.setPosition(x, y);
      if (snapshot.k === 'item') sprite.setRotation(0);
      else sprite.setRotation(facing);
    }
    sprite.setDepth(
      this.depthFor(snapshot, snapshot.k === 'structure' ? snapshot.tileY * TILE_SIZE : y),
    );

    if (view.nameLabel) {
      view.nameLabel.setPosition(x, y - 20);
      view.nameLabel.setVisible(true);
    }

    this.syncHealthBar(view, snapshot, x, y);
    this.syncTint(view, snapshot);
  }

  /**
   * Health bars, only when they tell the player something.
   *
   * A full-health zombie does not need one; a wounded one does. Structures show theirs
   * only when damaged, which keeps a finished base from looking like a spreadsheet.
   */
  private syncHealthBar(view: EntityView, snapshot: EntitySnapshot, x: number, y: number): void {
    const health = 'health' in snapshot ? snapshot.health : null;
    const maxHealth = 'maxHealth' in snapshot ? snapshot.maxHealth : null;
    const show =
      health !== null && maxHealth !== null && maxHealth > 0 && health < maxHealth && health > 0;

    if (!show) {
      view.healthBar?.destroy();
      delete view.healthBar;
      return;
    }

    const bar = view.healthBar ?? this.scene.add.graphics().setDepth(DEPTH.overlay - 1);
    view.healthBar = bar;
    const fraction = Math.max(0, Math.min(1, (health as number) / (maxHealth as number)));
    const width = 24;
    const barX =
      (snapshot.k === 'structure' ? snapshot.tileX * TILE_SIZE + TILE_SIZE / 2 : x) - width / 2;
    const barY = (snapshot.k === 'structure' ? snapshot.tileY * TILE_SIZE : y) - 18;

    bar.clear();
    bar.fillStyle(0x000000, 0.55);
    bar.fillRect(barX - 1, barY - 1, width + 2, 4);
    bar.fillStyle(fraction > 0.5 ? UI.accent : fraction > 0.25 ? UI.warn : UI.danger, 1);
    bar.fillRect(barX, barY, width * fraction, 2);
  }

  /** A farm plot's crop is drawn as an overlay sprite on top of the plot. */
  private syncCropOverlay(
    view: EntityView,
    snapshot: Extract<EntitySnapshot, { k: 'structure' }>,
  ): void {
    const crop = snapshot.plot?.crop;
    if (!crop) {
      view.overlay?.destroy();
      delete view.overlay;
      return;
    }
    const def = this.data.crops.get(crop.defId);
    const key = crop.dead
      ? TextureKey.cropDead
      : TextureKey.crop(crop.defId, Math.min(crop.stage, (def?.stages ?? 1) - 1));
    if (!this.scene.textures.exists(key)) return;

    const overlay = view.overlay ?? this.scene.add.sprite(0, 0, key).setOrigin(0, 0);
    view.overlay = overlay;
    if (overlay.texture.key !== key) overlay.setTexture(key);
    overlay.setPosition(snapshot.tileX * TILE_SIZE, snapshot.tileY * TILE_SIZE);
    overlay.setDepth(DEPTH.structureFloor + 1 + snapshot.tileY * TILE_SIZE * 0.001);
  }

  /** Tint conveys state that the silhouette cannot: dead, staggered, blueprint. */
  private syncTint(view: EntityView, snapshot: EntitySnapshot): void {
    const sprite = view.sprite;
    if (snapshot.k === 'zombie') {
      if (snapshot.ai === 'dead') sprite.setTint(0x555555);
      else if (snapshot.ai === 'stagger') sprite.setTint(0xffbbaa);
      else if (snapshot.ai === 'pursue' || snapshot.ai === 'attack') sprite.setTint(0xffd9d0);
      else sprite.clearTint();
      return;
    }
    if (snapshot.k === 'player' && !snapshot.alive) {
      sprite.setTint(0x666666);
      return;
    }
    if (snapshot.k === 'animal' && snapshot.ai === 'dead') {
      sprite.setTint(0x555555);
      return;
    }
    sprite.clearTint();
  }

  private destroyView(id: string): void {
    const view = this.views.get(id);
    if (!view) return;
    view.sprite.destroy();
    view.healthBar?.destroy();
    view.nameLabel?.destroy();
    view.overlay?.destroy();
    this.views.delete(id);
  }

  destroy(): void {
    for (const id of [...this.views.keys()]) this.destroyView(id);
  }
}

export { DEPTH as EntityDepth };
