import {
  Button,
  SIM_DT,
  TICKS_PER_SNAPSHOT,
  aabbContainsPoint,
  type Aabb,
  type ChunkKey,
  type ChunkPayload,
  type Command,
  type EntitySnapshot,
  type InputFrame,
  type JoinOptions,
  type PlayerState,
  type SimEvent,
  type WeatherState,
  type WelcomePayload,
  type WorldSnapshot,
  type WorldTimeState,
  tileProps,
} from '@survive/protocol';
import { createGameData, type GameData } from '@survive/game-data';
import {
  ClientClock,
  EntityInterpolator,
  InputPredictor,
  SnapshotStore,
  connectToServer,
  type ServerConnection,
} from '@survive/netcode';
import {
  conditionSpeedMultiplier,
  stepMovement,
  intentFromFrame,
  resolveMoveMode,
  baseSpeedFor,
} from '@survive/simulation/core/movement';

/**
 * The client's view of the game.
 *
 * Everything network-facing lives here so the Phaser scenes can stay presentational:
 * they read `session.self`, `session.entities()` and `session.time`, and they call
 * `session.setIntent()` / `session.send()`. No scene ever touches a socket.
 *
 * Two things make the local player feel responsive without lying to the server
 * (spec section 17):
 *
 * - **Prediction.** Local input is applied immediately using the *same* movement
 *   function the server runs, then reconciled against the authoritative position.
 * - **Interpolation.** Everyone else is drawn slightly in the past, between the two
 *   snapshots that bracket the render time, so remote motion is smooth at 60fps even
 *   though snapshots arrive at 10Hz.
 */

export interface SessionOptions {
  url: string;
  name: string;
  playerId?: string;
  password?: string;
  token?: string;
  data?: GameData;
}

/** What the renderer needs to draw one entity this frame. */
export interface RenderEntity {
  snapshot: EntitySnapshot;
  x: number;
  y: number;
  facing: number;
}

/** Continuous input the scenes update every frame. */
export interface InputIntentState {
  moveX: number;
  moveY: number;
  aimAngle: number;
  sprint: boolean;
  crouch: boolean;
  primary: boolean;
  secondary: boolean;
  block: boolean;
  interact: boolean;
  reload: boolean;
}

export interface SessionListeners {
  onWelcome?: (welcome: WelcomePayload) => void;
  onEvents?: (events: SimEvent[]) => void;
  onChunk?: (chunk: ChunkPayload) => void;
  onChunkDrop?: (keys: ChunkKey[]) => void;
  onSnapshot?: (snapshot: WorldSnapshot) => void;
  onDisconnect?: (reason: string) => void;
}

/**
 * A minimal movement world backed by the client's chunk cache.
 *
 * Prediction has to collide against the same geometry the server does, but the client
 * only has terrain plus the structures inside its area of interest. That is enough:
 * a mispredicted step against an unknown wall is corrected by the next snapshot, and
 * the alternative - not predicting at all - feels far worse.
 */
export class PredictionWorld {
  constructor(
    private readonly store: SnapshotStore,
    private readonly data: GameData,
  ) {}

  private solidAtTile(tileX: number, tileY: number): boolean {
    const tile = this.store.tileAt(tileX, tileY);
    // Unknown terrain is treated as open: better to walk into it and be corrected than
    // to be invisibly stuck at a chunk boundary.
    if (tile === undefined) return false;
    if (tileProps(tile).solid) return true;
    return this.structureSolidAt(tileX, tileY);
  }

  private structureSolidAt(tileX: number, tileY: number): boolean {
    for (const entity of this.store.entitiesOfKind('structure')) {
      if (entity.k !== 'structure') continue;
      const def = this.data.structures.get(entity.defId);
      if (!def?.blocksMovement) continue;
      if (def.door && entity.door?.open) continue;
      const swapped = entity.rotation % 2 === 1;
      const width = swapped ? def.height : def.width;
      const height = swapped ? def.width : def.height;
      if (
        tileX >= entity.tileX &&
        tileX < entity.tileX + width &&
        tileY >= entity.tileY &&
        tileY < entity.tileY + height
      ) {
        return true;
      }
    }
    return false;
  }

  speedAt(x: number, y: number): number {
    const tile = this.store.tileAt(Math.floor(x / 32), Math.floor(y / 32));
    return tile === undefined ? 1 : tileProps(tile).speed;
  }

