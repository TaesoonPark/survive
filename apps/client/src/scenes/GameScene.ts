import Phaser from 'phaser';
import {
  CHUNK_LOAD_RADIUS,
  TILE_SIZE,
  distance,
  pixelToTile,
  type ChunkKey,
  type EntitySnapshot,
  type SimEvent,
} from '@survive/protocol';
import type { GameData } from '@survive/game-data';
import { Controls, type UiAction } from '../input/controls';
import { GameSession, type RenderEntity } from '../net/session';
import { AtmosphereRenderer } from '../render/atmosphere';
import { EffectsRenderer } from '../render/effects';
import { EntityDepth, EntityRenderer } from '../render/entityRenderer';
import { TerrainRenderer } from '../render/terrainRenderer';
import { TextureKey } from '../art/textures';
/**
 * A connect failure the player can actually read.
 *
 * The underlying errors are a mix of `JoinRejectedError` codes, fetch failures and abort
 * timeouts, none of which mean anything on a menu screen.
 */
function describeConnectError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/protocol_mismatch/.test(text)) return 'That server is running a different game version.';
  if (/bad_password/.test(text)) return 'Wrong password.';
  if (/bad_token/.test(text)) return 'That server refused the connection token.';
  if (/server_full/.test(text)) return 'That server is full.';
  if (/name_taken/.test(text)) return 'That name is already playing on this server.';
  if (/abort|timeout|timed out/i.test(text))
    return 'No answer from that address. Is the server running?';
  if (/fetch|network|ECONNREFUSED|Failed to fetch/i.test(text)) {
    return 'Could not reach that address. Check the host and port.';
  }
  return `Could not connect: ${text}`;
}

/**
 * How far outside the camera an entity is still drawn, in pixels.
 *
 * Two tiles' worth of slack, so a sprite whose origin is just off screen but whose art
 * overlaps it does not blink out at the edge.
 */
const CULL_MARGIN = TILE_SIZE * 3;

/**
 * Smallest cursor-to-entity distance that counts as pointing at it, in pixels.
 *
 * Half a tile. Hunting for the exact pixel of a berry bush is not a game mechanic.
 */
const MIN_HOVER_RADIUS = 14;
import { GATHER_COOLDOWN_TICKS } from '@survive/simulation/systems/world/gathering';
import { installDebugHook, removeDebugHook } from '../debugHook';
import type { GameSceneData } from './connectionTypes';

/**
 * The world view.
 *
 * Owns the camera, the renderers and the input loop, and nothing else. It reads
 * authoritative state out of {@link GameSession} and draws it; it never decides what
 * anything means. The UI lives in a separate scene layered on top, so a panel can take
 * over the pointer without touching the world.
 */
export class GameScene extends Phaser.Scene {
  static readonly KEY = 'Game';

  session!: GameSession;
  /** Content tables. Named `gameData` because Phaser.Scene already owns `data`. */
  gameData!: GameData;
  controls!: Controls;
  terrain!: TerrainRenderer;
  entities!: EntityRenderer;
  effects!: EffectsRenderer;
  atmosphere!: AtmosphereRenderer;

  /** The local player's sprite, drawn from the predicted position. */
  private selfSprite!: Phaser.GameObjects.Sprite;
  private aimLine!: Phaser.GameObjects.Graphics;
  private interactRing!: Phaser.GameObjects.Sprite;
  private buildGhost!: Phaser.GameObjects.Sprite;

  private pendingRemovals: string[] = [];
  private chunkRequestCooldown = 0;
  /** Entity the player would interact with if they pressed the key now. */
  private focusEntityId: string | null = null;
  /** True while a UI panel wants the pointer and the keyboard. */
  private uiCaptured = false;

  constructor() {
    super(GameScene.KEY);
  }

