import Phaser from 'phaser';
import type { Command, PlayerState } from '@survive/protocol';
import type { GameData } from '@survive/game-data';
import { Hud } from '../ui/hud';
import { el, entityName, injectUiStyles, worldTooltip } from '../ui/kit';
import {
  destroyTooltip,
  hideFocusLabel,
  hideTooltip,
  pruneTooltip,
  showFocusLabel,
  showTooltip,
} from '../ui/tooltip';
import type { DragState, DropTarget, Panel, UiContext } from '../ui/panel';
import { createPanels } from '../ui/panels';
import type { GameScene } from './GameScene';
import type { UiAction } from '../input/controls';

/**
 * The interface layer.
 *
 * Runs alongside {@link GameScene} rather than inside it, so the world keeps rendering
 * while a panel is open and neither scene has to know much about the other. All the
 * actual widgets are DOM (see `ui/kit.ts` for why); this scene owns their lifecycle and
 * decides when the world should stop listening to the keyboard.
 */
/** Owner token for the world tooltip, so DOM tooltips and this one can hand off cleanly. */
const WORLD_TOOLTIP = Symbol('world-tooltip');

export class UiScene extends Phaser.Scene {
  static readonly KEY = 'Ui';

  /** The world scene. Named `world` because Phaser.Scene already owns `game`. */
  private world!: GameScene;
  private hud!: Hud;
  private root!: HTMLDivElement;
  private panelLayer!: HTMLDivElement;
  private readonly panels = new Map<string, Panel>();
  private readonly mounted = new Map<string, HTMLElement>();
  private readonly openIds = new Set<string>();
  private drag: DragState | null = null;
  private ctx!: UiContext;

  constructor() {
    super(UiScene.KEY);
  }

  create(): void {
    this.world = this.registry.get('gameScene') as GameScene;
    injectUiStyles();

    this.hud = new Hud();
    this.panelLayer = el('div', { className: 'panel-layer' });
    this.root = el('div', { className: 'ui-root', children: [this.hud.root, this.panelLayer] });
    document.body.append(this.root);

    this.ctx = {
      session: this.world.session,
      data: this.registry.get('gameData') as GameData,
      textures: this.textures as unknown as UiContext['textures'],
      send: (command: Command) => this.world.session.send(command),
      toast: (text: string) => this.hud.toast(text, performance.now()),
      close: (id: string) => this.closePanel(id),
      open: (id: string) => this.openPanel(id),
      isOpen: (id: string) => this.openIds.has(id),
      get drag() {
        return null;
      },
      beginDrag: (state: DragState) => {
        this.drag = state;
      },
      endDrag: (target: DropTarget | null) => this.completeDrag(target),
    };
    // The getter above cannot close over `this.drag` reactively through an object
    // literal, so redefine it against the live field.
    Object.defineProperty(this.ctx, 'drag', {
      get: () => this.drag,
      enumerable: true,
    });

    for (const panel of createPanels()) this.panels.set(panel.id, panel);

    this.world.events.on('ui-action', this.onUiAction, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.teardown());
  }

  /** Panel ids currently open, for the debug overlay. */
  get openPanelIds(): string[] {
    return [...this.openIds];
  }

  private onUiAction(action: UiAction): void {
    switch (action.type) {
      case 'toggleInventory':
        this.togglePanel('inventory');
        break;
      case 'toggleCrafting':
        this.togglePanel('crafting');
        break;
      case 'toggleBuild':
        this.togglePanel('build');
        break;
      case 'toggleHealth':
        this.togglePanel('body');
        break;
      case 'toggleMap':
        this.togglePanel('map');
        break;
      case 'toggleDebug':
        this.togglePanel('debug');
        break;
      case 'chat':
        this.togglePanel('chat');
        break;
      case 'pause':
        // ESC closes the top panel if one is open; otherwise it opens the pause menu,
        // which in single player also pauses the server (spec section 12).
        if (this.openIds.size > 0) this.closeTopPanel();
        else this.togglePanel('pause');
        break;
      case 'closeTop':
        this.closeTopPanel();
        break;
      default:
        break;
    }
  }

  togglePanel(id: string): void {
    if (this.openIds.has(id)) this.closePanel(id);
    else this.openPanel(id);
  }

  openPanel(id: string): void {
    const panel = this.panels.get(id);
    if (!panel || this.openIds.has(id)) return;
    const element = panel.mount(this.ctx);
    this.panelLayer.append(element);
    this.mounted.set(id, element);
    this.openIds.add(id);
    this.syncCapture();
  }

  closePanel(id: string): void {
    if (!this.openIds.has(id)) return;
    this.panels.get(id)?.unmount?.();
    this.mounted.get(id)?.remove();
    this.mounted.delete(id);
    this.openIds.delete(id);
    // Closing the container panel has to tell the server, or the player stays "in" a
    // chest they have walked away from.
    if (id === 'container') this.world.session.send({ type: 'closeContainer' });
    if (id === 'pause') this.world.session.send({ type: 'setPaused', paused: false });
    this.syncCapture();
  }

