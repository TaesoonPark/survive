import type { EntitySnapshot, ItemStack, PlayerState } from '@survive/protocol';
import type { GameData } from '@survive/game-data';
import { RARITY_COLOR, UI, cssColor } from '../art/palette';
import { TextureKey } from '../art/textures';

/**
 * A small DOM toolkit for the game's interface.
 *
 * The HUD and panels are DOM, not Phaser objects. An inventory grid with drag and drop,
 * a scrolling recipe list and a tooltip are all things the browser already does well, and
 * doing them in canvas would mean reimplementing hit testing, focus and text layout for
 * no visual gain. Phaser keeps the world; the DOM keeps the interface.
 *
 * A side benefit: the Playwright gameplay tests can assert on real elements and real
 * text instead of pixel-diffing a canvas.
 */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: {
    className?: string;
    text?: string;
    html?: string;
    title?: string;
    attrs?: Record<string, string>;
    children?: (Node | null | undefined)[];
    on?: Partial<{ [E in keyof HTMLElementEventMap]: (event: HTMLElementEventMap[E]) => void }>;
  } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.html !== undefined) node.innerHTML = options.html;
  if (options.title) node.title = options.title;
  for (const [key, value] of Object.entries(options.attrs ?? {})) node.setAttribute(key, value);
  for (const child of options.children ?? []) if (child) node.append(child);
  for (const [event, handler] of Object.entries(options.on ?? {})) {
    node.addEventListener(event, handler as EventListener);
  }
  return node;
}

