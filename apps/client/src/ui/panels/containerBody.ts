import {
  BODY_PART_IDS,
  BODY_PART_LABELS,
  SIM_HZ,
  totalPain,
  type BodyPartId,
  type BodyPartState,
  type ContainerRef,
  type ItemStack,
  type OpenContainerView,
  type PlayerState,
} from '@survive/protocol';
import type { ItemDef, MedicalKind, MedicalProps } from '@survive/game-data';
import { UI, cssColor } from '../../art/palette';
import {
  button,
  el,
  humanize,
  itemIconUrl,
  itemSlot,
  itemTooltip,
  panelFrame,
  statBar,
} from '../kit';
import { attachTooltip } from '../tooltip';
import type { DragState, DropTarget, Panel, UiContext } from '../panel';

/**
 * Two panels that share a stylesheet: the container (chest / locker / corpse) view and
 * the body (injury and treatment) view.
 *
 * They live in one file because they are the two halves of "what am I carrying and what
 * is wrong with me", they use the same small set of local classes, and neither is big
 * enough to earn its own stylesheet injection. Everything else about them is separate:
 * separate factories, separate ids, separate signatures, separate closures.
 *
 * The rules both obey:
 *
 * - **The client decides nothing.** Every gesture becomes an intent (`moveItem`,
 *   `takeAll`, `sortContainer`, `treat`) and the next snapshot is what changes the
 *   display. The container panel never moves a stack locally, and the body panel never
 *   applies a bandage locally. Where this file *does* reason about game rules - which
 *   medical item can help which body part - it is mirroring the server's own predicate
 *   purely so the player is not clicking into a wall. If the two ever disagree the
 *   server wins and emits a rejection the HUD shows as a toast.
 * - **Diff before rebuilding.** `update` runs once per rendered frame. Each panel builds
 *   a signature of exactly the state it draws and returns early when nothing moved; a
 *   forty-slot grid of icons rebuilt at 60fps is visible jank.
 */

// ---------------------------------------------------------------------------
// Shared styles
// ---------------------------------------------------------------------------

const STYLE_ID = 'survive-container-body-styles';

/**
 * Panel-local styles, injected once from here with a guarded unique id rather than
 * added to `kit.ts`: a paired loot grid and an injury row are layouts nothing else in
 * the interface needs. Everything shared - `.panel`, `.panel-body`, `.grid`, `.slot`,
 * `.bar`, `.btn`, `.row`, `.col`, `.muted`, `.section-title`, `.effect-chip` - is
 * reused as-is.
 *
 * The two `pointer-events: none` rules on `.cb-slot`'s children matter more than they
 * look, and are here for the same reason the inventory panel has them: a child under
 * the cursor makes HTML5 drag fire spurious `dragenter`/`dragleave` pairs, which
 * flickers the drop highlight, and taking the children out of hit testing guarantees
 * every click and every `dragstart` reports the *button* as its target. They
 * out-specify the shared `.ui-root .slot { pointer-events: auto }` on purpose.
 */
function injectContainerBodyStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .panel--container { width: min(700px, 94vw); }
    .panel--body { width: min(560px, 94vw); }
    .cb-body { display: flex; flex-direction: column; gap: 10px; }

    .cb-cols { display: flex; gap: 14px; align-items: flex-start; flex-wrap: wrap; }
    .cb-col { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .cb-col-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
    .cb-col-head .section-title { margin: 0; }
    .cb-count { font-family: monospace; font-size: 11px; color: ${cssColor(UI.textMuted)}; }
    .cb-count--over { color: ${cssColor(UI.danger)}; }
    .cb-grid { grid-template-columns: repeat(6, 46px); }

    /* A slot is a real button; kit's .slot is the visual inside it. See the note above. */
    .cb-slot {
      padding: 0; margin: 0; border: 0; background: none; font: inherit; color: inherit;
      display: block; cursor: pointer; border-radius: 4px;
    }
    .cb-slot:focus-visible { outline: 2px solid ${cssColor(UI.accent)}; outline-offset: 1px; }
    .ui-root .cb-slot > * { pointer-events: none; }
    .ui-root .cb-slot .slot { pointer-events: none; }
    .cb-slot--over .slot { outline: 1px dashed ${cssColor(UI.accent, 0.85)}; outline-offset: 1px; }
    .cb-slot--source .slot { opacity: 0.45; }

    .cb-actions {
      display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
      padding-top: 9px; border-top: 1px solid ${cssColor(UI.panelEdge)};
    }
    .cb-actions .btn { padding: 5px 10px; font-size: 11px; }
    .cb-hint { font-size: 10px; line-height: 1.4; }

    .cb-vitals { display: flex; flex-direction: column; gap: 5px; }
    .cb-readout {
      display: flex; align-items: center; gap: 8px; font-family: monospace; font-size: 11px;
      color: ${cssColor(UI.textMuted)};
    }
    .cb-readout b { color: ${cssColor(UI.text)}; font-weight: 600; }

    .cb-parts { display: flex; flex-direction: column; gap: 4px; }
    .cb-part {
      display: grid; grid-template-columns: 74px minmax(84px, 1fr) minmax(0, 1.6fr);
      gap: 9px; align-items: center; width: 100%; text-align: left; cursor: pointer;
      padding: 5px 7px; font: inherit; font-size: 12px; color: ${cssColor(UI.text)};
      background: ${cssColor(UI.slot, 0.55)};
      border: 1px solid ${cssColor(UI.slotEdge)}; border-radius: 4px;
    }
    .cb-part:hover { background: ${cssColor(UI.slotHover, 0.85)}; }
    .cb-part[aria-pressed="true"] {
      border-color: ${cssColor(UI.accent)}; background: ${cssColor(UI.slotHover, 0.95)};
    }
    /* The worst part gets a blood-coloured edge, so triage reads without being read. */
    .cb-part--urgent { box-shadow: inset 3px 0 0 ${cssColor(UI.bleed)}; }
    .cb-part-name { font-weight: 600; }
    .cb-chips { display: flex; flex-wrap: wrap; gap: 3px; }

    .cb-treat { display: flex; flex-direction: column; gap: 4px; }
    .cb-treat-item {
      display: grid; grid-template-columns: 22px minmax(96px, 1fr) minmax(0, 1.5fr);
      gap: 8px; align-items: center; width: 100%; text-align: left; cursor: pointer;
      padding: 4px 7px; font: inherit; font-size: 12px; color: ${cssColor(UI.text)};
      background: ${cssColor(UI.slot, 0.55)};
      border: 1px solid ${cssColor(UI.slotEdge)}; border-radius: 4px;
    }
    .cb-treat-item:hover:not(:disabled) { background: ${cssColor(UI.slotHover, 0.85)}; }
    .cb-treat-item:disabled { opacity: 0.42; cursor: default; }
    .cb-treat-item img { width: 20px; height: 20px; image-rendering: pixelated; }
    .cb-stack { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
    .cb-sub { font-size: 10px; color: ${cssColor(UI.textMuted)}; }
  `;
  document.head.append(style);
}

// ---------------------------------------------------------------------------
// Drag plumbing
// ---------------------------------------------------------------------------

/**
 * Lift a whole stack.
 *
 * `count: null` means "all of it": splitting is a separate command (`splitStack`) and a
 * separate gesture, so the drag never has to guess a number.
 */
function dragStateFor(ref: ContainerRef, index: number, defId: string): DragState {
  return { from: ref, index, count: null, defId };
}

/** Drop onto one named slot. `index: null` would ask the server to auto-place. */
function dropTargetFor(ref: ContainerRef, index: number | null): DropTarget {
  return { to: ref, index };
}

/** Short signature of one stack, for the diff. Covers everything a slot draws. */
function stackSignature(stack: ItemStack | null): string {
  if (!stack) return '-';
  const wear = stack.durability === undefined ? '' : `d${Math.round(stack.durability)}`;
  const fresh = stack.freshness === undefined ? '' : `f${Math.round(stack.freshness * 20)}`;
  const ammo = stack.ammo === undefined ? '' : `a${stack.ammo}`;
  return `${stack.defId}x${stack.count}${wear}${fresh}${ammo}`;
}

function stackLabel(stack: ItemStack | null, ctx: UiContext): string {
  if (!stack) return 'empty';
  const def = ctx.data.items.get(stack.defId);
  const name = def?.name ?? humanize(stack.defId);
  return stack.count > 1 ? `${name} ×${stack.count}` : name;
}

// ---------------------------------------------------------------------------
// Container panel
// ---------------------------------------------------------------------------

/**
 * The chest / locker / corpse view.
 *
 * Two grids side by side - the container on the left, the pack on the right - because
 * the gesture the panel exists for is moving a stack from one to the other, and putting
 * both grids on screen at once is what makes that gesture obvious.
 *
 * Two ways to move something:
 *
 * 1. **Drag**, using HTML5 drag and drop routed through `ctx.beginDrag` / `ctx.endDrag`.
 *    Deliberately the same mechanism the inventory panel uses, because both panels are
 *    often open at once and a stack has to be able to travel from a chest slot here into
 *    a bag slot there. A drag that lands on nothing becomes `dropItem` via the source's
 *    `dragend`, which is how you throw something on the floor.
 * 2. **Shift-click**, which sends the stack straight across with `toIndex: null` so the
 *    server picks the slot. This is the gesture that gets used a hundred times an hour
 *    while looting, so it is one click and it never needs a target.
 *
 * Shift means exactly one thing in this panel - "the other grid" - so a shift-drag here
 * moves the whole stack rather than half of it. The inventory panel's shift-drag-for-half
 * is the right default where there is no "across" to mean; here it would collide with the
 * shortcut this screen exists for.
 *
 * The panel is opened and closed by `UiScene` from the snapshot, so `container` can be
 * `null` for the frame between the server closing it and the scene noticing. That is a
 * normal state here, not an error.
 */
export function createContainerPanel(): Panel {
  let signature = '';
  /** The mounted frame, so the drop highlights can be cleared without a node registry. */
  let rootNode: HTMLElement | null = null;

  interface Parts {
    /** The frame's own `h2`, which carries the container's name. Set on mount. */
    heading: HTMLHeadingElement | null;
    containerCount: HTMLSpanElement;
    containerGrid: HTMLDivElement;
    packCount: HTMLSpanElement;
    packGrid: HTMLDivElement;
    actions: HTMLDivElement;
    body: HTMLDivElement;
  }

  let parts: Parts | null = null;

  function ensureParts(): Parts {
    if (parts) return parts;

    const containerCount = el('span', {
      className: 'cb-count',
      attrs: { 'data-testid': 'container-fill' },
    });
    const containerGrid = el('div', {
      className: 'grid cb-grid',
      attrs: {
        role: 'group',
        'aria-label': 'Container slots',
        'data-testid': 'container-grid',
      },
    });

    const packCount = el('span', {
      className: 'cb-count',
      attrs: { 'data-testid': 'container-carry-weight' },
    });
    const packGrid = el('div', {
      className: 'grid cb-grid',
      attrs: {
        role: 'group',
        'aria-label': 'Your inventory slots',
        'data-testid': 'container-inventory-grid',
      },
    });

    const actions = el('div', {
      className: 'cb-actions',
      attrs: { 'data-testid': 'container-actions' },
    });

    const body = el('div', {
      className: 'panel-body cb-body',
      children: [
        el('div', {
          className: 'cb-cols',
          children: [
            el('section', {
              className: 'cb-col',
              children: [
                el('div', {
                  className: 'cb-col-head',
                  children: [
                    // The container's own name is in the title bar; this column only has
                    // to say which of the two grids it is.
                    el('span', { className: 'section-title', text: 'Contents' }),
                    containerCount,
                  ],
                }),
                containerGrid,
              ],
            }),
            el('section', {
              className: 'cb-col',
              children: [
                el('div', {
                  className: 'cb-col-head',
                  children: [
                    el('span', { className: 'section-title', text: 'Your Pack' }),
                    packCount,
                  ],
                }),
                packGrid,
              ],
            }),
          ],
        }),
        actions,
        el('p', {
          className: 'muted cb-hint',
          attrs: { 'data-testid': 'container-hint' },
          text: 'Shift-click to move across · drag to place exactly · drag out to drop',
        }),
      ],
    });

    parts = {
      heading: null,
      containerCount,
      containerGrid,
      packCount,
      packGrid,
      actions,
      body,
    };
    return parts;
  }

  /** Drop the leftover highlight classes after a gesture ends. */
  function clearDropHighlights(): void {
    if (!rootNode) return;
    for (const node of rootNode.querySelectorAll('.cb-slot--over, .cb-slot--source')) {
      node.classList.remove('cb-slot--over', 'cb-slot--source');
    }
  }

  /**
   * One slot button.
   *
   * A real `<button>`, not a clickable div: focusable, self-announcing, and findable by
   * role in a test. Kit's `.slot` visual lives inside it and is taken out of hit testing
   * by the stylesheet above.
   *
   * `otherRef` is where a shift-click sends the stack. The panel's whole point is that
   * every slot has an obvious "across", so the shortcut never has to pick a target.
   */
  function renderSlot(
    ctx: UiContext,
    ref: ContainerRef,
    otherRef: ContainerRef,
    index: number,
    stack: ItemStack | null,
    testid: string,
    label: string,
  ): HTMLButtonElement {
    const visual = itemSlot({ stack, data: ctx.data, textures: ctx.textures });

    const node = el('button', {
      className: 'cb-slot',
      attrs: {
        type: 'button',
        'data-testid': `${testid}-${index}`,
        'aria-label': `${label} slot ${index + 1}: ${stackLabel(stack, ctx)}`,
      },
      children: [visual],
    });
    if (stack) attachTooltip(node, () => itemTooltip(stack, ctx.data));

    // Every slot is a drop target, empty ones included: that is how a player makes room.
    // Indifferent to where the drag started, so a stack coming out of the inventory
    // panel lands here on the same code path. Whether the move is legal is the server's
    // call - an occupied slot may swap or merge, and which of the two is not ours to say.
    node.addEventListener('dragover', (event: DragEvent) => {
      if (!ctx.drag) return;
      // Without preventDefault the browser never fires `drop`.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      node.classList.add('cb-slot--over');
    });
    node.addEventListener('dragleave', () => node.classList.remove('cb-slot--over'));
    node.addEventListener('drop', (event: DragEvent) => {
      event.preventDefault();
      // Stop the panel behind from also treating this as a drop onto nothing.
      event.stopPropagation();
      node.classList.remove('cb-slot--over');
      if (!ctx.drag) return;
      ctx.endDrag(dropTargetFor(ref, index));
      clearDropHighlights();
    });

    if (!stack) return node;

    node.draggable = true;
    node.addEventListener('dragstart', (event: DragEvent) => {
      ctx.beginDrag(dragStateFor(ref, index, stack.defId));
      // Firefox refuses to start a drag with an empty dataTransfer.
      event.dataTransfer?.setData('text/plain', stack.defId);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      node.classList.add('cb-slot--source');
    });
    node.addEventListener('dragend', () => {
      // Nobody accepted the drop, so the gesture means "put it on the ground", which is
      // what `endDrag(null)` sends. If a slot did accept it, `ctx.drag` is already null.
      if (ctx.drag) ctx.endDrag(null);
      clearDropHighlights();
    });

    node.addEventListener('click', (event: MouseEvent) => {
      if (!event.shiftKey) return;
      // `toIndex: null` is the point: the server decides where it lands, topping up
      // matching partial stacks before taking an empty slot.
      ctx.send({
        type: 'moveItem',
        from: ref,
        fromIndex: index,
        to: otherRef,
        toIndex: null,
        count: null,
      });
    });

    return node;
  }

  function renderGrid(
    ctx: UiContext,
    grid: HTMLDivElement,
    ref: ContainerRef,
    otherRef: ContainerRef,
    slots: readonly (ItemStack | null | undefined)[],
    capacity: number,
    testid: string,
    label: string,
  ): void {
    const count = Math.max(capacity, slots.length);
    const nodes: HTMLButtonElement[] = [];
    for (let index = 0; index < count; index++) {
      nodes.push(renderSlot(ctx, ref, otherRef, index, slots[index] ?? null, testid, label));
    }
    grid.replaceChildren(...nodes);
  }

  function renderActions(ctx: UiContext, view: Parts, container: OpenContainerView): void {
    const takeAll = button('Take All', () =>
      ctx.send({ type: 'takeAll', structureId: container.structureId }),
    );
    takeAll.setAttribute('data-testid', 'container-take-all');
    takeAll.setAttribute('aria-label', 'Take everything from the container');

    const sortContainer = button('Sort Container', () =>
      ctx.send({
        type: 'sortContainer',
        ref: { kind: 'structure', structureId: container.structureId },
      }),
    );
    sortContainer.setAttribute('data-testid', 'container-sort');

    const sortPack = button('Sort Pack', () =>
      ctx.send({ type: 'sortContainer', ref: { kind: 'inventory' } }),
    );
    sortPack.setAttribute('data-testid', 'container-sort-inventory');

    view.actions.replaceChildren(takeAll, sortContainer, sortPack);
  }

  return {
    id: 'container',
    title: 'Container',
    captures: true,

    mount(ctx: UiContext): HTMLElement {
      injectContainerBodyStyles();
      const view = ensureParts();
      // Forget the cached signature so the first update draws from scratch.
      signature = '';
      const root = panelFrame(
        'Container',
        () => ctx.close('container'),
        view.body,
        'panel--container',
      );
      root.setAttribute('data-testid', 'container-panel');
      rootNode = root;
      // `panelFrame` owns the title bar, so reach into the frame it built rather than
      // duplicate it: the heading has to change once the snapshot says which chest this
      // is, and the close button's label is an icon that needs a name.
      view.heading = root.querySelector<HTMLHeadingElement>('.panel-head h2');
      const close = root.querySelector<HTMLButtonElement>('.panel-head button');
      close?.setAttribute('aria-label', 'Close container');
      close?.setAttribute('data-testid', 'container-close');
      return root;
    },

    update(ctx: UiContext): void {
      const view = ensureParts();
      const player = ctx.session.self;
      const container = ctx.session.store.container;

      if (!container || !player) {
        // The server has closed the container (or we have not been given a player yet)
        // and the scene has not caught up. One frame, usually; say something honest.
        if (signature === 'closed') return;
        signature = 'closed';
        if (view.heading) view.heading.textContent = 'Container';
        view.containerCount.textContent = '';
        view.packCount.textContent = '';
        view.packCount.classList.remove('cb-count--over');
        view.containerGrid.replaceChildren();
        view.packGrid.replaceChildren();
        // The message goes in the action row, not into a grid: a paragraph laid out as a
        // 46px grid cell is unreadable.
        view.actions.replaceChildren(
          el('p', {
            className: 'muted',
            text: 'The container is no longer open.',
            attrs: { 'data-testid': 'container-closed' },
          }),
        );
        return;
      }

      // A rebuild mid-drag would pull the source element out from under the pointer and
      // reset every drop highlight, so hold still until the gesture is over. Nothing the
      // drag itself does can change these slots before then: the move is a command, and
      // the answer arrives in a later snapshot.
      if (ctx.drag) return;

      const structureDef = ctx.data.structures.get(container.defId);
      const name = structureDef?.name ?? humanize(container.defId);
      const filled = container.slots.reduce((total, slot) => total + (slot ? 1 : 0), 0);
      const capacity = Math.max(container.capacity, container.slots.length);
      const overloaded = player.carryWeight > player.carryCapacity;

      const next = [
        container.structureId,
        container.defId,
        capacity,
        container.slots.map(stackSignature).join(','),
        player.inventory.capacity,
        player.inventory.slots.map((slot) => stackSignature(slot ?? null)).join(','),
        Math.round(player.carryWeight * 10),
        Math.round(player.carryCapacity * 10),
      ].join('|');
      if (next === signature) return;
      signature = next;

      if (view.heading && view.heading.textContent !== name) view.heading.textContent = name;
      view.containerCount.textContent = `${filled}/${capacity} slots`;
      view.packCount.textContent = `${player.carryWeight.toFixed(1)}/${player.carryCapacity.toFixed(1)} kg`;
      view.packCount.classList.toggle('cb-count--over', overloaded);

      const containerRef: ContainerRef = { kind: 'structure', structureId: container.structureId };
      const inventoryRef: ContainerRef = { kind: 'inventory' };

      renderGrid(
        ctx,
        view.containerGrid,
        containerRef,
        inventoryRef,
        container.slots,
        capacity,
        'container-slot',
        name,
      );
      renderGrid(
        ctx,
        view.packGrid,
        inventoryRef,
        containerRef,
        player.inventory.slots,
        player.inventory.capacity,
        'container-inventory-slot',
        'Pack',
      );
      renderActions(ctx, view, container);
    },

    unmount(): void {
      // The frame is about to be removed, so the highlight-clearing queries would find
      // nothing. Any drag still in flight finishes through its own `dragend`, which the
      // browser fires even on a detached source node.
      rootNode = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Body panel
// ---------------------------------------------------------------------------

/** Core temperature the body is happy at. Outside this the readout is flagged. */
const TEMP_MIN = 36;
const TEMP_MAX = 38;

/**
 * Bandage cleanliness below which the dressing is "dirty".
 *
 * Mirrors `DIRTY_BANDAGE_CLEANLINESS` in the simulation's survival tuning. Duplicated as
 * a constant rather than imported because the UI layer has no business pulling in the
 * simulation for one number, and because being wrong here only ever mislabels a chip.
 */
const DIRTY_BANDAGE_CLEANLINESS = 0.5;

/** How the treatment list names each kind of medicine. */
const MEDICAL_KIND_LABEL: Record<MedicalKind, string> = {
  bandage: 'dressing',
  splint: 'splint',
  suture: 'sutures',
  disinfect: 'antiseptic',
  pill: 'pill',
  injection: 'injection',
};

/** Pills and injections go into the bloodstream; a target limb is meaningless for them. */
function isSystemic(kind: MedicalKind): boolean {
  return kind === 'pill' || kind === 'injection';
}

/**
 * How badly this part needs attention.
 *
 * Used only for ordering and for the urgent marker, never for a game outcome. The
 * weights are chosen so the sentence a player would say out loud - "my leg is broken and
 * bleeding" - sorts above "my forearm is scratched": an active bleed and an unset
 * fracture dominate, then how much health the part has lost, then the slower problems.
 */
function severityOf(part: BodyPartState): number {
  const missing = part.maxHealth > 0 ? 1 - part.health / part.maxHealth : 1;
  let score = part.bleeding * 14 + missing * 45 + part.infection * 0.55 + part.pain * 0.22;
  score += part.burned * 0.18;
  if (part.fractured) score += part.splinted ? 8 : 28;
  if (part.bitten) score += 10;
  return score;
}

/** True when a part has something a player could act on. */
function isInjured(part: BodyPartState): boolean {
  return (
    part.health < part.maxHealth ||
    part.bleeding > 0 ||
    part.pain > 0 ||
    part.infection > 0 ||
    part.burned > 0 ||
    part.fractured ||
    part.bitten
  );
}

/** A wound in the sense the server's `treatmentApplies` uses the word. */
function isWounded(part: BodyPartState): boolean {
  return part.health < part.maxHealth || part.bleeding > 0;
}

interface Applicability {
  ok: boolean;
  /** Shown in the button's `title` when `ok` is false. */
  why: string;
}

/**
 * Whether this item would do anything to this part, and if not, why not.
 *
 * A deliberate mirror of `treatmentApplies` in
 * `@survive/simulation/systems/survival/consumption.ts`, which is the predicate the
 * server refuses on. The duplication buys a greyed button with an explanation instead of
 * a rejection toast after the fact; if the two ever drift, the server is right and the
 * player sees a refusal, which is the correct failure direction.
 */
function applicability(
  part: BodyPartState,
  partLabel: string,
  med: MedicalProps,
  player: PlayerState,
): Applicability {
  if (isSystemic(med.kind)) {
    // The server never refuses a pill: it relieves pain, cures infection and heals the
    // worst part wherever they are. So the only honest "useless" case is having nothing
    // anywhere for it to act on.
    const pain = totalPain(player.body);
    const anyInfection = BODY_PART_IDS.some((id) => player.body.parts[id].infection > 0);
    const anyWound = BODY_PART_IDS.some((id) => isWounded(player.body.parts[id]));
    if (med.painRelief > 0 && pain > 0) return { ok: true, why: '' };
    if (med.infectionCure > 0 && anyInfection) return { ok: true, why: '' };
    if (med.heal > 0 && anyWound) return { ok: true, why: '' };
    if ((med.effects?.length ?? 0) > 0) return { ok: true, why: '' };
    return { ok: false, why: 'Nothing for it to act on right now.' };
  }

  switch (med.kind) {
    case 'splint':
      if (!part.fractured) return { ok: false, why: `${partLabel} is not fractured.` };
      if (part.splinted) return { ok: false, why: `${partLabel} is already splinted.` };
      return { ok: true, why: '' };
    case 'suture':
      if (!isWounded(part)) {
        return { ok: false, why: `${partLabel} has no open wound to close.` };
      }
      return { ok: true, why: '' };
    case 'disinfect':
      if (part.infection <= 0 && !part.bitten && !isWounded(part)) {
        return { ok: false, why: `No wound or infection on ${partLabel} to disinfect.` };
      }
      return { ok: true, why: '' };
    case 'bandage':
      if (part.bleeding > 0 || part.infection > 0) return { ok: true, why: '' };
      if (!isWounded(part)) return { ok: false, why: `${partLabel} is not wounded.` };
      if (part.bandaged && part.bandageQuality >= med.cleanliness) {
        return {
          ok: false,
          why: `The dressing already on ${partLabel} is at least this clean.`,
        };
      }
      return { ok: true, why: '' };
    default:
      return { ok: true, why: '' };
  }
}

/** One-line summary of what a medical item does, for the row's second column. */
function medicalSummary(med: MedicalProps): string {
  const bits: string[] = [];
  if (med.bleedStop > 0) {
    bits.push(med.bleedStop >= 1 ? 'stops bleeding' : `-${Math.round(med.bleedStop * 100)}% bleed`);
  }
  if (med.kind === 'suture') bits.push('closes the wound');
  if (med.fixesFracture || med.kind === 'splint') bits.push('sets fractures');
  if (med.heal > 0) bits.push(`+${Math.round(med.heal)} hp`);
  if (med.painRelief > 0) bits.push(`-${Math.round(med.painRelief)} pain`);
  if (med.infectionCure > 0) bits.push(`-${Math.round(med.infectionCure)} infection`);
  if (med.kind === 'bandage' || med.kind === 'disinfect') {
    bits.push(`${Math.round(med.cleanliness * 100)}% clean`);
  }
  bits.push(`${(med.useTicks / SIM_HZ).toFixed(1)}s`);
  return bits.join(' · ');
}

/** A chip, using the shared `.effect-chip` classes. */
function chip(text: string, tone: 'bad' | 'good' | 'neutral', title?: string): HTMLSpanElement {
  return el('span', {
    className: `effect-chip${tone === 'neutral' ? '' : ` effect-chip--${tone}`}`,
    text,
    ...(title === undefined ? {} : { title }),
  });
}

/**
 * A part's health bar.
 *
 * Reuses kit's `.bar` classes but omits `.bar-label`: the row's first column already
 * names the part, and a second copy of the name inside the bar would be noise.
 */
function partBar(part: BodyPartState): HTMLDivElement {
  const fraction = part.maxHealth > 0 ? Math.max(0, Math.min(1, part.health / part.maxHealth)) : 0;
  const fill = el('div', { className: 'bar-fill' });
  fill.style.width = `${fraction * 100}%`;
  fill.style.background = cssColor(
    fraction > 0.5 ? UI.accent : fraction > 0.25 ? UI.warn : UI.danger,
  );
  return el('div', {
    className: 'bar bar--compact',
    children: [
      el('div', { className: 'bar-track', children: [fill] }),
      el('span', { className: 'bar-value', text: String(Math.round(part.health)) }),
    ],
  });
}

/** Every chip a part earns, worst first so the row's left edge is the headline. */
function partChips(part: BodyPartState): HTMLSpanElement[] {
  const chips: HTMLSpanElement[] = [];
  if (part.bleeding > 0) {
    chips.push(
      chip(`bleeding ${part.bleeding.toFixed(1)}/s`, 'bad', 'Blood units lost per second'),
    );
  }
  if (part.fractured) {
    chips.push(
      part.splinted
        ? chip('fractured · splinted', 'neutral', 'Set, but still broken')
        : chip('fractured', 'bad', 'Unset: needs a splint'),
    );
  } else if (part.splinted) {
    chips.push(chip('splinted', 'good'));
  }
  if (part.infection > 0) {
    chips.push(
      chip(
        `infection ${Math.round(part.infection)}%`,
        'bad',
        'At 100% this becomes sepsis. Antiseptic slows it; antibiotics reverse it.',
      ),
    );
  }
  if (part.bitten) chips.push(chip('bitten', 'bad', 'A bite wound: the way infection gets in'));
  if (part.burned > 0) chips.push(chip(`burn ${Math.round(part.burned)}`, 'bad'));
  if (part.pain > 0) {
    chips.push(chip(`pain ${Math.round(part.pain)}`, part.pain >= 40 ? 'bad' : 'neutral'));
  }
  if (part.stitched) chips.push(chip('stitched', 'good', 'The wound is closed'));
  if (part.bandaged) {
    const clean = part.bandageQuality >= DIRTY_BANDAGE_CLEANLINESS;
    chips.push(
      clean
        ? chip(`bandaged · clean ${Math.round(part.bandageQuality * 100)}%`, 'good')
        : chip(
            `bandaged · dirty ${Math.round(part.bandageQuality * 100)}%`,
            'bad',
            'A dirty dressing stops the blood and invites infection. Re-dress it with something cleaner.',
          ),
    );
  }
  if (part.disinfectedTicks > 0) {
    chips.push(
      chip(
        `antiseptic ${Math.round(part.disinfectedTicks / SIM_HZ)}s`,
        'good',
        'Protected against new infection for this long',
      ),
    );
  }
  if (chips.length === 0) chips.push(chip('healthy', 'neutral'));
  return chips;
}

/**
 * Everything about one part that the panel draws or reasons from.
 *
 * Rounded where the display rounds: a bleed rate is shown to one decimal and the
 * antiseptic chip to the whole second, so a snapshot that only moves them further down
 * must not count as a change.
 */
function partSignature(part: BodyPartState): string {
  return [
    Math.round(part.health),
    Math.round(part.maxHealth),
    part.bleeding.toFixed(1),
    Math.round(part.pain),
    Math.round(part.infection),
    Math.round(part.burned),
    part.fractured ? 'F' : '',
    part.bitten ? 'B' : '',
    part.bandaged ? `b${Math.round(part.bandageQuality * 100)}` : '',
    part.stitched ? 'S' : '',
    part.splinted ? 'P' : '',
    Math.round(part.disinfectedTicks / SIM_HZ),
  ].join(':');
}

/** One medical item in the player's pack, resolved against the selected part. */
interface Treatment {
  index: number;
  stack: ItemStack;
  def: ItemDef;
  med: MedicalProps;
  applies: Applicability;
}

/**
 * Injuries and treatment.
 *
 * The injury model is the most interesting thing in the simulation and the least
 * visible, so this panel's job is to make it legible: six parts, each with what is
 * wrong with it, sorted worst first; the four whole-body readouts that kill you
 * (health, blood, temperature, pain); and, for the part you have selected, exactly which
 * of the things in your pack would help it and which would not.
 *
 * Nothing here treats anything. Clicking an item sends `treat` and the next snapshot
 * says what happened - including the case where the server rolls a fumble and the item
 * is spent for nothing, which is a rule the client must never pre-empt.
 */
export function createBodyPanel(): Panel {
  /** Which part the treatment list is aimed at. Null until the first update picks one. */
  let selected: BodyPartId | null = null;
  let vitalsSignature = '';
  let partsSignature = '';
  let treatSignature = '';

  interface Parts {
    vitals: HTMLDivElement;
    partList: HTMLDivElement;
    treatTitle: HTMLDivElement;
    treatList: HTMLDivElement;
    body: HTMLDivElement;
  }

  let parts: Parts | null = null;

  function ensureParts(): Parts {
    if (parts) return parts;

    const vitals = el('div', {
      className: 'cb-vitals',
      attrs: { 'data-testid': 'body-vitals' },
    });
    const partList = el('div', {
      className: 'cb-parts',
      attrs: { role: 'group', 'aria-label': 'Body parts', 'data-testid': 'body-parts' },
    });
    const treatTitle = el('div', { className: 'section-title', text: 'Treatment' });
    const treatList = el('div', {
      className: 'cb-treat',
      attrs: { role: 'group', 'aria-label': 'Treatments', 'data-testid': 'body-treatments' },
    });

    const body = el('div', {
      className: 'panel-body cb-body',
      children: [
        vitals,
        el('div', { className: 'section-title', text: 'Injuries' }),
        partList,
        treatTitle,
        treatList,
      ],
    });

    parts = { vitals, partList, treatTitle, treatList, body };
    return parts;
  }

  function renderVitals(view: Parts, player: PlayerState): void {
    const pain = totalPain(player.body);
    const temperature = player.temperature;
    const cold = temperature < TEMP_MIN;
    const hot = temperature > TEMP_MAX;

    const readout = el('div', {
      className: 'cb-readout',
      attrs: { 'data-testid': 'body-temperature' },
      children: [
        el('span', { text: 'CORE' }),
        el('b', { text: `${temperature.toFixed(1)} °C` }),
        cold
          ? chip('too cold', 'bad', `Below ${TEMP_MIN} °C: get warm, dry and fed`)
          : hot
            ? chip('overheating', 'bad', `Above ${TEMP_MAX} °C: shade, water, less clothing`)
            : chip('normal', 'good', `${TEMP_MIN}–${TEMP_MAX} °C`),
      ],
    });

    view.vitals.replaceChildren(
      statBar('HP', player.health, player.maxHealth, UI.health),
      statBar('BLOOD', player.blood, 100, UI.bleed, { compact: true }),
      statBar('PAIN', pain, 100, pain >= 40 ? UI.danger : UI.warn, { compact: true }),
      readout,
    );
  }

  function renderParts(view: Parts, player: PlayerState, ordered: readonly BodyPartId[]): void {
    const worst = ordered[0];
    const rows = ordered.map((id) => {
      const part = player.body.parts[id];
      const label = BODY_PART_LABELS[id];
      const urgent = id === worst && severityOf(part) >= 20;
      const node = el('button', {
        className: `cb-part${urgent ? ' cb-part--urgent' : ''}`,
        attrs: {
          type: 'button',
          'data-testid': `body-part-${id}`,
          'aria-pressed': String(id === selected),
          'aria-label': `${label}: ${Math.round(part.health)} of ${Math.round(part.maxHealth)} health`,
        },
        children: [
          el('span', { className: 'cb-part-name', text: label }),
          partBar(part),
          el('div', { className: 'cb-chips', children: partChips(part) }),
        ],
        on: {
          // Selecting a part is pure view state - what the player is looking at, which
          // the server has no opinion about. Both signatures carry the selection, so the
          // next frame redraws the pressed row and the treatment list on its own.
          click: () => {
            selected = id;
          },
        },
      });
      return node;
    });
    view.partList.replaceChildren(...rows);
  }

  function renderTreatments(
    ctx: UiContext,
    view: Parts,
    part: BodyPartId,
    treatments: readonly Treatment[],
    busy: boolean,
  ): void {
    const label = BODY_PART_LABELS[part];
    view.treatTitle.textContent = `Treatment — ${label}`;

    if (treatments.length === 0) {
      view.treatList.replaceChildren(
        el('p', {
          className: 'muted',
          text: 'No medical supplies in your pack.',
          attrs: { 'data-testid': 'body-treat-empty' },
        }),
      );
      return;
    }

    const rows = treatments.map((treatment) => {
      const { def, med, applies, index, stack } = treatment;
      const url = itemIconUrl(ctx.textures, def.id);
      const systemic = isSystemic(med.kind);
      const disabled = !applies.ok || busy;

      const title = busy
        ? 'Still busy with the last treatment.'
        : applies.ok
          ? systemic
            ? `${def.name} — acts on the whole body, not just ${label}.`
            : `Apply ${def.name} to ${label}.`
          : applies.why;

      const node = el('button', {
        className: 'cb-treat-item',
        title,
        attrs: {
          type: 'button',
          'data-testid': `body-treat-slot-${index}`,
          'data-def-id': def.id,
          'aria-label': `${applies.ok ? 'Apply' : 'Cannot apply'} ${def.name} to ${label}`,
        },
        children: [
          url
            ? el('img', { attrs: { src: url, alt: '' } })
            : el('span', { className: 'cb-sub', text: def.name.slice(0, 2) }),
          el('div', {
            className: 'cb-stack',
            children: [
              el('span', { text: stack.count > 1 ? `${def.name} ×${stack.count}` : def.name }),
              el('span', {
                className: 'cb-sub',
                text: systemic
                  ? `${MEDICAL_KIND_LABEL[med.kind]} · whole body`
                  : MEDICAL_KIND_LABEL[med.kind],
              }),
            ],
          }),
          el('span', {
            className: 'cb-sub',
            text: applies.ok ? medicalSummary(med) : applies.why,
          }),
        ],
        on: {
          click: () => {
            // The only outbound intent in this panel. The server resolves the slot,
            // rolls the fumble check against the medicine skill, and spends the item.
            ctx.send({ type: 'treat', ref: { kind: 'inventory' }, index, bodyPart: part });
          },
        },
      });
      node.disabled = disabled;
      return node;
    });

    view.treatList.replaceChildren(...rows);
  }

  /** Every medical item in the pack, in slot order, resolved against `part`. */
  function collectTreatments(ctx: UiContext, player: PlayerState, part: BodyPartId): Treatment[] {
    const target = player.body.parts[part];
    const label = BODY_PART_LABELS[part];
    const out: Treatment[] = [];
    player.inventory.slots.forEach((slot, index) => {
      if (!slot) return;
      const def = ctx.data.items.get(slot.defId);
      const med = def?.medical;
      if (!def || !med) return;
      out.push({
        index,
        stack: slot,
        def,
        med,
        applies: applicability(target, label, med, player),
      });
    });
    // Useful things first, then by kind so the same item always sits in the same place
    // in the list rather than jumping as an unrelated stack is spent.
    out.sort(
      (a, b) =>
        Number(b.applies.ok) - Number(a.applies.ok) ||
        a.med.kind.localeCompare(b.med.kind) ||
        a.def.name.localeCompare(b.def.name),
    );
    return out;
  }

  return {
    id: 'body',
    title: 'Body',
    captures: true,

    mount(ctx: UiContext): HTMLElement {
      injectContainerBodyStyles();
      const view = ensureParts();
      // Forget the cached signatures so the first update draws from scratch, and let it
      // re-pick the worst part: what hurts most is what you opened the panel for.
      vitalsSignature = '';
      partsSignature = '';
      treatSignature = '';
      selected = null;
      const root = panelFrame('Body', () => ctx.close('body'), view.body, 'panel--body');
      root.setAttribute('data-testid', 'body-panel');
      const close = root.querySelector<HTMLButtonElement>('.panel-head button');
      close?.setAttribute('aria-label', 'Close body panel');
      close?.setAttribute('data-testid', 'body-close');
      return root;
    },

    update(ctx: UiContext): void {
      const view = ensureParts();
      const player = ctx.session.self;

      if (!player) {
        if (vitalsSignature === 'none') return;
        vitalsSignature = 'none';
        partsSignature = '';
        treatSignature = '';
        view.vitals.replaceChildren(
          el('p', { className: 'muted', text: 'Waiting for the world…' }),
        );
        view.partList.replaceChildren();
        view.treatList.replaceChildren();
        return;
      }

      // Worst first, with the fixed anatomical order as the tie-break so equally
      // healthy parts do not shuffle between frames.
      const ordered = [...BODY_PART_IDS].sort((a, b) => {
        const delta = severityOf(player.body.parts[b]) - severityOf(player.body.parts[a]);
        if (Math.abs(delta) > 0.001) return delta;
        return BODY_PART_IDS.indexOf(a) - BODY_PART_IDS.indexOf(b);
      });

      if (selected === null) {
        const worst = ordered[0] ?? 'torso';
        // Open on the part that needs attention; on an unhurt body, the torso, which is
        // where a systemic pill is conceptually aimed.
        selected = isInjured(player.body.parts[worst]) ? worst : 'torso';
      }
      const part = selected;

      // --- vitals -----------------------------------------------------------
      const pain = totalPain(player.body);
      const vitalsNext = [
        Math.round(player.health),
        Math.round(player.maxHealth),
        Math.round(player.blood),
        Math.round(player.temperature * 10),
        Math.round(pain),
      ].join('|');
      if (vitalsNext !== vitalsSignature) {
        vitalsSignature = vitalsNext;
        renderVitals(view, player);
      }

      // --- parts ------------------------------------------------------------
      const bodyNext = ordered
        .map((id) => `${id}:${partSignature(player.body.parts[id])}`)
        .concat(`sel=${part}`)
        .join('|');
      if (bodyNext !== partsSignature) {
        partsSignature = bodyNext;
        renderParts(view, player, ordered);
      }

      // --- treatments -------------------------------------------------------
      // `store.tick` is the last snapshot's tick, so this trails the server by a frame
      // or two. Being slightly stingy costs a briefly greyed button; being generous
      // would cost a rejection toast, so err this way.
      const busy = player.useReadyTick > ctx.session.store.tick;
      // Which items are offered, and whether each is greyed, is a function of every
      // part's state (a pill reads the whole body) plus the medical stacks carried, so
      // the parts signature is reused verbatim rather than recomputed. Resolving the
      // list itself is deferred past the diff: it costs an `applicability` call per
      // medical stack, which is not work to repeat sixty times a second.
      const medicalNext = player.inventory.slots
        .map((slot, index) => {
          if (!slot) return '';
          const def = ctx.data.items.get(slot.defId);
          if (!def?.medical) return '';
          return `${index}:${slot.defId}x${slot.count}`;
        })
        .filter((entry) => entry !== '')
        .join(',');
      const treatNext = `${bodyNext}|${busy ? 'busy' : 'ready'}|${medicalNext}`;
      if (treatNext !== treatSignature) {
        treatSignature = treatNext;
        renderTreatments(ctx, view, part, collectTreatments(ctx, player, part), busy);
      }
    },
  };
}
