import { UI, cssColor } from '../art/palette';
import { el } from './kit';

/**
 * The tooltip layer.
 *
 * One element, reused. Item slots used the browser's own `title` attribute, which is free
 * but wrong for a game: it waits about a second before appearing, renders in the OS style
 * rather than the game's, collapses the line breaks that make an item's stats readable,
 * and cannot be attached to anything drawn on the canvas - so resource nodes, the things a
 * player most wants to inspect before swinging at them, had no tooltip at all.
 *
 * Lives outside `.ui-root` and never takes the pointer, so it can be positioned over a
 * panel without the cursor ever entering it - a tooltip that can be hovered flickers.
 */

/** How long the cursor must rest before a tooltip appears, in milliseconds. */
const HOVER_DELAY_MS = 90;

/** Gap between the cursor and the tooltip, in pixels. */
const CURSOR_GAP = 14;

let layer: HTMLDivElement | null = null;
let hideTimer: number | null = null;
/** Which source owns the tooltip: a DOM node, or the world under the cursor. */
let owner: unknown = null;

function ensureLayer(): HTMLDivElement {
  if (layer) return layer;
  injectTooltipStyles();
  layer = el('div', { className: 'tip' });
  layer.style.display = 'none';
  document.body.append(layer);
  return layer;
}

/**
 * Place the tooltip near a point, flipping rather than sliding at the viewport edge.
 *
 * Sliding a tooltip along the edge puts it on top of the thing it describes, which for an
 * inventory grid means it covers the neighbouring slots the player is comparing.
 */
function position(node: HTMLDivElement, x: number, y: number): void {
  // Measured after the content is set, so the flip decision uses the real size.
  const width = node.offsetWidth;
  const height = node.offsetHeight;
  const overflowRight = x + CURSOR_GAP + width > window.innerWidth;
  const overflowBottom = y + CURSOR_GAP + height > window.innerHeight;
  const left = overflowRight ? Math.max(4, x - CURSOR_GAP - width) : x + CURSOR_GAP;
  const top = overflowBottom ? Math.max(4, y - CURSOR_GAP - height) : y + CURSOR_GAP;
  node.style.left = `${Math.round(left)}px`;
  node.style.top = `${Math.round(top)}px`;
}

/**
 * Show `text` at a screen position, owned by `source`.
 *
 * `source` is how two callers stay out of each other's way: a slot the cursor is over and
 * the world under that same cursor would otherwise fight for the layer every frame.
 */
export function showTooltip(source: unknown, text: string, x: number, y: number): void {
  const node = ensureLayer();
  if (hideTimer !== null) {
    window.clearTimeout(hideTimer);
    hideTimer = null;
  }
  owner = source;
  // One line per entry, first line as the title. Text, never HTML: item and node names come
  // from the data tables, but a container's contents do not have to.
  const [title, ...rest] = text.split('\n');
  node.replaceChildren(
    el('div', { className: 'tip-title', text: title ?? '' }),
    ...rest.map((line) =>
      line === ''
        ? el('div', { className: 'tip-gap' })
        : el('div', { className: 'tip-line', text: line }),
    ),
  );
  node.style.display = '';
  position(node, x, y);
}

/**
 * Drop the tooltip if the element that owns it has left the document.
 *
 * `pointerleave` never fires for an element that is *removed* while the cursor is over it,
 * so closing the inventory on a hovered slot left its tooltip on screen, describing an item
 * in a panel that was no longer there. The same happens whenever a panel re-renders a slot
 * the cursor happens to be resting on.
 *
 * Polled once a frame rather than watched with a MutationObserver: the check is a single
 * property read, and the UI scene is already running every frame.
 */
export function pruneTooltip(): void {
  if (owner instanceof HTMLElement && !owner.isConnected) hideTooltip(owner);
}

/** Hide the tooltip, if `source` is the one currently showing it. */
export function hideTooltip(source: unknown): void {
  if (!layer || (owner !== null && owner !== source)) return;
  owner = null;
  layer.style.display = 'none';
}

