import type Phaser from 'phaser';
import { HOTBAR_SLOTS } from '@survive/protocol';

/**
 * Keyboard and mouse.
 *
 * The only place raw input is read. It produces a continuous intent (fed into the
 * session's prediction every fixed step) plus a stream of one-shot *actions* the scenes
 * consume - so a UI panel can swallow a key press without the movement code caring.
 *
 * WASD to move, left click to attack, right click to use/interact (spec section 1).
 */

export type UiAction =
  | { type: 'toggleInventory' }
  | { type: 'toggleCrafting' }
  | { type: 'toggleBuild' }
  | { type: 'toggleHealth' }
  | { type: 'toggleMap' }
  | { type: 'toggleDebug' }
  | { type: 'closeTop' }
  | { type: 'pause' }
  | { type: 'interact' }
  | { type: 'reload' }
  | { type: 'drop' }
  | { type: 'rotateBuild'; delta: number }
  | { type: 'selectHotbar'; index: number }
  | { type: 'cycleHotbar'; delta: number }
  | { type: 'chat' }
  | { type: 'sleep' };

export interface ControlBindings {
  up: string[];
  down: string[];
  left: string[];
  right: string[];
  sprint: string[];
  crouch: string[];
  interact: string[];
  reload: string[];
  block: string[];
  inventory: string[];
  crafting: string[];
  build: string[];
  health: string[];
  map: string[];
  debug: string[];
  drop: string[];
  rotate: string[];
  chat: string[];
  sleep: string[];
  pause: string[];
}

export const DEFAULT_BINDINGS: ControlBindings = {
  up: ['KeyW', 'ArrowUp'],
  down: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  crouch: ['ControlLeft', 'KeyC'],
  interact: ['KeyE'],
  reload: ['KeyR'],
  block: ['Space'],
  inventory: ['KeyI', 'Tab'],
  crafting: ['KeyQ'],
  build: ['KeyB'],
  health: ['KeyH'],
  map: ['KeyM'],
  debug: ['F3'],
  drop: ['KeyG'],
  rotate: ['KeyT'],
  chat: ['KeyY', 'Enter'],
  sleep: ['KeyZ'],
  pause: ['Escape'],
};

/**
 * True when a keystroke belongs to a text field rather than to the game.
 *
 * Checking the event target rather than tracking a mode means chat, the world-name box
 * and any future text input all work without anyone remembering to flip a flag.
 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** The continuous half of the input, sampled every frame. */
export interface IntentSample {
  moveX: number;
  moveY: number;
  sprint: boolean;
  crouch: boolean;
  primary: boolean;
  secondary: boolean;
  block: boolean;
  /**
   * Whether the interact key is still held.
   *
   * Interact itself is a one-shot action, but gathering repeats on a cooldown while the key
   * is down, so the caller needs the held state as well as the press. See
   * `GameScene.repeatGather`.
   */
  interactHeld: boolean;
  /** Pointer position in world space. */
  pointerWorldX: number;
  pointerWorldY: number;
  /** Pointer position in screen space, for placing DOM overlays under the cursor. */
  pointerScreenX: number;
  pointerScreenY: number;
  aimAngle: number;
}

export class Controls {
  private readonly pressed = new Set<string>();
  private readonly actions: UiAction[] = [];
  private pointerPrimary = false;
  private pointerSecondary = false;
  /**
   * A left press that has happened but not yet been read.
   *
   * Latched here rather than derived from {@link sample}'s `primary`, because a press is an
   * event and `primary` is a state read once a frame. A click whose down and up land inside
   * one frame - which is every synthetic click, and a fast real one on a slow frame - sets
   * the state true and false again before anything looks at it, and is simply lost.
   */
  private primaryPressed = false;
  private pointerScreenX = 0;
  private pointerScreenY = 0;
  private bindings: ControlBindings;
  /** While true, keys go to a text field and not to the game. */
  private textEntry = false;
  private readonly detach: Array<() => void> = [];