  create(sceneData: GameSceneData): void {
    this.gameData = this.registry.get('gameData') as GameData;

    // No `playerId`: the server derives it from the name, and it is the only place that
    // should. This used to send its own slug, computed here with a third copy of the
    // server's rule that had lost the digest the server appends when cleaning is lossy -
    // so every name not spelled in ASCII arrived pre-flattened and the server could no
    // longer tell them apart. See `sanitizePlayerId`.
    this.session = new GameSession({
      url: sceneData.connection.url,
      name: sceneData.name,
      ...(sceneData.password ? { password: sceneData.password } : {}),
      ...(sceneData.connection.token ? { token: sceneData.connection.token } : {}),
      data: this.gameData,
    });

    this.terrain = new TerrainRenderer(this);
    this.entities = new EntityRenderer(this, this.gameData);
    this.effects = new EffectsRenderer(this, () => this.session.self?.id ?? null, this.gameData);
    this.atmosphere = new AtmosphereRenderer(this, this.gameData);
    this.controls = new Controls(this);

    this.selfSprite = this.add.sprite(0, 0, TextureKey.playerSelf).setDepth(EntityDepth.creature);
    this.aimLine = this.add.graphics().setDepth(EntityDepth.creature - 1);
    this.interactRing = this.add
      .sprite(0, 0, TextureKey.selectRing)
      .setDepth(EntityDepth.overlay - 5)
      .setVisible(false);
    this.buildGhost = this.add
      .sprite(0, 0, TextureKey.ghostValid)
      .setOrigin(0, 0)
      .setDepth(EntityDepth.overlay - 4)
      .setVisible(false);

    const camera = this.cameras.main;
    camera.setZoom(1.5);
    camera.setRoundPixels(true);

    this.session.setListeners({
      onChunk: (chunk) => this.terrain.apply(chunk),
      onChunkDrop: (keys) => this.terrain.dropMany(keys as ChunkKey[]),
      onEvents: (events) => this.onEvents(events),
      onSnapshot: (snapshot) => {
        this.pendingRemovals.push(...snapshot.removed);
      },
      onDisconnect: (reason) => this.onDisconnect(reason),
    });

    // The UI scene runs in parallel and reads this scene through the registry.
    this.registry.set('gameScene', this);
    this.scene.launch('Ui');

    // A read-only window hook, so the Playwright suite can assert on authoritative state
    // instead of pixel-diffing a canvas. See debugHook.ts for why this is safe to ship.
    installDebugHook(
      this.session,
      () => {
        const ui = this.scene.get('Ui') as { openPanelIds?: string[] } | null;
        return ui?.openPanelIds ?? [];
      },
      () => ({ count: this.frameCount, lastDeltaMs: this.lastDeltaMs }),
      () => ({ x: this.cameras.main.scrollX, y: this.cameras.main.scrollY }),
      () => this.focusEntityId,
    );

    this.scale.on(Phaser.Scale.Events.RESIZE, this.onResize, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.teardown());

    void this.connect();
  }

  private async connect(): Promise<void> {
    try {
      const welcome = await this.session.connect();
      console.info('[game] connected', welcome.world.name, 'seed', welcome.world.seed);
      if (welcome.dataVersion !== this.gameData.version) {
        this.effects.toast('Server content differs from this client — expect oddities.');
      }
    } catch (error) {
      // Hand the reason back to the menu rather than the boot overlay: a failed connect
      // is a menu-level problem the player can act on (wrong address, server down), and
      // the boot overlay is for failures that mean the client itself cannot run.
      this.scene.stop('Ui');
      this.scene.start('Menu', { error: describeConnectError(error) });
    }
  }

  private onDisconnect(reason: string): void {
    this.effects.toast(`Disconnected: ${reason}`);
    this.time.delayedCall(1500, () => {
      this.scene.stop('Ui');
      this.scene.start('Menu', { error: `Disconnected: ${reason}` });
    });
  }