/**
 * Give a DOM element a tooltip.
 *
 * `content` is a callback, called on hover rather than once at attach time, so a caller
 * whose element outlives the state it describes can read the current value. Returning null
 * means "nothing to say" and hides the tooltip, which is how an empty slot opts out.
 */
export function attachTooltip(node: HTMLElement, content: () => string | null): void {
  const show = (event: PointerEvent): void => {
    const text = content();
    if (!text) {
      hideTooltip(node);
      return;
    }
    showTooltip(node, text, event.clientX, event.clientY);
  };
  node.addEventListener('pointerenter', (event) => {
    // A brief rest before appearing, so sweeping the cursor across a grid of slots does not
    // strobe a tooltip for every slot on the way.
    if (hideTimer !== null) window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      hideTimer = null;
      show(event);
    }, HOVER_DELAY_MS);
  });
  node.addEventListener('pointermove', (event) => {
    if (owner === node) showTooltip(node, content() ?? '', event.clientX, event.clientY);
  });
  node.addEventListener('pointerleave', () => {
    if (hideTimer !== null) {
      window.clearTimeout(hideTimer);
      hideTimer = null;
    }
    hideTooltip(node);
  });
}

function injectTooltipStyles(): void {
  if (document.getElementById('survive-tooltip-styles')) return;
  const style = document.createElement('style');
  style.id = 'survive-tooltip-styles';
  style.textContent = `
    .tip {
      position: fixed; z-index: 12; pointer-events: none;
      max-width: 300px; padding: 7px 9px;
      background: ${cssColor(UI.panel, 0.97)};
      border: 1px solid ${cssColor(UI.panelEdge)}; border-radius: 3px;
      box-shadow: 0 4px 14px rgba(0,0,0,0.5);
      font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
      font-size: 12px; line-height: 1.42; color: ${cssColor(UI.text)};
    }
    .tip-title {
      font-weight: 600; color: ${cssColor(UI.text)};
      margin-bottom: 2px;
    }
    .tip-line { color: ${cssColor(UI.textMuted)}; white-space: pre-wrap; }
    .tip-gap { height: 5px; }

    .focus-label {
      position: fixed; z-index: 11; pointer-events: none;
      transform: translate(-50%, -100%);
      padding: 2px 7px; border-radius: 3px; white-space: nowrap;
      background: ${cssColor(UI.panel, 0.88)};
      border: 1px solid ${cssColor(UI.panelEdge)};
      font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
      font-size: 11px; letter-spacing: 0.02em; color: ${cssColor(UI.text)};
      text-shadow: 0 1px 2px rgba(0,0,0,0.8);
    }
  `;
  document.head.append(style);
}

let focusLabel: HTMLDivElement | null = null;

/**
 * A name tag over the thing the interact key is aimed at.
 *
 * Separate from the hover tooltip on purpose, and both can be up at once: they answer
 * different questions. The hover tooltip describes whatever the *cursor* is over, which is
 * usually not what the player is standing next to - and the interaction ring shows *that*
 * something is targeted without ever saying what. Standing in a thicket, the ring alone
 * leaves the player pressing the key to find out which bush they are about to strip.
 *
 * Deliberately just the name. The detail belongs in the tooltip the player asked for by
 * pointing at it; this one appears without being asked, so it stays small.
 */
export function showFocusLabel(text: string, x: number, y: number): void {
  if (!focusLabel) {
    injectTooltipStyles();
    focusLabel = el('div', { className: 'focus-label' });
    document.body.append(focusLabel);
  }
  if (focusLabel.textContent !== text) focusLabel.textContent = text;
  focusLabel.style.display = '';
  // Centred on the target and lifted clear of it; the transform keeps it centred whatever
  // the text width turns out to be.
  focusLabel.style.left = `${Math.round(x)}px`;
  focusLabel.style.top = `${Math.round(y)}px`;
}

export function hideFocusLabel(): void {
  if (focusLabel) focusLabel.style.display = 'none';
}

/** Drop the layer, for scene teardown. */
export function destroyTooltip(): void {
  layer?.remove();
  layer = null;
  focusLabel?.remove();
  focusLabel = null;
  owner = null;
  if (hideTimer !== null) {
    window.clearTimeout(hideTimer);
    hideTimer = null;
  }
}