  constructor(
    private readonly scene: Phaser.Scene,
    bindings: ControlBindings = DEFAULT_BINDINGS,
  ) {
    this.bindings = bindings;
    this.attach();
  }

  /** Replace the key bindings at runtime. */
  setBindings(bindings: ControlBindings): void {
    this.bindings = bindings;
  }

  /**
   * Route keys to a text field instead of the game.
   *
   * This is for a *text field*, not for "a panel is open": a panel still wants its own
   * hotkey to close it. Focus-based detection in {@link isEditableTarget} covers the
   * normal case, so this is only needed for a widget that captures typing without
   * focusing a real input.
   */
  setTextEntry(active: boolean): void {
    this.textEntry = active;
    if (active) this.pressed.clear();
  }

  private attach(): void {
    const canvas = this.scene.game.canvas;

    const onKeyDown = (event: KeyboardEvent) => {
      // Someone is typing: the game must not read their keystrokes as movement, but
      // Escape still has to get through so they can leave the field.
      if (this.textEntry || isEditableTarget(event.target)) {
        if (event.code === 'Escape') this.actions.push({ type: 'closeTop' });
        return;
      }
      // Tab would move focus out of the canvas; F-keys would open browser menus.
      if (event.code === 'Tab' || event.code === 'F3') event.preventDefault();
      if (event.repeat) return;
      this.pressed.add(event.code);
      this.handleActionKey(event.code, event);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      this.pressed.delete(event.code);
    };
    const onBlur = () => {
      // Losing focus mid-sprint must not leave the player running forever.
      this.pressed.clear();
      this.pointerPrimary = false;
      this.pointerSecondary = false;
      this.primaryPressed = false;
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    this.detach.push(() => window.removeEventListener('keydown', onKeyDown));
    this.detach.push(() => window.removeEventListener('keyup', onKeyUp));
    this.detach.push(() => window.removeEventListener('blur', onBlur));

    const onContextMenu = (event: Event) => event.preventDefault();
    canvas.addEventListener('contextmenu', onContextMenu);
    this.detach.push(() => canvas.removeEventListener('contextmenu', onContextMenu));

    this.scene.input.on('pointerdown', this.onPointerDown, this);
    this.scene.input.on('pointerup', this.onPointerUp, this);
    this.scene.input.on('pointermove', this.onPointerMove, this);
    this.scene.input.on('wheel', this.onWheel, this);
    this.detach.push(() => {
      this.scene.input.off('pointerdown', this.onPointerDown, this);
      this.scene.input.off('pointerup', this.onPointerUp, this);
      this.scene.input.off('pointermove', this.onPointerMove, this);
      this.scene.input.off('wheel', this.onWheel, this);
    });
  }

  private handleActionKey(code: string, event: KeyboardEvent): void {
    const { bindings } = this;
    const matches = (keys: string[]) => keys.includes(code);

    // Number keys pick a hotbar slot directly.
    if (/^Digit[1-9]$/.test(code)) {
      const index = Number(code.slice(5)) - 1;
      if (index < HOTBAR_SLOTS) this.actions.push({ type: 'selectHotbar', index });
      return;
    }

    if (matches(bindings.pause)) this.actions.push({ type: 'pause' });
    else if (matches(bindings.inventory)) this.actions.push({ type: 'toggleInventory' });
    else if (matches(bindings.crafting)) this.actions.push({ type: 'toggleCrafting' });
    else if (matches(bindings.build)) this.actions.push({ type: 'toggleBuild' });
    else if (matches(bindings.health)) this.actions.push({ type: 'toggleHealth' });
    else if (matches(bindings.map)) this.actions.push({ type: 'toggleMap' });
    else if (matches(bindings.debug)) this.actions.push({ type: 'toggleDebug' });
    else if (matches(bindings.interact)) this.actions.push({ type: 'interact' });
    else if (matches(bindings.reload)) this.actions.push({ type: 'reload' });
    else if (matches(bindings.drop)) this.actions.push({ type: 'drop' });
    else if (matches(bindings.sleep)) this.actions.push({ type: 'sleep' });
    else if (matches(bindings.rotate)) {
      this.actions.push({ type: 'rotateBuild', delta: event.shiftKey ? -1 : 1 });
    } else if (matches(bindings.chat)) this.actions.push({ type: 'chat' });
  }

  private onPointerDown(pointer: Phaser.Input.Pointer): void {
    this.pointerScreenX = pointer.x;
    this.pointerScreenY = pointer.y;
    if (pointer.leftButtonDown()) {
      this.pointerPrimary = true;
      this.primaryPressed = true;
    }
    if (pointer.rightButtonDown()) this.pointerSecondary = true;
  }

  private onPointerUp(pointer: Phaser.Input.Pointer): void {
    if (pointer.leftButtonReleased()) this.pointerPrimary = false;
    if (pointer.rightButtonReleased()) this.pointerSecondary = false;
  }

  private onPointerMove(pointer: Phaser.Input.Pointer): void {
    this.pointerScreenX = pointer.x;
    this.pointerScreenY = pointer.y;
  }

  private onWheel(_pointer: Phaser.Input.Pointer, _over: unknown, _dx: number, dy: number): void {
    if (dy === 0) return;
    this.actions.push({ type: 'cycleHotbar', delta: dy > 0 ? 1 : -1 });
  }

  isDown(codes: string[]): boolean {
    for (const code of codes) if (this.pressed.has(code)) return true;
    return false;
  }

  /**
   * Sample the continuous input.
   *
   * `originX`/`originY` are the player's world position: aim is the angle from the
   * player to the cursor, which is what makes mouse-aimed melee and shooting work.
   */
  sample(camera: Phaser.Cameras.Scene2D.Camera, originX: number, originY: number): IntentSample {
    const { bindings } = this;
    let moveX = 0;
    let moveY = 0;
    if (this.isDown(bindings.left)) moveX -= 1;
    if (this.isDown(bindings.right)) moveX += 1;
    if (this.isDown(bindings.up)) moveY -= 1;
    if (this.isDown(bindings.down)) moveY += 1;

    const world = camera.getWorldPoint(this.pointerScreenX, this.pointerScreenY);
    const aimAngle = Math.atan2(world.y - originY, world.x - originX);

    return {
      moveX,
      moveY,
      sprint: this.isDown(bindings.sprint),
      crouch: this.isDown(bindings.crouch),
      primary: this.pointerPrimary,
      secondary: this.pointerSecondary,
      block: this.isDown(bindings.block),
      interactHeld: this.isDown(bindings.interact),
      pointerWorldX: world.x,
      pointerWorldY: world.y,
      pointerScreenX: this.pointerScreenX,
      pointerScreenY: this.pointerScreenY,
      aimAngle,
    };
  }

  /**
   * Whether the left button was pressed since this was last asked. Clears the latch.
   *
   * For things a click *does once* - placing a building - as opposed to what a held button
   * means, which is {@link IntentSample.primary}.
   */
  takePrimaryPress(): boolean {
    const pressed = this.primaryPressed;
    this.primaryPressed = false;
    return pressed;
  }

  /** Take the queued one-shot actions. */
  drainActions(): UiAction[] {
    if (this.actions.length === 0) return [];
    return this.actions.splice(0, this.actions.length);
  }

  /** Suppress pointer state, e.g. when a click landed on a UI panel. */
  consumePointer(): void {
    this.pointerPrimary = false;
    this.pointerSecondary = false;
    // The latch too, or a click that landed on a panel places a building on the next frame.
    this.primaryPressed = false;
  }

  destroy(): void {
    for (const detach of this.detach) detach();
    this.detach.length = 0;
    this.pressed.clear();
    this.actions.length = 0;
    this.primaryPressed = false;
  }
}
