import Phaser from 'phaser';
import type { Command } from '@survive/protocol';
import type { GameData } from '@survive/game-data';
import { Hud } from '../ui/hud';
import { el, injectUiStyles } from '../ui/kit';
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
    this.world.session.send({
      type: 'moveItem',
      from: drag.from,
      fromIndex: drag.index,
      to: target.to,
      toIndex: target.index,
      count: drag.count,
    });
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
  }

  private teardown(): void {
    this.world.events.off('ui-action', this.onUiAction, this);
    for (const id of [...this.openIds]) this.closePanel(id);
    this.root.remove();
  }
}
