import type { GameData } from '@survive/game-data';
import type { Command, ContainerRef } from '@survive/protocol';
import type { GameSession } from '../net/session';

/**
 * The panel contract.
 *
 * Every screen - inventory, crafting, build menu, body, map - is a panel. They are
 * mounted into the UI layer on first open and updated once per UI frame while visible.
 * A panel never mutates game state: it reads `session` and sends commands, exactly like
 * the rest of the client.
 */

export interface UiContext {
  readonly session: GameSession;
  readonly data: GameData;
  /** Phaser's texture manager, for pulling item icons out as data URLs. */
  readonly textures: {
    exists(key: string): boolean;
    get(key: string): { getSourceImage(): unknown };
  };
  /** Send an intent to the server. */
  send(command: Command): void;
  /** Show a transient message in the HUD. */
  toast(text: string): void;
  /** Close a panel by id. */
  close(id: string): void;
  /** Open a panel by id. */
  open(id: string): void;
  /** Whether a panel is currently open. */
  isOpen(id: string): boolean;
  /** Item currently held by the cursor during a drag, if any. */
  drag: DragState | null;
  /** Begin a drag from a container slot. */
  beginDrag(state: DragState): void;
  /** End the current drag, dropping onto the given target (or nowhere). */
  endDrag(target: DropTarget | null): void;
}

/** Where a dragged stack came from. */
export interface DragState {
  from: ContainerRef;
  index: number;
  /** How many units are being dragged, or null for the whole stack. */
  count: number | null;
  defId: string;
}

/** Where a dragged stack is being dropped. */
export interface DropTarget {
  to: ContainerRef;
  /** Target slot, or null to let the server auto-place it. */
  index: number | null;
}

export interface Panel {
  readonly id: string;
  /** Shown in the panel's title bar. */
  readonly title: string;
  /**
   * True when the panel should swallow keyboard and pointer input from the world.
   * An inventory does; a read-only overlay like the debug stats does not.
   */
  readonly captures: boolean;
  /** Build the panel's element. Called once per open. */
  mount(ctx: UiContext): HTMLElement;
  /** Called once per UI frame while open. Keep it cheap or diff internally. */
  update?(ctx: UiContext): void;
  /** Called when the panel closes. */
  unmount?(): void;
}