  private closeTopPanel(): void {
    const last = [...this.openIds].pop();
    if (last) this.closePanel(last);
  }

  /** Any capturing panel takes the keyboard and pointer away from the world. */
  private syncCapture(): void {
    let captured = false;
    for (const id of this.openIds) {
      if (this.panels.get(id)?.captures) captured = true;
    }
    this.world.setUiCaptured(captured);
  }

  private completeDrag(target: DropTarget | null): void {
    const drag = this.drag;
    this.drag = null;
    if (!drag) return;
    if (!target) {
      // Dropped on nothing: put it on the ground, which is what the gesture implies.
      this.world.session.send({
        type: 'dropItem',
        ref: drag.from,
        index: drag.index,
        count: drag.count,
      });
      return;
    }
    if (target.to === 'hotbar') {
      // Binding a key, not moving an item: the stack stays exactly where it is. Only an
      // inventory slot can be bound, because that is all a hotbar entry can point at.
      if (drag.from.kind !== 'inventory') return;
      this.world.session.send({
        type: 'assignHotbar',
        hotbarIndex: target.index,
        inventorySlot: drag.index,
      });
      return;
    }
    this.world.session.send({
      type: 'moveItem',
      from: drag.from,
      fromIndex: drag.index,
      to: target.to,
      toIndex: target.index,
      count: drag.count,
    });
  }

  /**
   * Offer a number key to the open panels before the world acts on it.
   *
   * The world's meaning for a digit is "select this hotbar slot". A panel can claim it for
   * something else - the inventory assigns the item under the cursor - and the first one to
   * claim it wins.
   */
  claimHotbarDigit(index: number): boolean {
    for (const id of this.openIds) {
      if (this.panels.get(id)?.hotbarDigit?.(this.ctx, index)) return true;
    }
    return false;
  }

  override update(): void {
    const session = this.world.session;
    const self = session.self;

    for (const text of this.world.effects.drainToasts()) {
      this.hud.toast(text, performance.now());
    }

    this.hud.update(
      this.ctx,
      self,
      session.time,
      session.weather,
      this.world.focusEntity(),
      session.latencyMs,
      performance.now(),
    );

    // The server opening a container for us should open the panel; closing it should
    // close the panel. The snapshot is the authority either way.
    const container = session.store.container;
    if (container && !this.openIds.has('container')) this.openPanel('container');
    else if (!container && this.openIds.has('container')) this.closePanel('container');

    // Dying takes over the screen; respawning gives it back.
    if (self && !self.alive && !this.openIds.has('death')) this.openPanel('death');
    else if (self?.alive && this.openIds.has('death')) this.closePanel('death');

    for (const id of this.openIds) this.panels.get(id)?.update?.(this.ctx);

    this.updateWorldTooltip(self);
    this.updateFocusLabel();
  }

  /**
   * The name of whatever the interact key is aimed at, over the interaction ring.
   *
   * The ring already says *that* something is targeted; standing in a thicket it does not
   * say which bush. Independent of the hover tooltip, and both can be up at once - the
   * cursor is usually not pointing at the thing the player is standing next to.
   */
  private updateFocusLabel(): void {
    const focus = this.world.focusLabelTarget();
    if (!focus) {
      hideFocusLabel();
      return;
    }
    showFocusLabel(entityName(focus.snapshot, this.ctx.data), focus.screenX, focus.screenY);
  }

  /**
   * The tooltip for whatever the cursor is over in the world.
   *
   * Driven from here rather than from pointer events, because the target moves on its own:
   * a zombie walks under a still cursor, a tree scrolls past as the player runs. Polling the
   * hover target once a frame is what makes the tooltip follow the world instead of only the
   * mouse.
   *
   * `WORLD_TOOLTIP` owns the layer while it is showing, so a DOM slot the cursor moves onto
   * takes it over cleanly and the two do not fight for it every frame.
   */
  private updateWorldTooltip(self: PlayerState | null): void {
    // A tooltip whose element has been removed - a panel closed under the cursor - would
    // otherwise sit there for good, because the cursor never leaves what is no longer there.
    pruneTooltip();
    const hover = this.world.hoverTarget();
    const text = hover ? worldTooltip(hover.snapshot, this.ctx.data, self) : null;
    if (!hover || !text) {
      hideTooltip(WORLD_TOOLTIP);
      return;
    }
    showTooltip(WORLD_TOOLTIP, text, hover.screenX, hover.screenY);
  }

  private teardown(): void {
    this.world.events.off('ui-action', this.onUiAction, this);
    for (const id of [...this.openIds]) this.closePanel(id);
    this.root.remove();
    destroyTooltip();
  }
}