  private onEvents(events: readonly SimEvent[]): void {
    this.effects.handle(events);
    // A tile override (tilled soil, a broken road) arrives as an event because terrain
    // is otherwise static and never re-sent.
    for (const event of events) {
      if (event.type === 'plotTilled') {
        this.terrain.setTile(event.tileX, event.tileY, 16);
      }
    }
  }

  private onResize(size: Phaser.Structs.Size): void {
    this.atmosphere.resize(size.width, size.height);
  }

  /**
   * A UI panel has taken over the pointer.
   *
   * This suppresses *world* input - movement, attacking, placing - but deliberately not
   * the UI hotkeys: a panel opened with `I` has to be closable with `I`. Typing is
   * handled separately, by ignoring keystrokes aimed at a text field.
   */
  setUiCaptured(captured: boolean): void {
    this.uiCaptured = captured;
    if (captured) this.controls.consumePointer();
  }

  /** Whether the interact key was held on the most recent sample. */
  private interactHeld = false;
  /** Entity under the cursor, for the world tooltip. Null when the cursor is over nothing. */
  private hoverEntityId: string | null = null;
  private pointerScreenX = 0;
  private pointerScreenY = 0;
  /**
   * Server tick the last gather command was sent on.
   *
   * Only a backstop. The real gate is the player's replicated `useReadyTick`, but the
   * rejections that fire *before* the server sets it - out of range, no line of sight -
   * would otherwise let a held key retry every frame, and every rejection raises a toast.
   */
  private lastGatherTick = Number.NEGATIVE_INFINITY;

  /** Frames this scene has stepped, and the delta it last saw. Read by the debug hook. */
  frameCount = 0;
  lastDeltaMs = 0;

  override update(_time: number, argDeltaMs: number): void {
    // Read the frame delta from the game loop rather than trusting the argument. Phaser's
    // scene-update signature has moved between versions, and a delta that silently
    // arrives as 0 does not crash - it just freezes the camera and stops prediction,
    // which is a genuinely hard bug to see. The loop always has the real value.
    const loopDelta = this.game.loop.delta;
    const deltaMs = Number.isFinite(argDeltaMs) && argDeltaMs > 0 ? argDeltaMs : loopDelta;
    this.frameCount++;
    this.lastDeltaMs = deltaMs;

    const self = this.session.self;
    const predicted = this.session.predicted;

    if (self) {
      const sample = this.controls.sample(this.cameras.main, predicted.x, predicted.y);
      const intent = this.session.intent;
      // A captured UI must not leave the player sprinting into a wall behind the panel.
      intent.moveX = this.uiCaptured ? 0 : sample.moveX;
      intent.moveY = this.uiCaptured ? 0 : sample.moveY;
      intent.sprint = !this.uiCaptured && sample.sprint;
      intent.crouch = !this.uiCaptured && sample.crouch;
      intent.primary = !this.uiCaptured && sample.primary;
      intent.secondary = !this.uiCaptured && sample.secondary;
      intent.block = !this.uiCaptured && sample.block;
      intent.aimAngle = sample.aimAngle;
      this.interactHeld = !this.uiCaptured && sample.interactHeld;
      this.pointerScreenX = sample.pointerScreenX;
      this.pointerScreenY = sample.pointerScreenY;

      this.handleActions(this.controls.drainActions(), sample.pointerWorldX, sample.pointerWorldY);
    } else {
      this.interactHeld = false;
    }

    this.session.update(deltaMs);

    const nowMs = performance.now();
    // Cull to the camera plus a margin. The area of interest is a 2.5-chunk radius so
    // entities never pop in at the screen edge, but that is ~25x the visible area: without
    // this the renderer interpolates and updates hundreds of sprites nobody can see.
    const cull = this.cameraBounds(CULL_MARGIN);
    const renderEntities = this.session.entities(nowMs, cull);
    this.entities.sync(renderEntities, this.pendingRemovals);
    this.pendingRemovals = [];

    this.drawSelf(self !== null);
    this.updateCamera();
    this.updateFocus(renderEntities);
    this.updateHover(renderEntities);
    this.repeatGather();
    this.updateBuildGhost();

    this.atmosphere.update(this.session.time, this.session.weather, self, renderEntities);
    this.atmosphere.updatePrecipitation(deltaMs, this.session.weather);
    this.effects.update(deltaMs);

    this.requestMissingChunks(deltaMs);
  }