/** Turn an id like `wood_log` into `Wood Log`. */
export function humanize(id: string): string {
  return id
    .split('_')
    .map((part) => (part.length > 0 ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(' ');
}

/**
 * The texture manager holds every item icon as a canvas; pull it out as a data URL so a
 * plain `<img>` can show it. Cached, because `toDataURL` is not cheap.
 */
const iconCache = new Map<string, string>();

export function itemIconUrl(
  textures: { exists(key: string): boolean; get(key: string): { getSourceImage(): unknown } },
  defId: string,
): string | null {
  const cached = iconCache.get(defId);
  if (cached) return cached;
  const key = TextureKey.item(defId);
  if (!textures.exists(key)) return null;
  const source = textures.get(key).getSourceImage();
  if (!(source instanceof HTMLCanvasElement)) return null;
  const url = source.toDataURL();
  iconCache.set(defId, url);
  return url;
}

export interface SlotRenderOptions {
  stack: ItemStack | null;
  data: GameData;
  textures: Parameters<typeof itemIconUrl>[0];
  /** Shown in the corner, e.g. a hotbar number. */
  badge?: string;
  selected?: boolean;
  /** Marks the slot as a drop target during a drag. */
  droppable?: boolean;
}

/**
 * One inventory slot.
 *
 * Deliberately information-dense: count, durability, freshness and rarity all read at a
 * glance, because a survival inventory is a decision surface, not a list.
 */
export function itemSlot(options: SlotRenderOptions): HTMLDivElement {
  const { stack, data, textures } = options;
  const slot = el('div', { className: 'slot' });
  if (options.selected) slot.classList.add('slot--selected');
  if (options.droppable) slot.classList.add('slot--drop');

  if (options.badge) {
    slot.append(el('span', { className: 'slot-badge', text: options.badge }));
  }

  if (!stack) {
    slot.classList.add('slot--empty');
    return slot;
  }

  const def = data.items.get(stack.defId);
  slot.dataset.defId = stack.defId;
  slot.style.setProperty(
    '--rarity',
    cssColor(RARITY_COLOR[def?.rarity ?? 'common'] ?? RARITY_COLOR.common!),
  );

  const url = itemIconUrl(textures, stack.defId);
  if (url) {
    slot.append(
      el('img', { className: 'slot-icon', attrs: { src: url, alt: def?.name ?? stack.defId } }),
    );
  } else {
    slot.append(
      el('span', { className: 'slot-fallback', text: (def?.name ?? stack.defId).slice(0, 2) }),
    );
  }

  if (stack.count > 1) {
    slot.append(el('span', { className: 'slot-count', text: String(stack.count) }));
  }

  if (stack.durability !== undefined && def?.maxDurability) {
    const fraction = Math.max(0, Math.min(1, stack.durability / def.maxDurability));
    const bar = el('div', { className: 'slot-bar' });
    const fill = el('div', { className: 'slot-bar-fill' });
    fill.style.width = `${fraction * 100}%`;
    fill.style.background = cssColor(
      fraction > 0.5 ? UI.accent : fraction > 0.2 ? UI.warn : UI.danger,
    );
    bar.append(fill);
    slot.append(bar);
  } else if (stack.freshness !== undefined) {
    const bar = el('div', { className: 'slot-bar' });
    const fill = el('div', { className: 'slot-bar-fill' });
    fill.style.width = `${Math.max(0, Math.min(1, stack.freshness)) * 100}%`;
    fill.style.background = cssColor(stack.freshness > 0.35 ? UI.hunger : UI.danger);
    bar.append(fill);
    slot.append(bar);
  }

  if (stack.ammo !== undefined && def?.weapon?.magazineSize) {
    slot.append(
      el('span', { className: 'slot-ammo', text: `${stack.ammo}/${def.weapon.magazineSize}` }),
    );
  }

  return slot;
}

/** Multi-line tooltip text for an item. Used as the slot's `title`. */
export function itemTooltip(stack: ItemStack, data: GameData): string {
  const def = data.items.get(stack.defId);
  if (!def) return humanize(stack.defId);
  const lines: string[] = [def.name];
  if (def.description) lines.push(def.description);
  lines.push('');

  if (stack.durability !== undefined && def.maxDurability) {
    lines.push(`Condition ${Math.round((stack.durability / def.maxDurability) * 100)}%`);
  }
  if (stack.freshness !== undefined) {
    lines.push(`Freshness ${Math.round(stack.freshness * 100)}%`);
  }
  if (def.weapon) {
    const weapon = def.weapon;
    lines.push(`${weapon.damage} ${weapon.damageType} damage`);
    lines.push(`Reach ${Math.round(weapon.range)}, ${(weapon.attackTicks / 20).toFixed(2)}s swing`);
    if (weapon.magazineSize) lines.push(`Magazine ${weapon.magazineSize}`);
    if (weapon.twoHanded) lines.push('Two-handed');
  }
  if (def.tool) {
    lines.push(`Tool: ${def.tool.kinds.join(', ')} (tier ${def.tool.tier})`);
  }
  if (def.armor) {
    const parts = Object.keys(def.armor.coverage).join(', ');
    lines.push(`Protects: ${parts || 'nothing'}`);
    if (def.armor.warmth) lines.push(`Warmth +${def.armor.warmth}`);
  }
  if (def.food) {
    if (def.food.nutrition) lines.push(`Food +${def.food.nutrition}`);
    if (def.food.hydration) lines.push(`Water +${def.food.hydration}`);
    if (def.food.sicknessChance > 0) {
      lines.push(`Risk of illness: ${Math.round(def.food.sicknessChance * 100)}%`);
    }
  }
  if (def.drink) {
    lines.push(`Water +${def.drink.hydration}`);
    if (def.drink.sicknessChance > 0) {
      lines.push(`Risk of illness: ${Math.round(def.drink.sicknessChance * 100)}%`);
    }
  }
  if (def.medical) {
    lines.push(`Medical: ${def.medical.kind}`);
  }
  lines.push(`Weight ${(def.weight * stack.count).toFixed(1)} kg`);
  return lines.filter((line, index) => line !== '' || index > 0).join('\n');
}

/** A labelled progress bar, used for every vital. */
export function statBar(
  label: string,
  value: number,
  max: number,
  color: number,
  options: { invert?: boolean; compact?: boolean } = {},
): HTMLDivElement {
  // Needs (hunger, thirst, fatigue) are stored as "how bad is it"; the bar shows how
  // much is left, which is the direction a player reads instinctively.
  const shown = options.invert ? max - value : value;
  const fraction = max > 0 ? Math.max(0, Math.min(1, shown / max)) : 0;
  const bar = el('div', { className: options.compact ? 'bar bar--compact' : 'bar' });
  bar.append(el('span', { className: 'bar-label', text: label }));
  const track = el('div', { className: 'bar-track' });
  const fill = el('div', { className: 'bar-fill' });
  fill.style.width = `${fraction * 100}%`;
  fill.style.background = cssColor(color);
  track.append(fill);
  bar.append(track);
  bar.append(el('span', { className: 'bar-value', text: String(Math.round(shown)) }));
  return bar;
}

export function button(
  label: string,
  onClick: () => void,
  variant: 'primary' | 'default' | 'danger' = 'default',
  disabled = false,
): HTMLButtonElement {
  const node = el('button', {
    className: `btn btn--${variant}`,
    text: label,
    on: { click: onClick },
  });
  node.disabled = disabled;
  return node;
}

/** A panel frame with a title bar and a close button. */
export function panelFrame(
  title: string,
  onClose: () => void,
  body: HTMLElement,
  className = '',
): HTMLDivElement {
  return el('div', {
    className: `panel ${className}`.trim(),
    children: [
      el('header', {
        className: 'panel-head',
        children: [el('h2', { text: title }), button('×', onClose, 'default')],
      }),
      body,
    ],
  });
}

/** The whole interface's stylesheet, injected once. */
export function injectUiStyles(): void {
  if (document.getElementById('survive-ui-styles')) return;
  const style = document.createElement('style');
  style.id = 'survive-ui-styles';
  style.textContent = `
    .ui-root {
      position: fixed; inset: 0; z-index: 4;
      font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
      font-size: 13px; color: ${cssColor(UI.text)};
      /* The world must stay clickable: only actual widgets take the pointer. */
      pointer-events: none;
    }
    .ui-root * { box-sizing: border-box; }
    .ui-root .interactive, .ui-root button, .ui-root input, .ui-root select,
    .ui-root .panel, .ui-root .slot, .ui-root .hotbar { pointer-events: auto; }

    /* ---- HUD ---- */
    .hud-vitals {
      position: absolute; left: 16px; bottom: 16px; width: 210px;
      display: flex; flex-direction: column; gap: 4px;
    }
    .bar { display: flex; align-items: center; gap: 7px; }
    .bar-label {
      width: 30px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em;
      color: ${cssColor(UI.textMuted)};
    }
    .bar-track {
      flex: 1; height: 8px; background: rgba(0,0,0,0.55);
      border: 1px solid ${cssColor(UI.panelEdge)}; border-radius: 2px; overflow: hidden;
    }
    .bar-fill { height: 100%; transition: width 140ms linear; }
    .bar-value {
      width: 26px; text-align: right; font-family: monospace; font-size: 11px;
      color: ${cssColor(UI.textMuted)};
    }
    .bar--compact .bar-track { height: 5px; }

    .hud-clock {
      position: absolute; top: 14px; left: 50%; transform: translateX(-50%);
      display: flex; gap: 14px; align-items: baseline;
      padding: 6px 14px; background: ${cssColor(UI.panel, 0.7)};
      border: 1px solid ${cssColor(UI.panelEdge)}; border-radius: 6px;
      font-family: monospace;
    }
    .hud-clock .day { color: ${cssColor(UI.textMuted)}; font-size: 11px; }
    .hud-clock .time { font-size: 16px; }
    .hud-clock .weather { color: ${cssColor(UI.textMuted)}; font-size: 11px; }

    .hotbar {
      position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%);
      display: flex; gap: 5px;
    }

    .slot {
      position: relative; width: 46px; height: 46px;
      background: ${cssColor(UI.slot, 0.85)};
      border: 1px solid ${cssColor(UI.slotEdge)}; border-radius: 4px;
      display: grid; place-items: center; cursor: pointer;
    }
    .slot:hover { background: ${cssColor(UI.slotHover, 0.9)}; }
    .slot--selected { border-color: ${cssColor(UI.accent)}; box-shadow: 0 0 0 1px ${cssColor(UI.accent, 0.5)}; }
    .slot--drop { outline: 1px dashed ${cssColor(UI.accent, 0.7)}; }
    .slot--empty { background: ${cssColor(UI.slot, 0.5)}; }
    .slot[data-def-id]::after {
      content: ''; position: absolute; inset: -1px; border-radius: 4px;
      border: 1px solid var(--rarity, transparent); opacity: 0.55; pointer-events: none;
    }
    .slot-icon { width: 32px; height: 32px; image-rendering: pixelated; }
    .slot-fallback { font-size: 11px; color: ${cssColor(UI.textMuted)}; }
    .slot-count {
      position: absolute; right: 3px; bottom: 2px; font-family: monospace; font-size: 11px;
      text-shadow: 0 1px 2px #000;
    }
    .slot-badge {
      position: absolute; left: 3px; top: 1px; font-family: monospace; font-size: 9px;
      color: ${cssColor(UI.textMuted)};
    }
    .slot-ammo {
      position: absolute; left: 3px; bottom: 2px; font-family: monospace; font-size: 9px;
      color: ${cssColor(UI.warn)};
    }
    .slot-bar {
      position: absolute; left: 3px; right: 3px; bottom: 0; height: 2px;
      background: rgba(0,0,0,0.6);
    }
    .slot-bar-fill { height: 100%; }

    .hud-prompt {
      position: absolute; bottom: 78px; left: 50%; transform: translateX(-50%);
      padding: 4px 10px; background: ${cssColor(UI.panel, 0.8)};
      border: 1px solid ${cssColor(UI.panelEdge)}; border-radius: 4px;
      font-size: 12px; color: ${cssColor(UI.textMuted)};
    }
    .hud-prompt b { color: ${cssColor(UI.accent)}; }

    .hud-toasts {
      position: absolute; right: 16px; bottom: 16px; width: 260px;
      display: flex; flex-direction: column; gap: 4px; align-items: flex-end;
    }
    .toast {
      padding: 5px 9px; background: ${cssColor(UI.panel, 0.85)};
      border-left: 2px solid ${cssColor(UI.accent)}; border-radius: 3px;
      font-size: 12px; animation: toast-in 140ms ease-out;
    }
    @keyframes toast-in { from { opacity: 0; transform: translateY(4px); } }

    .hud-status {
      position: absolute; left: 16px; bottom: 132px;
      display: flex; flex-wrap: wrap; gap: 4px; max-width: 220px;
    }
    .effect-chip {
      padding: 2px 7px; border-radius: 999px; font-size: 10px; text-transform: uppercase;
      letter-spacing: 0.04em; background: ${cssColor(UI.slot, 0.85)};
      border: 1px solid ${cssColor(UI.slotEdge)};
    }
    .effect-chip--bad { border-color: ${cssColor(UI.danger)}; color: ${cssColor(UI.danger)}; }
    .effect-chip--good { border-color: ${cssColor(UI.accent)}; color: ${cssColor(UI.accent)}; }

    .hud-crosshair {
      position: absolute; width: 3px; height: 3px; border-radius: 50%;
      background: ${cssColor(UI.text, 0.7)}; transform: translate(-50%, -50%);
    }

    /* ---- Panels ---- */
    .panel-layer {
      position: absolute; inset: 0; display: flex; align-items: center;
      justify-content: center; gap: 12px; padding: 40px; flex-wrap: wrap;
    }
    .panel {
      background: ${cssColor(UI.panel, UI.panelAlpha)};
      border: 1px solid ${cssColor(UI.panelEdge)}; border-radius: 8px;
      max-height: calc(100vh - 90px); display: flex; flex-direction: column;
      box-shadow: 0 12px 40px rgba(0,0,0,0.5);
    }
    .panel-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 12px; border-bottom: 1px solid ${cssColor(UI.panelEdge)};
    }
    .panel-head h2 {
      margin: 0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em;
      color: ${cssColor(UI.textMuted)};
    }
    .panel-body { padding: 12px; overflow: auto; }
    .grid { display: grid; grid-template-columns: repeat(8, 46px); gap: 5px; }

    .btn {
      padding: 6px 11px; border-radius: 4px; font: inherit; font-size: 12px;
      font-weight: 600; cursor: pointer; background: ${cssColor(UI.slot)};
      border: 1px solid ${cssColor(UI.slotEdge)}; color: ${cssColor(UI.text)};
    }
    .btn:hover:not(:disabled) { background: ${cssColor(UI.slotHover)}; }
    .btn:disabled { opacity: 0.45; cursor: default; }
    .btn--primary { background: ${cssColor(UI.accent)}; border-color: ${cssColor(UI.accent)}; color: #0d1a0f; }
    .btn--danger { background: transparent; border-color: ${cssColor(UI.danger)}; color: ${cssColor(UI.danger)}; }

    .muted { color: ${cssColor(UI.textMuted)}; }
    .row { display: flex; gap: 8px; align-items: center; }
    .col { display: flex; flex-direction: column; gap: 8px; }
    .section-title {
      font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em;
      color: ${cssColor(UI.textMuted)}; margin: 10px 0 5px;
    }
  `;
  document.head.append(style);
}

/**
 * Tooltip text for something in the world: a resource node, a dropped item, a structure,
 * a creature.
 *
 * The information a player actually needs before acting, which for a node is "what tool,
 * and what do I get" - the two questions that otherwise get answered by walking over and
 * swinging at it. Nothing here is secret: it is all either in the data tables the client
 * ships or already in the snapshot it was sent.
 */
export function worldTooltip(
  snapshot: EntitySnapshot,
  data: GameData,
  player?: PlayerState | null,
): string | null {
  const lines: string[] = [];
  const condition = (health: number, maxHealth: number): string =>
    `Condition ${Math.round((health / Math.max(1, maxHealth)) * 100)}%`;

  switch (snapshot.k) {
    case 'node': {
      const def = data.nodes.get(snapshot.defId);
      if (!def) return humanize(snapshot.defId);
      lines.push(def.name);
      if (snapshot.depleted) {
        lines.push('', 'Depleted');
        break;
      }
      lines.push('', condition(snapshot.health, snapshot.maxHealth));
      if (def.toolKinds.length > 0) {
        const tools = def.toolKinds.join(' or ');
        const held = player
          ? holdsSuitableTool(player, def.toolKinds, def.minToolTier, data)
          : null;
        // Called out because `wrongToolMultiplier: 0` means the wrong tool does *nothing* -
        // the player swings, the node does not move, and there is no other feedback.
        const suffix = held === false ? ' - you have none' : '';
        lines.push(`Needs ${tools} (tier ${def.minToolTier})${suffix}`);
      } else {
        lines.push('Harvested by hand');
      }
      const yields = def.yields
        .map((entry) => {
          const name = data.items.get(entry.defId)?.name ?? humanize(entry.defId);
          const amount = entry.min === entry.max ? `${entry.min}` : `${entry.min}-${entry.max}`;
          const chance = entry.chance < 1 ? ` (${Math.round(entry.chance * 100)}%)` : '';
          return `${amount} ${name}${chance}`;
        })
        .slice(0, 5);
      if (yields.length > 0) lines.push(`Yields ${yields.join(', ')}`);
      if (def.skill) lines.push(`Trains ${def.skill}`);
      break;
    }
    case 'item': {
      // The same text the inventory shows, so an item on the ground reads exactly as it
      // will once picked up.
      return itemTooltip(snapshot.stack, data);
    }
    case 'structure': {
      const def = data.structures.get(snapshot.defId);
      if (!def) return humanize(snapshot.defId);
      lines.push(def.name);
      lines.push('');
      if (snapshot.progress < 1)
        lines.push(`Under construction ${Math.round(snapshot.progress * 100)}%`);
      lines.push(condition(snapshot.health, snapshot.maxHealth));
      const roles: string[] = [];
      if (def.container) roles.push('storage');
      if (def.door) roles.push(snapshot.door?.open ? 'door (open)' : 'door (closed)');
      if (def.station) roles.push(`${def.station} station`);
      if (def.bed) roles.push('bed');
      if (def.plot) roles.push('farm plot');
      if (roles.length > 0) lines.push(roles.join(', '));
      break;
    }
    case 'zombie': {
      const def = data.zombies.get(snapshot.defId);
      lines.push(def?.name ?? humanize(snapshot.defId));
      lines.push('', condition(snapshot.health, snapshot.maxHealth));
      if (snapshot.crawling) lines.push('Crawling');
      break;
    }
    case 'animal': {
      const def = data.animals.get(snapshot.defId);
      lines.push(def?.name ?? humanize(snapshot.defId));
      lines.push('', condition(snapshot.health, snapshot.maxHealth));
      break;
    }
    case 'player':
      lines.push(snapshot.name);
      break;
    default:
      return null;
  }
  return lines.length > 0 ? lines.join('\n') : null;
}

/** Does the player hold a tool of one of these kinds, at this tier or better? */
function holdsSuitableTool(
  player: PlayerState,
  kinds: readonly string[],
  minTier: number,
  data: GameData,
): boolean {
  const candidates = [player.equipment.mainHand, ...player.inventory.slots];
  for (const stack of candidates) {
    if (!stack) continue;
    const tool = data.items.get(stack.defId)?.tool;
    if (!tool || tool.tier < minTier) continue;
    if (tool.kinds.some((kind) => kinds.includes(kind))) return true;
  }
  return false;
}