  private circleBlocked(x: number, y: number, radius: number): boolean {
    const minX = Math.floor((x - radius) / 32);
    const maxX = Math.floor((x + radius) / 32);
    const minY = Math.floor((y - radius) / 32);
    const maxY = Math.floor((y + radius) / 32);
    for (let tileY = minY; tileY <= maxY; tileY++) {
      for (let tileX = minX; tileX <= maxX; tileX++) {
        if (this.solidAtTile(tileX, tileY)) return true;
      }
    }
    return false;
  }

  moveCircle(
    x: number,
    y: number,
    dx: number,
    dy: number,
    radius: number,
  ): { x: number; y: number; blockedX: boolean; blockedY: boolean } {
    let nextX = x;
    let nextY = y;
    let blockedX = false;
    let blockedY = false;
    if (dx !== 0) {
      if (this.circleBlocked(x + dx, y, radius)) blockedX = true;
      else nextX = x + dx;
    }
    if (dy !== 0) {
      if (this.circleBlocked(nextX, y + dy, radius)) blockedY = true;
      else nextY = y + dy;
    }
    return { x: nextX, y: nextY, blockedX, blockedY };
  }
}

/**
 * Time constant for easing the drawn position toward the prediction, in milliseconds.
 *
 * Short enough that the lag (about tau x speed, ~5 px at walking pace) is imperceptible,
 * long enough to absorb a whole simulation step. Matches the camera's own easing so the two
 * cannot visibly disagree.
 */
const RENDER_EASE_MS = 45;

export class GameSession {
  readonly store = new SnapshotStore();
  readonly clock = new ClientClock();
  readonly interpolator = new EntityInterpolator();
  readonly predictor = new InputPredictor();
  /**
   * Predicted position as it stood before the most recent fixed step.
   *
   * Rendering reads {@link renderPosition}, which slides between this and the current
   * prediction. Drawing the raw prediction instead means the sprite only moves 20 times a
   * second while the display refreshes at 60 or 120 - it holds still for several frames and
   * then jumps a whole tick's distance. Against a camera that eases smoothly, that reads as
   * the character shuddering back and forth in the direction it is walking.
   */
  private renderX = 0;
  private renderY = 0;
  /**
   * The predicted position one simulation step back.
   *
   * Rendering interpolates between this and the current rung by the leftover accumulator,
   * which is what makes the drawn speed constant instead of pulsing once per tick.
   */
  private prevPredX = 0;
  private prevPredY = 0;

  /** What the last reconciliation did. Read by the debug hook; see `net()`. */
  lastReconcileInfo: {
    error: number;
    ackSeq: number;
    newestSeq: number;
    pending: number;
    replayed: number;
    corrected: boolean;
    hardSnapped: boolean;
  } | null = null;
  readonly data: GameData;

  private connection: ServerConnection | null = null;
  private predictionWorld: PredictionWorld;
  private listeners: SessionListeners = {};
  private welcomePayload: WelcomePayload | null = null;

  /** Live input, written by the scenes every frame. */
  readonly intent: InputIntentState = {
    moveX: 0,
    moveY: 0,
    aimAngle: 0,
    sprint: false,
    crouch: false,
    primary: false,
    secondary: false,
    block: false,
    interact: false,
    reload: false,
  };

  /**
   * Body facing, tracked separately because the predictor only owns position and
   * velocity - facing is presentation and never needs reconciling.
   */
  private predictedFacing = 0;

  private accumulatorMs = 0;
  private lastPingMs = 0;
  private connected = false;
  private hasSpawned = false;
  private disconnectReason: string | null = null;
  /** How often snapshots arrive, in ms. Read by the netgraph and the HUD. */
  snapshotIntervalMs = TICKS_PER_SNAPSHOT * SIM_DT * 1000;

  constructor(options: SessionOptions) {
    this.data = options.data ?? createGameData();
    this.predictionWorld = new PredictionWorld(this.store, this.data);
    this.options = options;
  }

  private readonly options: SessionOptions;

  get isConnected(): boolean {
    return this.connected;
  }

  get welcome(): WelcomePayload | null {
    return this.welcomePayload;
  }

  get self(): PlayerState | null {
    return this.store.self;
  }

  get time(): WorldTimeState | null {
    return this.store.time;
  }