  /** The camera's world rectangle, expanded by `margin` on every side. */
  private cameraBounds(margin: number): { x: number; y: number; w: number; h: number } {
    const camera = this.cameras.main;
    const width = camera.width / camera.zoom;
    const height = camera.height / camera.zoom;
    return {
      x: camera.scrollX - margin,
      y: camera.scrollY - margin,
      w: width + margin * 2,
      h: height + margin * 2,
    };
  }

  private drawSelf(connected: boolean): void {
    const self = this.session.self;
    this.selfSprite.setVisible(connected);
    if (!self) return;
    // The interpolated position, not the raw prediction: the ladder is 20 Hz and the
    // display is not, so drawing the rung itself makes the sprite judder against a camera
    // that eases smoothly. See `GameSession.renderPosition`.
    const predicted = this.session.renderPosition;
    this.selfSprite.setPosition(predicted.x, predicted.y);
    this.selfSprite.setRotation(this.session.facing);
    this.selfSprite.setDepth(EntityDepth.creature + predicted.y * 0.001);
    this.selfSprite.setAlpha(self.alive ? 1 : 0.4);

    // A short aim indicator: with mouse-aimed melee the player needs to see the arc they
    // are about to swing through.
    this.aimLine.clear();
    if (self.alive) {
      const reach = this.currentReach();
      this.aimLine.lineStyle(1, 0xdfe6e6, 0.22);
      this.aimLine.beginPath();
      this.aimLine.moveTo(predicted.x, predicted.y);
      this.aimLine.lineTo(
        predicted.x + Math.cos(self.aimAngle) * reach,
        predicted.y + Math.sin(self.aimAngle) * reach,
      );
      this.aimLine.strokePath();
    }
  }

  /** Reach of the equipped weapon, or a bare-handed default. */
  private currentReach(): number {
    const self = this.session.self;
    const held = self?.equipment.mainHand;
    const def = held ? this.gameData.items.get(held.defId) : undefined;
    return def?.weapon?.range ?? 34;
  }

  /**
   * Camera.
   *
   * Follows the predicted position directly rather than through Phaser's follow, which
   * would add a second smoothing pass on top of prediction and make the world feel like
   * it lags behind the player.
   */
  private updateCamera(): void {
    const camera = this.cameras.main;
    // Locked exactly to the position the sprite is drawn at, not eased towards it.
    //
    // The camera used to ease, because its target was the raw 20 Hz prediction and needed
    // smoothing. `GameSession.renderPosition` now does that smoothing, and easing an
    // already-eased value makes a second-order filter: at constant speed the two lags
    // cancel and the sprite sits still on screen, but the moment the player starts, stops
    // or turns, the lags differ for a few frames and the sprite slides across the screen
    // and back. Measured as a 0.77 px screen-space step - six times the steady-state
    // figure - clustered exactly on the frames where movement began and ended, with
    // reconciliation reporting no error at all. Locking removes the ringing outright:
    // the world scrolls smoothly and the player holds the centre.
    //
    // `centerOn` rather than arithmetic on `scrollX`. Phaser zooms about the camera's
    // midpoint, so the world point at the centre of the screen is `scrollX + width / 2`
    // regardless of zoom - the obvious-looking `x - width / (2 * zoom)` left the player
    // 213 px off centre at zoom 1.5, which is where this was found: pointing the mouse at
    // a tree missed it by exactly that much.
    camera.centerOn(this.session.renderPosition.x, this.session.renderPosition.y);
  }

