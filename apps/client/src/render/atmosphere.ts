import Phaser from 'phaser';
import type { PlayerState, WeatherState, WorldTimeState } from '@survive/protocol';
import type { GameData } from '@survive/game-data';
import { TextureKey } from '../art/textures';
import { EntityDepth } from './entityRenderer';
import type { RenderEntity } from '../net/session';

/**
 * Time of day, weather and light.
 *
 * Night is the game's main pressure valve, so it has to actually be dark - but dark
 * enough to be dangerous while still being playable. That is a darkness overlay whose
 * alpha follows `time.lightLevel`, punctured by light pools around fires, lanterns and
 * the player's own torch.
 */

const NIGHT_TINT = 0x0a1626;

/**
 * How dark the darkest night gets.
 *
 * Tuned by looking at it: below about 0.7 the terrain silhouette disappears entirely.
 */
const MAX_DARKNESS = 0.68;
const STORM_TINT = 0x1a2026;
const FOG_TINT = 0x9fb0b4;

export class AtmosphereRenderer {
  private readonly darkness: Phaser.GameObjects.Rectangle;
  private readonly weatherTint: Phaser.GameObjects.Rectangle;
  private readonly lights: Phaser.GameObjects.Sprite[] = [];
  private rain: Phaser.GameObjects.Group | null = null;
  private lastWeather = '';

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly data: GameData,
  ) {
    const camera = scene.cameras.main;
    this.darkness = scene.add
      .rectangle(0, 0, camera.width, camera.height, NIGHT_TINT, 0)
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(EntityDepth.overlay + 10)
      // Multiply darkens what is underneath instead of washing it out with grey.
      .setBlendMode(Phaser.BlendModes.MULTIPLY);
    this.weatherTint = scene.add
      .rectangle(0, 0, camera.width, camera.height, STORM_TINT, 0)
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(EntityDepth.overlay + 9);
  }

  resize(width: number, height: number): void {
    this.darkness.setSize(width, height);
    this.weatherTint.setSize(width, height);
  }

  /**
   * Update the whole atmosphere for this frame.
   *
   * Light sources are pooled sprites positioned over anything currently emitting light:
   * lit stations, lanterns, and the player if they are carrying a torch.
   */
  update(
    time: WorldTimeState | null,
    weather: WeatherState | null,
    self: PlayerState | null,
    entities: readonly RenderEntity[],
  ): void {
    const light = time?.lightLevel ?? 1;
    // Never fully black. A moonless, overcast midnight reports a light level of about
    // 0.005, and multiply-blending 0.82 of near-black over dark grass is genuinely
    // opaque - a player who cannot make out the ground stops playing rather than
    // feeling tense. 0.68 leaves terrain as a readable silhouette while keeping a torch
    // or a campfire obviously worth having.
    const darkAlpha = Math.min(MAX_DARKNESS, Math.pow(1 - light, 1.35));
    this.darkness.setAlpha(darkAlpha);
    this.darkness.setFillStyle(NIGHT_TINT, darkAlpha);

    if (weather) {
      this.applyWeather(weather);
    }

    this.syncLights(self, entities, darkAlpha);
  }

  private applyWeather(weather: WeatherState): void {
    switch (weather.type) {
      case 'storm':
        this.weatherTint.setFillStyle(STORM_TINT, 0.3 * weather.intensity);
        break;
      case 'rain':
        this.weatherTint.setFillStyle(STORM_TINT, 0.18 * weather.intensity);
        break;
      case 'overcast':
        this.weatherTint.setFillStyle(STORM_TINT, 0.12 * weather.intensity);
        break;
      case 'fog':
        this.weatherTint.setFillStyle(FOG_TINT, 0.3 * weather.intensity);
        break;
      case 'snow':
        this.weatherTint.setFillStyle(0xdde8ea, 0.12 * weather.intensity);
        break;
      default:
        this.weatherTint.setFillStyle(STORM_TINT, 0);
        break;
    }

    if (weather.type !== this.lastWeather) {
      this.lastWeather = weather.type;
      this.rebuildPrecipitation(weather);
    }
    if (weather.lightning) {
      this.weatherTint.setFillStyle(0xffffff, 0.35);
    }
  }

  /**
   * Precipitation is a screen-space particle emitter, not world-space.
   *
   * Rain that scrolled with the world would need to cover the whole loaded area; anchored
   * to the camera it needs only a screenful and looks the same.
   */
  private rebuildPrecipitation(weather: WeatherState): void {
    this.rain?.destroy(true);
    this.rain = null;
    const wet = weather.type === 'rain' || weather.type === 'storm';
    const snowing = weather.type === 'snow';
    if (!wet && !snowing) return;

    const textureKey = snowing ? TextureKey.snow : TextureKey.rain;
    if (!this.scene.textures.exists(textureKey)) return;

    const camera = this.scene.cameras.main;
    const count = Math.round((snowing ? 90 : 220) * Math.max(0.25, weather.intensity));
    const group = this.scene.add.group();
    for (let i = 0; i < count; i++) {
      const sprite = this.scene.add
        .sprite(Math.random() * camera.width, Math.random() * camera.height, textureKey)
        .setScrollFactor(0)
        .setDepth(EntityDepth.overlay + 8)
        .setAlpha(snowing ? 0.75 : 0.5);
      if (!snowing) sprite.setRotation(1.35);
      group.add(sprite);
    }
    this.rain = group;
  }

  /** Drift the precipitation. Called every frame; cheap because it is screen-space. */
  updatePrecipitation(deltaMs: number, weather: WeatherState | null): void {
    if (!this.rain || !weather) return;
    const camera = this.scene.cameras.main;
    const snowing = weather.type === 'snow';
    const speed = (snowing ? 0.05 : 0.9) * deltaMs;
    const drift = Math.cos(weather.windAngle) * (snowing ? 0.03 : 0.12) * deltaMs;
    for (const child of this.rain.getChildren()) {
      const sprite = child as Phaser.GameObjects.Sprite;
      sprite.y += speed;
      sprite.x += drift;
      if (sprite.y > camera.height) {
        sprite.y = -8;
        sprite.x = Math.random() * camera.width;
      }
      if (sprite.x > camera.width) sprite.x = 0;
      else if (sprite.x < 0) sprite.x = camera.width;
    }
  }

  private syncLights(
    self: PlayerState | null,
    entities: readonly RenderEntity[],
    darkAlpha: number,
  ): void {
    if (darkAlpha < 0.05) {
      for (const light of this.lights) light.setVisible(false);
      return;
    }

    interface LightSource {
      x: number;
      y: number;
      radius: number;
    }
    const sources: LightSource[] = [];

    for (const entry of entities) {
      const snapshot = entry.snapshot;
      if (snapshot.k !== 'structure') continue;
      const def = this.data.structures.get(snapshot.defId);
      if (!def) continue;
      const lit = snapshot.light?.on ?? snapshot.station?.lit ?? false;
      if (!lit) continue;
      const radius = snapshot.light?.radius ?? def.light?.radius ?? 96;
      sources.push({
        x: snapshot.tileX * 32 + (def.width * 32) / 2,
        y: snapshot.tileY * 32 + (def.height * 32) / 2,
        radius,
      });
    }

    // A held torch or lantern is the player's own light.
    if (self) {
      const held = self.equipment.mainHand ?? self.equipment.offHand;
      const def = held ? this.data.items.get(held.defId) : undefined;
      if (def?.tags.includes('light')) sources.push({ x: self.x, y: self.y, radius: 150 });
    }

    for (let i = 0; i < Math.max(sources.length, this.lights.length); i++) {
      const source = sources[i];
      let sprite = this.lights[i];
      if (!source) {
        sprite?.setVisible(false);
        continue;
      }
      if (!sprite) {
        if (!this.scene.textures.exists(TextureKey.light)) return;
        sprite = this.scene.add
          .sprite(0, 0, TextureKey.light)
          .setDepth(EntityDepth.overlay + 11)
          // Screen-blending a warm blob back over the darkness reads as light spilling.
          .setBlendMode(Phaser.BlendModes.SCREEN);
        this.lights[i] = sprite;
      }
      sprite.setVisible(true);
      sprite.setPosition(source.x, source.y);
      sprite.setDisplaySize(source.radius * 2, source.radius * 2);
      sprite.setAlpha(Math.min(0.85, darkAlpha + 0.15));
    }
  }

  destroy(): void {
    this.darkness.destroy();
    this.weatherTint.destroy();
    this.rain?.destroy(true);
    for (const light of this.lights) light.destroy();
    this.lights.length = 0;
  }
}