  get weather(): WeatherState | null {
    return this.store.weather;
  }

  get latencyMs(): number {
    return this.connection?.latency ?? 0;
  }

  get lastDisconnectReason(): string | null {
    return this.disconnectReason;
  }

  /** Prediction error in pixels, for the netgraph. */
  get predictionError(): number {
    return this.predictor.errorMagnitude;
  }

  /**
   * The locally predicted body, owned by the predictor.
   *
   * Returned by reference: the camera and the local sprite read the same object the
   * predictor corrects in place.
   */
  get predicted(): { x: number; y: number; vx: number; vy: number } {
    return this.predictor.predicted;
  }

  get facing(): number {
    return this.predictedFacing;
  }

  setListeners(listeners: SessionListeners): void {
    this.listeners = listeners;
  }

  async connect(): Promise<WelcomePayload> {
    const join: JoinOptions = {
      protocolVersion: 1,
      name: this.options.name,
      ...(this.options.playerId ? { playerId: this.options.playerId } : {}),
      ...(this.options.password ? { password: this.options.password } : {}),
      ...(this.options.token ? { token: this.options.token } : {}),
    };

    this.connection = await connectToServer({
      url: this.options.url,
      roomName: 'survive',
      join,
      onWelcome: (payload) => {
        this.welcomePayload = payload;
        this.clock.onWelcome(payload);
        this.snapshotIntervalMs = 1000 / Math.max(1, payload.config.snapshotHz);
        this.listeners.onWelcome?.(payload);
      },
      onSnapshot: (snapshot) => this.applySnapshot(snapshot),
      onChunk: (chunk) => {
        this.store.applyChunk(chunk);
        this.listeners.onChunk?.(chunk);
      },
      onChunkDrop: (payload) => {
        this.store.dropChunks(payload.keys);
        this.listeners.onChunkDrop?.(payload.keys);
      },
      onEvents: (batch) => this.listeners.onEvents?.(batch.events),
      onPong: (pong) => this.clock.onPong(pong),
      onKick: (payload) => this.handleDisconnect(payload.reason),
      onError: (payload) => this.handleDisconnect(`${payload.code}: ${payload.message}`),
      onDisconnect: () => this.handleDisconnect('connection closed'),
    });

    this.connected = true;
    if (!this.welcomePayload) {
      // The connection resolves as soon as the room is joined; the welcome packet
      // follows within a frame or two.
      await this.waitForWelcome();
    }
    return this.welcomePayload as WelcomePayload;
  }