  /**
   * Pick the thing the interact key would act on.
   *
   * Nearest interactable within arm's reach of the *player*, not of the cursor: reaching
   * across a room with the mouse should not open a chest.
   */
  private updateFocus(entities: readonly RenderEntity[]): void {
    const self = this.session.self;
    if (!self) {
      this.interactRing.setVisible(false);
      this.focusEntityId = null;
      return;
    }
    const reach = 56;
    let best: RenderEntity | null = null;
    let bestDistance = reach;
    for (const entry of entities) {
      if (!this.isInteractable(entry.snapshot)) continue;
      const d = distance(self.x, self.y, entry.x, entry.y);
      if (d < bestDistance) {
        bestDistance = d;
        best = entry;
      }
    }
    this.focusEntityId = best?.snapshot.id ?? null;
    if (best) {
      this.interactRing.setVisible(true);
      this.interactRing.setPosition(best.x, best.y);
    } else {
      this.interactRing.setVisible(false);
    }
  }

  /**
   * Keep harvesting for as long as the interact key is held.
   *
   * Chopping a tree takes a dozen swings, and one key press per swing turns gathering into
   * a typing exercise. The repeat is driven by the server's own cooldown - `useReadyTick`
   * arrives on every snapshot and is the authority on when the next swing is allowed - so
   * the client is not guessing at a rate, and a command sent the tick it becomes legal is
   * still processed later than that, never early.
   *
   * Deliberately nodes only. A held key on a door would swing it open and shut once per
   * cooldown, and on a dropped item would hoover up everything within reach.
   */
  private repeatGather(): void {
    if (!this.interactHeld) return;
    const self = this.session.self;
    if (!self) return;
    const focus = this.focusEntity();
    if (focus?.k !== 'node' || focus.depleted) return;
    const tick = this.session.clock.tick;
    if (tick < self.useReadyTick) return;
    if (tick - this.lastGatherTick < GATHER_COOLDOWN_TICKS) return;
    this.sendGather(focus.id);
  }

  private sendGather(nodeId: string): void {
    this.lastGatherTick = this.session.clock.tick;
    this.session.send({ type: 'gather', nodeId });
  }

  /**
   * What the cursor is pointing at.
   *
   * Separate from {@link updateFocus}, which answers a different question: focus is what the
   * *interact key* would act on and so is measured from the player, while this is measured
   * from the cursor. Reaching across a room with the mouse should not open a chest, but it
   * should absolutely be able to read a label on a tree over there.
   *
   * Nearest hit wins rather than first, so a sapling in front of a boulder describes the
   * sapling. Radii come from the data tables where the entity has one, because a pine and a
   * dropped berry are not the same size to point at.
   */
  private updateHover(entities: readonly RenderEntity[]): void {
    if (this.uiCaptured) {
      this.hoverEntityId = null;
      return;
    }
    const world = this.cameras.main.getWorldPoint(this.pointerScreenX, this.pointerScreenY);
    let best: RenderEntity | null = null;
    let bestDistance = Infinity;
    for (const entry of entities) {
      const radius = this.hoverRadius(entry.snapshot);
      const d = distance(world.x, world.y, entry.x, entry.y);
      if (d > radius || d >= bestDistance) continue;
      bestDistance = d;
      best = entry;
    }
    this.hoverEntityId = best?.snapshot.id ?? null;
  }

  /**
   * How close the cursor has to be to point at this thing, in pixels.
   *
   * Floored, because a node's `radius` is its *collision* radius and several have none at
   * all - a water source and a fishing spot are both radius 0, so taking the data value
   * literally made them impossible to point at. Pointing precision is an interface
   * question, not a physics one.
   */
  private hoverRadius(snapshot: EntitySnapshot): number {
    switch (snapshot.k) {
      case 'node':
        return Math.max(MIN_HOVER_RADIUS, this.gameData.nodes.get(snapshot.defId)?.radius ?? 0);
      case 'item':
        return MIN_HOVER_RADIUS;
      case 'structure':
        return 20;
      case 'projectile':
        // Nothing to say about an arrow in flight, and it would flicker past the cursor.
        return 0;
      default:
        return 16;
    }
  }

