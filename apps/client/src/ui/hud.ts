import {
  BODY_PART_IDS,
  HARMFUL_EFFECTS,
  needsTreatment,
  totalBleeding,
  worstInfection,
  type EntitySnapshot,
  type PlayerState,
  type WeatherState,
  type WorldTimeState,
} from '@survive/protocol';
import type { GameData } from '@survive/game-data';
import { UI } from '../art/palette';
import { el, humanize, itemSlot, itemTooltip, statBar } from './kit';
import { attachTooltip } from './tooltip';
import type { UiContext } from './panel';

/**
 * The heads-up display.
 *
 * Always visible, and deliberately restrained: vitals bottom-left, hotbar bottom-centre,
 * clock top, transient messages bottom-right. Everything else is a panel the player opens
 * on purpose.
 *
 * Rebuilt from state each frame, but only the parts that changed — a full DOM rebuild at
 * 60fps would show up in the frame budget.
 */
export class Hud {
  readonly root: HTMLDivElement;

  private readonly vitals: HTMLDivElement;
  private readonly clock: HTMLDivElement;
  private readonly hotbar: HTMLDivElement;
  private readonly prompt: HTMLDivElement;
  private readonly toasts: HTMLDivElement;
  private readonly status: HTMLDivElement;

  private lastHotbarSignature = '';
  private lastStatusSignature = '';
  private lastClockSignature = '';
  private readonly toastNodes: Array<{ node: HTMLElement; expiresAt: number }> = [];

  constructor() {
    this.vitals = el('div', { className: 'hud-vitals' });
    this.clock = el('div', { className: 'hud-clock' });
    this.hotbar = el('div', { className: 'hotbar' });
    this.prompt = el('div', { className: 'hud-prompt' });
    this.toasts = el('div', { className: 'hud-toasts' });
    this.status = el('div', { className: 'hud-status' });
    this.prompt.style.display = 'none';

    this.root = el('div', {
      className: 'hud',
      children: [this.clock, this.vitals, this.status, this.hotbar, this.prompt, this.toasts],
    });
  }

  /** Rebuild the vitals column. Cheap: six bars. */
  private renderVitals(player: PlayerState): void {
    this.vitals.replaceChildren(
      statBar('HP', player.health, player.maxHealth, UI.health),
      statBar('STAM', player.stamina, player.maxStamina, UI.stamina, { compact: true }),
      // Needs are stored as "how bad": show what is left, which is how a player reads it.
      statBar('FOOD', player.hunger, 100, UI.hunger, { invert: true, compact: true }),
      statBar('WATER', player.thirst, 100, UI.thirst, { invert: true, compact: true }),
      statBar('REST', player.fatigue, 100, UI.fatigue, { invert: true, compact: true }),
      statBar('BLOOD', player.blood, 100, UI.bleed, { compact: true }),
    );
  }

  private renderClock(
    time: WorldTimeState | null,
    weather: WeatherState | null,
    latency: number,
  ): void {
    if (!time) return;
    const clockText = `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`;
    const signature = `${time.day}|${clockText}|${weather?.type ?? ''}|${Math.round(
      weather?.temperature ?? 0,
    )}|${Math.round(latency / 10)}`;
    if (signature === this.lastClockSignature) return;
    this.lastClockSignature = signature;

    this.clock.replaceChildren(
      el('span', { className: 'day', text: `Day ${time.day} · ${time.season}` }),
      el('span', { className: 'time', text: clockText }),
      el('span', {
        className: 'weather',
        text: weather ? `${weather.type} ${Math.round(weather.temperature)}°C` : '',
      }),
      el('span', { className: 'weather', text: latency > 0 ? `${Math.round(latency)}ms` : '' }),
    );
  }

  /**
   * The hotbar.
   *
   * Diffed against a signature string rather than rebuilt: this is eight slots with
   * icons, and re-creating the images every frame is visible jank.
   */
  private renderHotbar(player: PlayerState, ctx: UiContext): void {
    const signature = player.hotbar
      .map((slotIndex) => {
        if (slotIndex === null) return '-';
        const stack = player.inventory.slots[slotIndex];
        return stack ? `${stack.defId}x${stack.count}:${Math.round(stack.durability ?? 0)}` : '-';
      })
      .join('|')
      .concat(`#${player.activeHotbar}`, `#${player.equipment.mainHand?.defId ?? '-'}`);
    if (signature === this.lastHotbarSignature) return;
    this.lastHotbarSignature = signature;

    const slots = player.hotbar.map((slotIndex, index) => {
      const stack = slotIndex === null ? null : (player.inventory.slots[slotIndex] ?? null);
      const node = itemSlot({
        stack,
        data: ctx.data,
        textures: ctx.textures,
        badge: String(index + 1),
        selected: index === player.activeHotbar,
      });
      if (stack) attachTooltip(node, () => itemTooltip(stack, ctx.data));
      node.addEventListener('click', () => ctx.send({ type: 'selectHotbar', index }));
      return node;
    });

    // The main hand sits at the end of the bar, so the player can always see what they
    // are actually holding even if it is not in a hotbar slot.
    const held = player.equipment.mainHand;
    const heldSlot = itemSlot({
      stack: held,
      data: ctx.data,
      textures: ctx.textures,
      badge: 'HAND',
      selected: true,
    });
    if (held) heldSlot.title = itemTooltip(held, ctx.data);

    this.hotbar.replaceChildren(...slots, heldSlot);
  }