  private waitForWelcome(timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const started = performance.now();
      const check = () => {
        if (this.welcomePayload) return resolve();
        if (performance.now() - started > timeoutMs) {
          return reject(new Error('the server never sent a welcome packet'));
        }
        requestAnimationFrame(check);
      };
      check();
    });
  }

  private handleDisconnect(reason: string): void {
    if (!this.connected) return;
    this.connected = false;
    this.disconnectReason = reason;
    this.listeners.onDisconnect?.(reason);
  }

  /**
   * Fold an authoritative snapshot into the local mirror and reconcile prediction.
   *
   * The predictor replays whatever input the server has not acknowledged yet, which is
   * what stops the player rubber-banding on every packet.
   */
  private applySnapshot(snapshot: WorldSnapshot): void {
    const applied = this.store.applySnapshot(snapshot);
    if (!applied) return;

    this.clock.onServerTick(snapshot.tick, snapshot.serverTimeMs);
    const now = performance.now();
    this.interpolator.ingest(snapshot, now);
    this.interpolator.prune(now);

    const self = snapshot.self;
    if (!this.hasSpawned) {
      // The first snapshot is a teleport, not a correction: adopt it wholesale so the
      // camera does not fly across the map from (0, 0).
      this.predictor.setPredicted({ x: self.x, y: self.y, vx: self.vx, vy: self.vy });
      this.renderX = self.x;
      this.renderY = self.y;
      this.prevPredX = self.x;
      this.prevPredY = self.y;
      this.predictedFacing = self.facing;
      this.hasSpawned = true;
    } else {
      const result = this.predictor.reconcile(
        { x: self.x, y: self.y, vx: self.vx, vy: self.vy },
        snapshot.ackSeq,
        (state, frame) => this.applyPredictedFrame(state, frame),
      );
      this.lastReconcileInfo = {
        error: result.error,
        ackSeq: snapshot.ackSeq,
        newestSeq: this.predictor.newestSeq,
        pending: this.predictor.pendingFrames().length,
        replayed: result.replayed,
        corrected: result.corrected,
        hardSnapped: result.hardSnapped,
      };
      // A snap is a teleport, not a correction to be smoothed over.
      if (result.hardSnapped) {
        this.renderX = this.predictor.predicted.x;
        this.renderY = this.predictor.predicted.y;
        this.prevPredX = this.predictor.predicted.x;
        this.prevPredY = this.predictor.predicted.y;
      }
    }
    this.listeners.onSnapshot?.(snapshot);
  }

  /**
   * One prediction step. Runs the shared movement function from `@survive/simulation`,
   * which is the whole reason prediction converges instead of fighting the server.
   */
  private applyPredictedFrame(
    state: { x: number; y: number; vx: number; vy: number },
    frame: InputFrame,
  ): void {
    const self = this.store.self;
    if (!self) return;
    const intent = intentFromFrame(frame);
    const moving = Math.abs(intent.moveX) > 0.01 || Math.abs(intent.moveY) > 0.01;
    const mode = resolveMoveMode(intent, self.stamina > 6 && moving);
    const speed = baseSpeedFor(mode) * conditionSpeedMultiplier(self, this.data);
    const body = {
      x: state.x,
      y: state.y,
      vx: state.vx,
      vy: state.vy,
      facing: this.predictedFacing,
    };
    stepMovement(this.predictionWorld, body, intent, speed, SIM_DT);
    state.x = body.x;
    state.y = body.y;
    state.vx = body.vx;
    state.vy = body.vy;
    this.predictedFacing = body.facing;
  }

  /**
   * Call once per rendered frame.
   *
   * Accumulates real time into fixed simulation steps, predicts each one locally and
   * batches the input frames to the server. Batching matters: at 20Hz a per-frame send
   * would be three packets per step at 60fps.
   */
  update(deltaMs: number): void {
    if (!this.connected || !this.store.self) return;

    this.accumulatorMs += deltaMs;
    let steps = 0;
    // Cap catch-up so a browser tab that was backgrounded does not fire a hundred
    // inputs the instant it regains focus.
    while (this.accumulatorMs >= SIM_DT * 1000 && steps < 5) {
      this.accumulatorMs -= SIM_DT * 1000;
      this.stepPrediction();
      steps++;
    }
    if (steps >= 5) this.accumulatorMs = 0;

    // Interpolate across the step in progress, using whatever real time is left over in
    // the accumulator. At a constant velocity the target then advances at exactly that
    // velocity, so there is no per-tick ripple left for the ease to smooth.
    const predicted = this.predictor.predicted;
    const alpha = Math.min(1, Math.max(0, this.accumulatorMs / (SIM_DT * 1000)));
    const targetX = this.prevPredX + (predicted.x - this.prevPredX) * alpha;
    const targetY = this.prevPredY + (predicted.y - this.prevPredY) * alpha;
    // Once per frame, from this frame's delta, so the ease is framerate independent.
    const k = 1 - Math.exp(-deltaMs / RENDER_EASE_MS);
    this.renderX += (targetX - this.renderX) * k;
    this.renderY += (targetY - this.renderY) * k;

    if (steps > 0 && this.connection) {
      // Resend every unacknowledged frame, not just the new ones: a dropped packet
      // would otherwise cost the server a movement step it can never recover.
      this.connection.sendInputs(this.predictor.pendingFrames());
    }

    const now = performance.now();
    if (now - this.lastPingMs > 1000) {
      this.lastPingMs = now;
      this.connection?.sendPing();
    }
  }

  private stepPrediction(): void {
    // Captured before the step, so rendering has both ends of the segment to slide along.
    this.prevPredX = this.predictor.predicted.x;
    this.prevPredY = this.predictor.predicted.y;

    let buttons = 0;
    if (this.intent.primary) buttons |= Button.Primary;
    if (this.intent.secondary) buttons |= Button.Secondary;
    if (this.intent.sprint) buttons |= Button.Sprint;
    if (this.intent.crouch) buttons |= Button.Crouch;
    if (this.intent.interact) buttons |= Button.Interact;
    if (this.intent.reload) buttons |= Button.Reload;
    if (this.intent.block) buttons |= Button.Block;

    this.predictor.pushInput(
      {
        moveX: this.intent.moveX,
        moveY: this.intent.moveY,
        aimAngle: this.intent.aimAngle,
        buttons,
      },
      (state, frame) => this.applyPredictedFrame(state, frame),
    );

    // One-shot intents are consumed by the step that sent them, so a single key press
    // does not repeat for as long as the key is held.
    this.intent.interact = false;
    this.intent.reload = false;
  }

  /**
   * Where to draw the local player this frame.
   *
   * Eased toward the prediction rather than snapped to it. The simulation is a fixed 20 Hz
   * ladder and the display is not, so drawing the rung directly freezes the sprite for most
   * frames and then jumps it a whole tick - and against a camera that eases smoothly (see
   * `GameScene.updateCamera`, which does exactly this) the character appears to shudder
   * backwards inside its own direction of travel.
   *
   * Both an accumulator fraction and an ease, because each fixes what the other cannot.
   *
   * The fraction slides along the step in progress, which is what makes the speed constant:
   * a plain low-pass filter fed a staircase closes most of each step early and coasts at the
   * end, so the drawn speed pulsed between 0.037 and 0.225 px/ms once per tick - a six-fold
   * swing, twenty times a second - even though the underlying motion was perfectly even.
   *
   * The ease then covers what the fraction gets wrong. A frame that runs two simulation
   * steps only has the last one to interpolate across, and a reconciliation correction moves
   * the far end of the segment mid-slide; both are discontinuities, and easing turns them
   * into a glide instead of a jump. The residual lag is about tau x speed, under two pixels
   * at walking pace.
   */
  get renderPosition(): { x: number; y: number } {
    return { x: this.renderX, y: this.renderY };
  }

  /** Send a discrete command. */
  send(command: Command): void {
    this.connection?.sendCommand(command);
  }

  /** Ask the server for chunk terrain the client is missing. */
  requestChunks(keys: readonly ChunkKey[]): void {
    if (keys.length > 0) this.connection?.requestChunks(keys);
  }

  /** Reused so a 900-entity area of interest does not allocate an array per frame. */
  private readonly renderBuffer: RenderEntity[] = [];

  /**
   * Entities to draw this frame, already interpolated.
   *
   * The local player is excluded: it is drawn from `predicted` instead, which is the
   * whole point of prediction.
   *
   * `cull` is the camera's world rectangle. The area of interest is deliberately much
   * larger than the screen - it has to be, or entities would pop in at the edge - so
   * without this the renderer does interpolation and sprite work for hundreds of things
   * nobody can see. Interpolation is skipped for culled entities too, which is safe
   * because they are re-sampled the moment they come back into view.
   */
  entities(nowMs = performance.now(), cull?: Aabb): RenderEntity[] {
    const selfId = this.store.self?.id;
    const out = this.renderBuffer;
    out.length = 0;
    for (const snapshot of this.store.entities()) {
      if (snapshot.id === selfId) continue;

      const base = positionOf(snapshot);
      if (cull && !aabbContainsPoint(cull, base.x, base.y)) continue;

      const sampled = this.interpolator.sample(snapshot.id, nowMs);
      out.push({
        snapshot,
        x: sampled?.x ?? base.x,
        y: sampled?.y ?? base.y,
        facing: sampled?.facing ?? facingOf(snapshot),
      });
    }
    return out;
  }

  /** Structures inside a rectangle, for the lighting pass. */
  structuresIn(cull: Aabb): EntitySnapshot[] {
    const out: EntitySnapshot[] = [];
    for (const snapshot of this.store.entitiesOfKind('structure')) {
      const base = positionOf(snapshot);
      if (!aabbContainsPoint(cull, base.x, base.y)) continue;
      out.push(snapshot);
    }
    return out;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.connection?.leave();
    this.connection = null;
  }
}

/** Position of any entity snapshot, including structures which are tile-based. */
export function positionOf(snapshot: EntitySnapshot): { x: number; y: number } {
  if (snapshot.k === 'structure') {
    return { x: snapshot.tileX * 32 + 16, y: snapshot.tileY * 32 + 16 };
  }
  return { x: snapshot.x, y: snapshot.y };
}

export function facingOf(snapshot: EntitySnapshot): number {
  return 'facing' in snapshot && typeof snapshot.facing === 'number' ? snapshot.facing : 0;
}