  /**
   * Screen position of a world point.
   *
   * Phaser exposes `getWorldPoint` but not its inverse, and the naive inverse is wrong: the
   * camera zooms about its own midpoint, so the world point at the centre of the screen is
   * `scrollX + width / 2` whatever the zoom. Getting this backwards is what left the player
   * 213 px off centre for as long as nothing needed to convert the other way. A round-trip
   * test in `movement.spec.ts` pins the two together.
   */
  private worldToScreen(x: number, y: number): { x: number; y: number } {
    const camera = this.cameras.main;
    const halfWidth = camera.width / 2;
    const halfHeight = camera.height / 2;
    return {
      x: (x - camera.scrollX - halfWidth) * camera.zoom + halfWidth,
      y: (y - camera.scrollY - halfHeight) * camera.zoom + halfHeight,
    };
  }

  /**
   * The entity the interact key is aimed at, in screen space.
   *
   * `y` is lifted to the top of the interaction ring so a label sits above the target
   * rather than across it.
   */
  focusLabelTarget(): { snapshot: EntitySnapshot; screenX: number; screenY: number } | null {
    if (this.uiCaptured || !this.focusEntityId) return null;
    const snapshot = this.session.store.entity(this.focusEntityId);
    if (!snapshot) return null;
    const world = this.worldToScreen(
      this.interactRing.x,
      this.interactRing.y - this.interactRing.displayHeight / 2,
    );
    return { snapshot, screenX: world.x, screenY: world.y };
  }

  /** The entity under the cursor, and where the cursor is, for the tooltip layer. */
  hoverTarget(): { snapshot: EntitySnapshot; screenX: number; screenY: number } | null {
    if (!this.hoverEntityId) return null;
    const snapshot = this.session.store.entity(this.hoverEntityId);
    if (!snapshot) return null;
    return { snapshot, screenX: this.pointerScreenX, screenY: this.pointerScreenY };
  }

  private isInteractable(snapshot: EntitySnapshot): boolean {
    switch (snapshot.k) {
      case 'item':
        return true;
      case 'node':
        return !snapshot.depleted;
      case 'structure': {
        const def = this.gameData.structures.get(snapshot.defId);
        return Boolean(def?.container || def?.door || def?.station || def?.bed || def?.plot);
      }
      default:
        return false;
    }
  }

  /** The entity the interact key would act on, for the HUD prompt. */
  focusEntity(): EntitySnapshot | undefined {
    if (!this.focusEntityId) return undefined;
    return this.session.store.entity(this.focusEntityId);
  }

  /**
   * The placement preview.
   *
   * Green when the server would accept it, red when it would not. The client cannot know
   * for certain - only the server has the full picture - so this is an honest local
   * approximation: bounds, known terrain and known structures.
   */
  private updateBuildGhost(): void {
    const self = this.session.self;
    const defId = self?.buildDefId;
    if (!self || !defId) {
      this.buildGhost.setVisible(false);
      return;
    }
    const def = this.gameData.structures.get(defId);
    if (!def) {
      this.buildGhost.setVisible(false);
      return;
    }

    const pointer = this.cameras.main.getWorldPoint(
      this.input.activePointer.x,
      this.input.activePointer.y,
    );
    const tileX = pixelToTile(pointer.x);
    const tileY = pixelToTile(pointer.y);
    const swapped = self.buildRotation % 2 === 1;
    const width = swapped ? def.height : def.width;
    const height = swapped ? def.width : def.height;

    const inRange = distance(self.x, self.y, pointer.x, pointer.y) <= TILE_SIZE * 6;
    let valid = inRange;
    for (let dy = 0; dy < height && valid; dy++) {
      for (let dx = 0; dx < width && valid; dx++) {
        const tile = this.terrain.tileAt(tileX + dx, tileY + dy);
        // Unknown terrain is shown as invalid: better a cautious preview than a lying one.
        if (tile === undefined || tile === 0 || tile >= 30) valid = false;
      }
    }

    this.buildGhost.setVisible(true);
    this.buildGhost.setTexture(valid ? TextureKey.ghostValid : TextureKey.ghostInvalid);
    this.buildGhost.setPosition(tileX * TILE_SIZE, tileY * TILE_SIZE);
    this.buildGhost.setDisplaySize(width * TILE_SIZE, height * TILE_SIZE);
  }

