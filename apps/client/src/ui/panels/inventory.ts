import {
  EQUIP_SLOTS,
  type ContainerRef,
  type EquipSlot,
  type ItemStack,
  type PlayerState,
} from '@survive/protocol';
import type { ItemDef } from '@survive/game-data';
import { UI, cssColor } from '../../art/palette';
import { button, el, humanize, itemSlot, itemTooltip, panelFrame, statBar } from '../kit';
import { attachTooltip } from '../tooltip';
import type { Panel, UiContext } from '../panel';

/**
 * The inventory panel: the bag on the right, what the player is wearing on the left.
 *
 * This is the screen players live in, so three properties matter more than features:
 *
 * 1. **It never decides anything.** Every gesture becomes an intent - `moveItem`,
 *    `equipItem`, `unequipItem`, `useItem`, `splitStack`, `dropItem`, `sortContainer` -
 *    and the next snapshot is what redraws the grid. Nothing here subtracts a count,
 *    swaps two stacks locally or predicts an equip. The few places that *read* content
 *    (is this equippable? is this usable?) mirror the simulation's own predicates so a
 *    left click lands on a command the server will accept; when the two disagree the
 *    server wins and its rejection surfaces as a HUD toast.
 * 2. **It diffs before it draws.** `update` runs every rendered frame. Forty slots of
 *    `<img>` rebuilt at 60fps is visible jank, so the paper doll plus the grid share one
 *    signature over exactly what they render, and the footer carries its own.
 * 3. **Drag and drop is the shared kind.** Drags are routed through `ctx.beginDrag` /
 *    `ctx.endDrag` rather than kept locally, which is what lets a stack travel from this
 *    grid into a chest panel that this file has never heard of. A drag that ends on
 *    nothing calls `ctx.endDrag(null)`, and the UI layer turns that into `dropItem` -
 *    dropping an item by flinging it out of the window is the gesture players expect.
 */

/** The bag. One constant object: it is only ever read and serialised into a command. */
const INVENTORY_REF: ContainerRef = { kind: 'inventory' };

/** Equipment refs address a single slot, so the index is always 0. */
const EQUIPMENT_INDEX = 0;

/** How many columns the bag grid uses. Matches `.grid` in the shared stylesheet. */
const GRID_COLUMNS = 8;

/**
 * Human labels for the equip slots.
 *
 * Not `humanize()`: these ids are camelCase, so `mainHand` would come out as "MainHand".
 */
const SLOT_LABEL: Record<EquipSlot, string> = {
  head: 'Head',
  face: 'Face',
  chest: 'Chest',
  legs: 'Legs',
  feet: 'Feet',
  hands: 'Hands',
  back: 'Back',
  mainHand: 'Main Hand',
  offHand: 'Off Hand',
};

/** Every action the right-click menu can offer. Also the suffix of its `data-testid`. */
type MenuActionId = 'use' | 'equip' | 'unequip' | 'split' | 'drop' | 'dropAll';

interface MenuAction {
  id: MenuActionId;
  label: string;
  /** Rendered with the danger variant: these ones put your things on the floor. */
  destructive?: boolean;
  run(): void;
}

/** A slot the player has just interacted with, and the stack that was in it. */
type SlotTarget =
  | { kind: 'inventory'; index: number; stack: ItemStack }
  | { kind: 'equipment'; slot: EquipSlot; stack: ItemStack };

const STYLE_ID = 'survive-inventory-styles';

/**
 * Panel-local styles.
 *
 * Injected from here behind a guarded id rather than added to `kit.ts`: the paper doll is
 * a layout nothing else in the interface needs. Everything shared - `.panel`, `.grid`,
 * `.slot`, `.bar`, `.btn`, `.row`, `.col`, `.muted`, `.section-title`, `.effect-chip` -
 * is reused untouched.
 *
 * The two `pointer-events: none` rules matter more than they look. A slot's icon and
 * count are children of the slot button, and a child under the cursor makes HTML5 drag
 * fire `dragleave`/`dragenter` pairs as the pointer crosses it, which flickers the drop
 * highlight; taking the children out of hit testing also guarantees every click and
 * every `dragstart` reports the button as its target. They out-specify the shared
 * `.ui-root .slot { pointer-events: auto }` on purpose.
 */
function injectInventoryStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .panel--inv { width: min(760px, 95vw); }
    .inv-body { display: flex; gap: 18px; align-items: flex-start; }
    .inv-left { flex: none; display: flex; flex-direction: column; gap: 6px; }
    .inv-right { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
    .inv-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .inv-head .section-title { margin: 0; }
    .inv-head .btn { padding: 4px 10px; font-size: 11px; }

    /* Laid out like a body: head on top, hands to the sides, boots at the bottom. */
    .inv-doll {
      display: grid; grid-template-columns: repeat(3, 60px); gap: 6px 8px;
      grid-template-areas:
        ".        head   ."
        "face     chest  back"
        "mainHand hands  offHand"
        ".        legs   ."
        ".        feet   .";
    }
    .inv-doll-cell { display: flex; flex-direction: column; align-items: center; gap: 2px; }
    .inv-doll-label {
      font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em;
      color: ${cssColor(UI.textMuted)}; text-align: center; white-space: nowrap;
    }

    .inv-slot {
      display: block; padding: 0; margin: 0; border: 0; background: none;
      font: inherit; color: inherit; cursor: pointer; border-radius: 4px;
    }
    .inv-slot:focus-visible { outline: 2px solid ${cssColor(UI.accent)}; outline-offset: 1px; }
    .ui-root .inv-slot > * { pointer-events: none; }
    .ui-root .inv-slot .slot { pointer-events: none; }
    .inv-slot--over .slot { outline: 1px dashed ${cssColor(UI.accent, 0.85)}; outline-offset: 1px; }
    .inv-slot--source .slot { opacity: 0.45; }

    .inv-grid-wrap { overflow: auto; max-height: 44vh; padding: 1px; }
    .inv-footer {
      display: flex; flex-direction: column; gap: 5px; padding-top: 8px;
      border-top: 1px solid ${cssColor(UI.panelEdge)};
    }
    .inv-load { font-family: monospace; font-size: 11px; }
    .inv-hint { font-size: 10px; line-height: 1.5; }

    .inv-menu {
      position: fixed; z-index: 20; min-width: 132px; padding: 4px;
      display: flex; flex-direction: column; gap: 2px;
      background: ${cssColor(UI.panel, 0.98)};
      border: 1px solid ${cssColor(UI.panelEdge)}; border-radius: 5px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.55);
    }
    .inv-menu-title {
      padding: 2px 6px 4px; font-size: 10px; text-transform: uppercase;
      letter-spacing: 0.06em; color: ${cssColor(UI.textMuted)};
      border-bottom: 1px solid ${cssColor(UI.panelEdge)}; margin-bottom: 2px;
    }
    .inv-menu .btn {
      text-align: left; padding: 5px 8px; font-size: 12px; font-weight: 500;
      background: transparent; border-color: transparent;
    }
    .inv-menu .btn:hover:not(:disabled) { background: ${cssColor(UI.slotHover)}; }
  `;
  document.head.append(style);
}

/**
 * The slot an item wants when the player equips it without naming one.
 *
 * Mirrors `defaultEquipSlot` in `@survive/simulation`. Duplicated as four lines of
 * content inspection rather than imported, because the UI layer has no business pulling
 * in the simulation (Architecture Guard rules 1 and 2) - and the cost of being wrong is
 * only ever a command the server refuses with a reason the HUD prints.
 */
function equipTargetFor(def: ItemDef): EquipSlot | null {
  if (def.armor) return def.armor.slot;
  if (def.weapon) return 'mainHand';
  if (def.tool) return 'mainHand';
  if (def.containerSlots) return 'back';
  return null;
}

/**
 * Whether `useItem` will do anything with this definition.
 *
 * Mirrors the simulation's `isConsumable`, plus the two cases `useItem` handles before
 * it: a placeable arms the build ghost and a seed tells the player where to plant it. A
 * vessel counts even when empty - the server's refusal ("it is empty") is more useful
 * than a greyed-out menu entry.
 */
function isUsable(def: ItemDef): boolean {
  if (def.placesStructureDefId !== undefined || def.cropDefId !== undefined) return true;
  return Boolean(def.food ?? def.drink ?? def.medical) || (def.liquid?.capacity ?? 0) > 0;
}

function displayName(ctx: UiContext, defId: string): string {
  return ctx.data.items.get(defId)?.name ?? humanize(defId);
}

function refOf(target: SlotTarget): ContainerRef {
  return target.kind === 'inventory' ? INVENTORY_REF : { kind: 'equipment', slot: target.slot };
}

function indexOf(target: SlotTarget): number {
  return target.kind === 'inventory' ? target.index : EQUIPMENT_INDEX;
}

/**
 * A stack's contribution to the render signature.
 *
 * Covers exactly the fields `itemSlot` draws, and no more: id, count, the durability and
 * freshness bars and the ammo counter. Durability is rounded and freshness quantised to
 * whole percent so a bar that drifts by a thousandth per tick does not rebuild forty
 * slots on the way down.
 */
function stackSignature(stack: ItemStack | null): string {
  if (!stack) return '-';
  const durability = stack.durability === undefined ? '' : Math.round(stack.durability);
  const freshness = stack.freshness === undefined ? '' : Math.round(stack.freshness * 100);
  const ammo = stack.ammo === undefined ? '' : stack.ammo;
  return `${stack.defId}*${stack.count}/${durability}/${freshness}/${ammo}`;
}

/**
 * Which hotbar key points at each inventory slot.
 *
 * Shown as the slot badge so the player can see that the axe is on 2 without leaving the
 * panel. Only the *assignment* feeds the signature, never `activeHotbar`: highlighting
 * the live selection here would rebuild the whole grid on every number key.
 */
function hotbarBadges(player: PlayerState): Map<number, string> {
  const badges = new Map<number, string>();
  player.hotbar.forEach((slotIndex, hotbarIndex) => {
    if (slotIndex === null) return;
    if (badges.has(slotIndex)) return;
    badges.set(slotIndex, String(hotbarIndex + 1));
  });
  return badges;
}

export function createInventoryPanel(): Panel {
  /** Set once the panel is mounted; the context menu is parented to it. */
  let rootNode: HTMLDivElement | null = null;

  /**
   * The context passed to the most recent `mount`/`update`.
   *
   * The persistent chrome (the Sort button) outlives any single frame, so it reads the
   * context from here instead of closing over the one that happened to build it.
   */
  let activeCtx: UiContext | null = null;

  let menuNode: HTMLDivElement | null = null;
  let detachMenuListeners: (() => void) | null = null;

  let contentSignature = '';
  let footerSignature = '';

  interface Parts {
    doll: HTMLDivElement;
    grid: HTMLDivElement;
    footer: HTMLDivElement;
    /** The Sort button, kept because it outlives any single rebuild. */
    sort: HTMLButtonElement;
    body: HTMLDivElement;
  }
  let parts: Parts | null = null;

  // -------------------------------------------------------------------------
  // Context menu
  // -------------------------------------------------------------------------

  function closeMenu(): void {
    menuNode?.remove();
    menuNode = null;
    detachMenuListeners?.();
    detachMenuListeners = null;
  }

  /** Keep the menu on screen when the click was near the right or bottom edge. */
  function positionMenu(node: HTMLElement, clientX: number, clientY: number): void {
    node.style.left = '0px';
    node.style.top = '0px';
    const rect = node.getBoundingClientRect();
    const left = Math.max(4, Math.min(clientX, window.innerWidth - rect.width - 8));
    const top = Math.max(4, Math.min(clientY, window.innerHeight - rect.height - 8));
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
  }

  /**
   * The actions that actually apply to one stack.
   *
   * Entries are omitted rather than disabled: a four-item menu the player can trust is
   * worth more than a six-item menu with two dead rows. `Split` is inventory-only
   * because the simulation refuses to split an equipment slot, and `Equip` is
   * inventory-only because equipment is already equipped.
   */
  function actionsFor(ctx: UiContext, target: SlotTarget): MenuAction[] {
    const def = ctx.data.items.get(target.stack.defId) ?? null;
    const ref = refOf(target);
    const index = indexOf(target);
    const actions: MenuAction[] = [];

    if (def && isUsable(def)) {
      actions.push({
        id: 'use',
        label: 'Use',
        run: () => ctx.send({ type: 'useItem', ref, index }),
      });
    }

    if (target.kind === 'inventory') {
      const slot = def ? equipTargetFor(def) : null;
      if (slot) {
        actions.push({
          id: 'equip',
          label: `Equip · ${SLOT_LABEL[slot]}`,
          run: () => ctx.send({ type: 'equipItem', inventorySlot: target.index, slot }),
        });
      }
    } else {
      actions.push({
        id: 'unequip',
        label: 'Unequip',
        run: () => ctx.send({ type: 'unequipItem', slot: target.slot }),
      });
    }

    if (target.kind === 'inventory' && target.stack.count > 1) {
      const half = Math.floor(target.stack.count / 2);
      actions.push({
        id: 'split',
        label: `Split · ${half}`,
        run: () => ctx.send({ type: 'splitStack', ref, index, count: half }),
      });
    }

    if (target.stack.count > 1) {
      actions.push({
        id: 'drop',
        label: 'Drop',
        run: () => ctx.send({ type: 'dropItem', ref, index, count: 1 }),
      });
      actions.push({
        id: 'dropAll',
        label: `Drop All · ${target.stack.count}`,
        destructive: true,
        run: () => ctx.send({ type: 'dropItem', ref, index, count: null }),
      });
    } else {
      actions.push({
        id: 'drop',
        label: 'Drop',
        destructive: true,
        run: () => ctx.send({ type: 'dropItem', ref, index, count: null }),
      });
    }

    return actions;
  }

  /**
   * Open the menu at the cursor.
   *
   * The close listeners are registered here, during the `contextmenu` dispatch that
   * opened it, which is safe: the right click's own `mousedown` has already been and
   * gone, so nothing closes the menu before the player sees it. They are capture-phase on
   * `window` because Escape is also the game's "close the top panel" key - swallowing it
   * here means the first Escape dismisses the menu and the second closes the inventory,
   * which is the order a player expects.
   */
  function openMenu(ctx: UiContext, event: MouseEvent, target: SlotTarget): void {
    closeMenu();
    const host = rootNode;
    if (!host) return;
    const actions = actionsFor(ctx, target);
    if (actions.length === 0) return;

    const node = el('div', {
      className: 'inv-menu',
      attrs: {
        role: 'menu',
        'aria-label': `Actions for ${displayName(ctx, target.stack.defId)}`,
        'data-testid': 'inventory-menu',
      },
      children: [
        el('div', { className: 'inv-menu-title', text: displayName(ctx, target.stack.defId) }),
        ...actions.map((action) => {
          const item = button(
            action.label,
            () => {
              action.run();
              closeMenu();
            },
            action.destructive ? 'danger' : 'default',
          );
          item.setAttribute('role', 'menuitem');
          item.setAttribute('data-testid', `inventory-menu-${action.id}`);
          return item;
        }),
      ],
    });

    const onPointerDown = (pointer: Event) => {
      // A click inside the menu is the menu being used; let it through so the button's
      // own click handler runs and closes it afterwards.
      if (pointer.target instanceof Node && node.contains(pointer.target)) return;
      closeMenu();
    };
    const onKeyDown = (key: KeyboardEvent) => {
      if (key.key !== 'Escape') return;
      key.preventDefault();
      key.stopPropagation();
      closeMenu();
    };
    window.addEventListener('mousedown', onPointerDown, true);
    window.addEventListener('contextmenu', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    detachMenuListeners = () => {
      window.removeEventListener('mousedown', onPointerDown, true);
      window.removeEventListener('contextmenu', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };

    menuNode = node;
    host.append(node);
    // Measure only once it is in the document, then place it.
    positionMenu(node, event.clientX, event.clientY);
    node.querySelector<HTMLButtonElement>('button')?.focus();
  }

  // -------------------------------------------------------------------------
  // Drag and drop
  // -------------------------------------------------------------------------

  function clearDropHighlights(): void {
    if (!rootNode) return;
    for (const node of rootNode.querySelectorAll('.inv-slot--over, .inv-slot--source')) {
      node.classList.remove('inv-slot--over', 'inv-slot--source');
    }
  }

  /**
   * Make a filled slot draggable.
   *
   * Shift halves the stack by passing a `count`; a plain drag passes `null`, which the
   * `moveItem` command reads as "the whole stack". Nothing is moved here - `beginDrag`
   * only records where the gesture started.
   */
  function bindDragSource(
    node: HTMLElement,
    ctx: UiContext,
    ref: ContainerRef,
    index: number,
    stack: ItemStack,
  ): void {
    node.draggable = true;
    node.addEventListener('dragstart', (event: DragEvent) => {
      closeMenu();
      const count = event.shiftKey && stack.count > 1 ? Math.floor(stack.count / 2) : null;
      ctx.beginDrag({ from: ref, index, count, defId: stack.defId });
      // Firefox refuses to start a drag with an empty dataTransfer.
      event.dataTransfer?.setData('text/plain', stack.defId);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      node.classList.add('inv-slot--source');
    });
    node.addEventListener('dragend', () => {
      // Nobody accepted the drop: the gesture means "put it on the ground", which is
      // exactly what `endDrag(null)` sends. If a slot did accept it, the drag is already
      // finished and `ctx.drag` is null.
      if (ctx.drag) ctx.endDrag(null);
      clearDropHighlights();
    });
  }

  /**
   * Make a slot accept a drop.
   *
   * Deliberately indifferent to where the drag started: the only test is "is a drag in
   * flight", so a stack coming out of a chest panel or the ground lands here on the same
   * code path. Whether the move is legal is the server's call.
   */
  function bindDropTarget(
    node: HTMLElement,
    ctx: UiContext,
    ref: ContainerRef,
    index: number,
  ): void {
    node.addEventListener('dragover', (event: DragEvent) => {
      if (!ctx.drag) return;
      // Without preventDefault the browser will not fire `drop` at all.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      node.classList.add('inv-slot--over');
    });
    node.addEventListener('dragleave', () => node.classList.remove('inv-slot--over'));
    node.addEventListener('drop', (event: DragEvent) => {
      event.preventDefault();
      // Stop the panel behind from also treating this as a drop onto nothing.
      event.stopPropagation();
      node.classList.remove('inv-slot--over');
      if (!ctx.drag) return;
      ctx.endDrag({ to: ref, index });
      clearDropHighlights();
    });
  }

  // -------------------------------------------------------------------------
  // Slot rendering
  // -------------------------------------------------------------------------

  /**
   * One slot button.
   *
   * A real `<button>`, not a clickable div: it is focusable, it announces itself, and
   * Playwright can find it by role. The visual slot from `kit.ts` lives inside it and is
   * taken out of hit testing by the stylesheet above.
   */
  function slotButton(
    ctx: UiContext,
    options: {
      stack: ItemStack | null;
      ref: ContainerRef;
      index: number;
      testId: string;
      ariaLabel: string;
      badge?: string;
      onActivate?: (stack: ItemStack) => void;
      onDoubleActivate?: (stack: ItemStack) => void;
      target?: (stack: ItemStack) => SlotTarget;
    },
  ): HTMLButtonElement {
    const { stack } = options;
    const visual = itemSlot({
      stack,
      data: ctx.data,
      textures: ctx.textures,
      ...(options.badge === undefined ? {} : { badge: options.badge }),
    });

    const node = el('button', {
      className: 'inv-slot',
      attrs: {
        type: 'button',
        'aria-label': options.ariaLabel,
        'data-testid': options.testId,
      },
      children: [visual],
    });
    if (stack) attachTooltip(node, () => itemTooltip(stack, ctx.data));

    // Empty slots are still drop targets - that is how a player makes room.
    bindDropTarget(node, ctx, options.ref, options.index);

    if (!stack) return node;

    bindDragSource(node, ctx, options.ref, options.index, stack);

    const activate = options.onActivate;
    if (activate) node.addEventListener('click', () => activate(stack));

    const doubleActivate = options.onDoubleActivate;
    if (doubleActivate) node.addEventListener('dblclick', () => doubleActivate(stack));

    const toTarget = options.target;
    if (toTarget) {
      node.addEventListener('contextmenu', (event: MouseEvent) => {
        // The canvas suppresses its own context menu; the panel has to suppress ours.
        event.preventDefault();
        openMenu(ctx, event, toTarget(stack));
      });
    }
    return node;
  }

  /**
   * Left click on a bag slot.
   *
   * Equip when the item can be worn or held, otherwise use it. The `useItem` is sent
   * even for a log that will do nothing: the server owns "nothing happens" and says so,
   * and guessing here would only mean two places to keep in step.
   */
  function activateInventorySlot(ctx: UiContext, index: number, stack: ItemStack): void {
    closeMenu();
    const def = ctx.data.items.get(stack.defId);
    const slot = def ? equipTargetFor(def) : null;
    if (slot) {
      ctx.send({ type: 'equipItem', inventorySlot: index, slot });
      return;
    }
    ctx.send({ type: 'useItem', ref: INVENTORY_REF, index });
  }

  function renderDoll(ctx: UiContext, player: PlayerState, host: HTMLElement): void {
    host.replaceChildren(
      ...EQUIP_SLOTS.map((slot) => {
        const stack = player.equipment[slot];
        const label = SLOT_LABEL[slot];
        const node = slotButton(ctx, {
          stack,
          ref: { kind: 'equipment', slot },
          index: EQUIPMENT_INDEX,
          testId: `inventory-equip-${slot}`,
          ariaLabel: stack
            ? `${label}: ${displayName(ctx, stack.defId)}. Double click to unequip.`
            : `${label}: empty`,
          // A single click on worn gear would be ambiguous (use it? take it off?), so
          // taking it off is the deliberate gesture.
          onDoubleActivate: () => {
            closeMenu();
            ctx.send({ type: 'unequipItem', slot });
          },
          target: (held) => ({ kind: 'equipment', slot, stack: held }),
        });
        const cell = el('div', {
          className: 'inv-doll-cell',
          children: [node, el('span', { className: 'inv-doll-label', text: label })],
        });
        cell.style.gridArea = slot;
        return cell;
      }),
    );
  }

  function renderGrid(ctx: UiContext, player: PlayerState, host: HTMLElement): void {
    const badges = hotbarBadges(player);
    host.replaceChildren(
      ...player.inventory.slots.map((stack, index) => {
        const badge = badges.get(index);
        return slotButton(ctx, {
          stack,
          ref: INVENTORY_REF,
          index,
          testId: `inventory-slot-${index}`,
          ariaLabel: stack
            ? `Slot ${index + 1}: ${displayName(ctx, stack.defId)}${
                stack.count > 1 ? ` ×${stack.count}` : ''
              }`
            : `Slot ${index + 1}: empty`,
          ...(badge === undefined ? {} : { badge }),
          onActivate: () => activateInventorySlot(ctx, index, stack as ItemStack),
          target: (held) => ({ kind: 'inventory', index, stack: held }),
        });
      }),
    );
  }

  /**
   * Load and slot count.
   *
   * The bar goes red past capacity rather than clamping silently, because being
   * overloaded is a movement penalty the player has to be able to see coming - the
   * simulation slows them down for it.
   */
  function renderFooter(player: PlayerState, host: HTMLElement): void {
    const capacity = player.carryCapacity;
    const over = player.carryWeight > capacity;
    const fraction = capacity > 0 ? player.carryWeight / capacity : 1;
    const color = over ? UI.danger : fraction > 0.9 ? UI.warn : UI.accent;

    const used = player.inventory.slots.reduce((total, stack) => total + (stack ? 1 : 0), 0);
    const total = player.inventory.slots.length;

    host.replaceChildren(
      statBar('LOAD', player.carryWeight, capacity, color),
      el('div', {
        className: 'row',
        children: [
          el('span', {
            className: 'inv-load',
            attrs: { 'data-testid': 'inventory-weight' },
            text: `${player.carryWeight.toFixed(1)} / ${capacity.toFixed(1)} kg`,
          }),
          el('span', {
            className: 'inv-load muted',
            attrs: { 'data-testid': 'inventory-slot-count' },
            text: `${used} / ${total} slots`,
          }),
          over
            ? el('span', {
                className: 'effect-chip effect-chip--bad',
                attrs: { 'data-testid': 'inventory-overloaded' },
                text: 'overloaded',
              })
            : null,
        ],
      }),
      el('p', {
        className: 'muted inv-hint',
        text: 'Drag to move · shift-drag for half · drag out to drop · right click for more',
      }),
    );
  }

  function ensureParts(ctx: UiContext): Parts {
    if (parts) return parts;

    const doll = el('div', {
      className: 'inv-doll',
      attrs: { role: 'group', 'aria-label': 'Equipment', 'data-testid': 'inventory-equipment' },
    });

    const grid = el('div', {
      className: 'grid',
      attrs: { role: 'group', 'aria-label': 'Inventory slots', 'data-testid': 'inventory-grid' },
    });
    grid.style.gridTemplateColumns = `repeat(${GRID_COLUMNS}, 46px)`;

    const footer = el('div', {
      className: 'inv-footer',
      attrs: { 'data-testid': 'inventory-footer' },
    });

    const sort = button('Sort', () => {
      closeMenu();
      // Read the context from `activeCtx` rather than closing over the one that built
      // this button: the button outlives any single frame.
      const current = activeCtx ?? ctx;
      // Ordering is the server's to decide; this only asks for it.
      current.send({ type: 'sortContainer', ref: INVENTORY_REF });
    });
    sort.setAttribute('data-testid', 'inventory-sort');

    const body = el('div', {
      className: 'panel-body inv-body',
      children: [
        el('div', {
          className: 'inv-left',
          children: [el('div', { className: 'section-title', text: 'Worn' }), doll],
        }),
        el('div', {
          className: 'inv-right',
          children: [
            el('div', {
              className: 'inv-head',
              children: [el('div', { className: 'section-title', text: 'Bag' }), sort],
            }),
            el('div', { className: 'inv-grid-wrap', children: [grid] }),
            footer,
          ],
        }),
      ],
    });

    const built: Parts = { doll, grid, footer, sort, body };
    parts = built;
    return built;
  }

  return {
    id: 'inventory',
    title: 'Inventory',
    captures: true,

    mount(ctx: UiContext): HTMLElement {
      activeCtx = ctx;
      injectInventoryStyles();
      const view = ensureParts(ctx);
      // Forget the cached signatures so the first update draws from scratch.
      contentSignature = '';
      footerSignature = '';
      const root = panelFrame('Inventory', () => ctx.close('inventory'), view.body, 'panel--inv');
      root.setAttribute('data-testid', 'inventory-panel');
      // A drop that lands on the panel's own chrome is a drop onto nothing, and the
      // source's `dragend` turns that into `dropItem`. Nothing to bind here; the panel
      // just must not claim the drop.
      rootNode = root;
      return root;
    },

    update(ctx: UiContext): void {
      activeCtx = ctx;
      const view = ensureParts(ctx);
      const player = ctx.session.self;

      if (!player) {
        if (contentSignature !== 'none') {
          contentSignature = 'none';
          footerSignature = '';
          view.doll.replaceChildren();
          view.grid.replaceChildren();
          view.footer.replaceChildren(
            el('p', { className: 'muted', text: 'Waiting for the world…' }),
          );
        }
        return;
      }

      // A rebuild mid-drag would pull the source element out from under the pointer and
      // reset every drop highlight, so hold still until the gesture is over. Nothing the
      // drag itself does can change these slots before then: the move is a command, and
      // the answer arrives in a later snapshot.
      if (ctx.drag) return;

      const nextContent = [
        ...player.inventory.slots.map(stackSignature),
        '|',
        ...EQUIP_SLOTS.map((slot) => `${slot}=${stackSignature(player.equipment[slot])}`),
        '|',
        ...player.hotbar.map((slotIndex) => slotIndex ?? '-'),
      ].join(',');

      if (nextContent !== contentSignature) {
        contentSignature = nextContent;
        // Both halves share one signature because both are drawn from the same two
        // fields, and an equip changes them together.
        renderDoll(ctx, player, view.doll);
        renderGrid(ctx, player, view.grid);
      }

      const nextFooter = `${player.carryWeight.toFixed(1)}|${player.carryCapacity.toFixed(1)}|${
        player.inventory.slots.length
      }|${nextContent.length}`;
      if (nextFooter !== footerSignature) {
        footerSignature = nextFooter;
        renderFooter(player, view.footer);
      }
    },

    unmount(): void {
      closeMenu();
      rootNode = null;
      contentSignature = '';
      footerSignature = '';
    },
  };
}