  /** Status chips: the conditions the player needs to act on. */
  private renderStatus(player: PlayerState): void {
    const chips: Array<{ text: string; tone: 'bad' | 'good' | 'neutral' }> = [];

    for (const effect of player.effects) {
      chips.push({
        text: humanize(effect.id),
        tone: HARMFUL_EFFECTS.includes(effect.id) ? 'bad' : 'good',
      });
    }
    const bleeding = totalBleeding(player.body);
    if (bleeding > 0) chips.push({ text: `bleeding ${bleeding.toFixed(1)}`, tone: 'bad' });
    const infection = worstInfection(player.body);
    if (infection > 0) chips.push({ text: `infection ${Math.round(infection)}%`, tone: 'bad' });
    for (const part of BODY_PART_IDS) {
      if (player.body.parts[part].fractured) {
        chips.push({ text: `${humanize(part)} fractured`, tone: 'bad' });
      }
    }
    if (player.craftQueue.length > 0) {
      chips.push({ text: `crafting ${player.craftQueue.length}`, tone: 'neutral' });
    }
    if (player.carryWeight > player.carryCapacity) {
      chips.push({ text: 'overloaded', tone: 'bad' });
    }
    if (needsTreatment(player.body) && chips.length === 0) {
      chips.push({ text: 'injured', tone: 'bad' });
    }

    const signature = chips.map((chip) => `${chip.text}:${chip.tone}`).join('|');
    if (signature === this.lastStatusSignature) return;
    this.lastStatusSignature = signature;

    this.status.replaceChildren(
      ...chips.map((chip) =>
        el('span', {
          className: `effect-chip${chip.tone === 'neutral' ? '' : ` effect-chip--${chip.tone}`}`,
          text: chip.text,
        }),
      ),
    );
  }

  /** The "press E to …" line. */
  private renderPrompt(focus: EntitySnapshot | undefined, data: GameData): void {
    if (!focus) {
      this.prompt.style.display = 'none';
      return;
    }
    let label: string | null = null;
    switch (focus.k) {
      case 'item':
        label = `pick up ${humanize(focus.stack.defId)}`;
        break;
      case 'node':
        label = `harvest ${data.nodes.get(focus.defId)?.name ?? humanize(focus.defId)}`;
        break;
      case 'structure': {
        const def = data.structures.get(focus.defId);
        if (!def) break;
        if (def.door) label = focus.door?.open ? `close ${def.name}` : `open ${def.name}`;
        else if (def.container) label = `search ${def.name}`;
        else if (def.station) label = `use ${def.name}`;
        else if (def.bed) label = `sleep in ${def.name}`;
        else if (def.plot) label = `tend ${def.name}`;
        break;
      }
      default:
        break;
    }
    if (!label) {
      this.prompt.style.display = 'none';
      return;
    }
    this.prompt.style.display = '';
    this.prompt.innerHTML = `<b>E</b> ${label}`;
  }

  /** Push a transient message. */
  toast(text: string, nowMs: number): void {
    const node = el('div', { className: 'toast', text });
    this.toasts.append(node);
    this.toastNodes.push({ node, expiresAt: nowMs + 4200 });
    // Cap the stack so a burst of events cannot fill the screen.
    while (this.toastNodes.length > 6) {
      this.toastNodes.shift()?.node.remove();
    }
  }

  private expireToasts(nowMs: number): void {
    for (let i = this.toastNodes.length - 1; i >= 0; i--) {
      const entry = this.toastNodes[i];
      if (!entry) continue;
      if (entry.expiresAt > nowMs) continue;
      entry.node.remove();
      this.toastNodes.splice(i, 1);
    }
  }

  update(
    ctx: UiContext,
    player: PlayerState | null,
    time: WorldTimeState | null,
    weather: WeatherState | null,
    focus: EntitySnapshot | undefined,
    latency: number,
    nowMs: number,
  ): void {
    this.expireToasts(nowMs);
    if (!player) {
      this.root.style.opacity = '0.2';
      return;
    }
    this.root.style.opacity = '1';
    this.renderVitals(player);
    this.renderClock(time, weather, latency);
    this.renderHotbar(player, ctx);
    this.renderStatus(player);
    this.renderPrompt(focus, ctx.data);
  }
}