  /** Ask for terrain the client has not been sent yet. */
  private requestMissingChunks(deltaMs: number): void {
    this.chunkRequestCooldown -= deltaMs;
    if (this.chunkRequestCooldown > 0) return;
    this.chunkRequestCooldown = 500;
    const self = this.session.self;
    if (!self) return;
    const missing = this.terrain.missingAround(self.x, self.y, CHUNK_LOAD_RADIUS);
    if (missing.length > 0) this.session.requestChunks(missing.slice(0, 8));
  }

  /**
   * One-shot input.
   *
   * Panel toggles are forwarded to the UI scene through the scene event bus; everything
   * else becomes a command for the server.
   */
  private handleActions(actions: readonly UiAction[], pointerX: number, pointerY: number): void {
    const self = this.session.self;
    for (const action of actions) {
      switch (action.type) {
        case 'interact': {
          if (!self) break;
          const focus = this.focusEntity();
          if (focus?.k === 'item')
            this.session.send({ type: 'pickUpItem', itemEntityId: focus.id });
          else if (focus?.k === 'node') this.sendGather(focus.id);
          else if (focus?.k === 'structure')
            this.session.send({ type: 'interact', targetId: focus.id });
          else {
            this.session.send({
              type: 'interact',
              tileX: pixelToTile(pointerX),
              tileY: pixelToTile(pointerY),
            });
          }
          break;
        }
        case 'reload':
          this.session.send({ type: 'reload' });
          break;
        case 'selectHotbar':
          this.session.send({ type: 'selectHotbar', index: action.index });
          break;
        case 'cycleHotbar': {
          if (!self) break;
          const next = (self.activeHotbar + action.delta + self.hotbar.length) % self.hotbar.length;
          this.session.send({ type: 'selectHotbar', index: next });
          break;
        }
        case 'rotateBuild': {
          if (!self) break;
          const rotation = (self.buildRotation + action.delta + 4) % 4;
          this.session.send({
            type: 'setBuildSelection',
            defId: self.buildDefId ?? null,
            rotation,
          });
          break;
        }
        case 'drop': {
          if (!self) break;
          const slot = self.hotbar[self.activeHotbar];
          if (slot !== null && slot !== undefined) {
            this.session.send({
              type: 'dropItem',
              ref: { kind: 'inventory' },
              index: slot,
              count: null,
            });
          } else if (self.equipment.mainHand) {
            this.session.send({
              type: 'dropItem',
              ref: { kind: 'equipment', slot: 'mainHand' },
              index: 0,
              count: null,
            });
          }
          break;
        }
        case 'sleep': {
          const focus = this.focusEntity();
          if (focus?.k === 'structure') this.session.send({ type: 'sleep', structureId: focus.id });
          break;
        }
        default:
          // Panel toggles, chat and pause belong to the UI scene.
          this.events.emit('ui-action', action);
          break;
      }
    }
  }

  private teardown(): void {
    this.scale.off(Phaser.Scale.Events.RESIZE, this.onResize, this);
    this.controls.destroy();
    this.terrain.destroy();
    this.entities.destroy();
    this.effects.destroy();
    this.atmosphere.destroy();
    void this.session.disconnect();
    removeDebugHook();
    this.registry.remove('gameScene');
  }
}
