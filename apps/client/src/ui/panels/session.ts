import {
  DAYS_PER_SEASON,
  RECONCILE_SNAP_DISTANCE,
  SEASONS,
  SIM_HZ,
  TICKS_PER_GAME_DAY,
  TICKS_PER_GAME_HOUR,
  TICKS_PER_GAME_MINUTE,
  TILE_SIZE,
  chunkKeyAtPixel,
  type ChatChannel,
  type PlayerState,
  type PlayerStats,
  type SimEvent,
} from '@survive/protocol';
import { DEFAULT_BINDINGS, type ControlBindings } from '../../input/controls';
import { UI, cssColor } from '../../art/palette';
import { button, el, humanize, panelFrame } from '../kit';
import { t } from '../strings';
import type { Panel, UiContext } from '../panel';

/**
 * The four session panels: chat, death, pause and debug.
 *
 * They share a file because they share almost nothing with the gameplay screens and
 * quite a lot with each other: they are all thin readouts over `session` plus at most
 * one intent, and they all need the same clock arithmetic, the same key-name
 * prettifier and the same "write text only when it changed" discipline. Splitting them
 * into four files would duplicate those helpers four times.
 *
 * Two rules run through all of them, as everywhere else in the client:
 *
 * 1. **The server decides.** Nothing here kills, respawns, pauses or delivers a chat
 *    line. Each button turns into a command and the next snapshot is what changes the
 *    display — including the pause panel, which shows what the server actually did
 *    rather than what it was asked to do.
 * 2. **Diff before rebuilding.** `update` runs once per rendered frame, and three of
 *    these four panels show numbers that move every frame. None of them rebuild: they
 *    keep their value nodes and write `textContent` only when the string differs,
 *    which is the difference between a free overlay and a visible hitch.
 */

const STYLE_ID = 'survive-session-panel-styles';

/**
 * Panel-local styles.
 *
 * Injected from here behind a guarded unique id rather than added to `kit.ts`: a docked
 * chat log and a monospaced netgraph are layouts nothing else needs. Everything shared
 * — `.panel`, `.panel-body`, `.btn`, `.muted`, `.row`, `.col`, `.section-title`,
 * `.effect-chip` — is reused as it stands.
 */
function injectSessionStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    /* ---- chat: docked bottom-left, clear of the vitals column and status chips ---- */
    .panel--chat {
      position: absolute; left: 16px; bottom: 180px;
      width: min(380px, 44vw); max-height: 40vh;
    }
    .chat-body { display: flex; flex-direction: column; gap: 8px; overflow: hidden; padding: 9px 10px; }
    .chat-log {
      flex: 1 1 auto; min-height: 90px; max-height: 26vh; overflow-y: auto;
      display: flex; flex-direction: column; gap: 2px; padding-right: 3px;
    }
    .chat-line { display: flex; gap: 5px; align-items: baseline; font-size: 12px; line-height: 1.35; }
    .chat-line-chan {
      flex: none; font-family: monospace; font-size: 9px; text-transform: uppercase;
      letter-spacing: 0.06em; padding: 0 3px; border-radius: 2px;
      border: 1px solid ${cssColor(UI.slotEdge)}; color: ${cssColor(UI.textMuted)};
    }
    .chat-line-chan--global { border-color: ${cssColor(UI.thirst, 0.8)}; color: ${cssColor(UI.thirst)}; }
    .chat-line-chan--system { border-color: ${cssColor(UI.warn, 0.8)}; color: ${cssColor(UI.warn)}; }
    .chat-line-name { flex: none; font-weight: 600; }
    .chat-line-text { min-width: 0; overflow-wrap: anywhere; }
    /* A line this client echoed locally and has had no confirmation of. */
    .chat-line--unconfirmed { opacity: 0.6; font-style: italic; }
    .chat-form { display: flex; gap: 6px; align-items: center; flex: none; }
    .chat-input {
      flex: 1; min-width: 0; padding: 5px 8px; font: inherit; font-size: 12px;
      color: ${cssColor(UI.text)}; background: ${cssColor(UI.slot)};
      border: 1px solid ${cssColor(UI.slotEdge)}; border-radius: 4px;
    }
    .chat-input:focus { outline: none; border-color: ${cssColor(UI.accent)}; }
    .chat-channel {
      flex: none; padding: 5px 6px; font: inherit; font-size: 11px;
      color: ${cssColor(UI.text)}; background: ${cssColor(UI.slot)};
      border: 1px solid ${cssColor(UI.slotEdge)}; border-radius: 4px;
    }
    .chat-form .btn { padding: 5px 9px; font-size: 11px; }

    /* ---- death: a true centred takeover, whatever else happens to be open ---- */
    .panel--death, .panel--pause {
      position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
    }
    .panel--death { width: min(460px, 92vw); z-index: 1; }
    /* The dim sits behind the panel's own background but inside its stacking context. */
    .panel--death::before {
      content: ''; position: fixed; inset: 0; z-index: -1; pointer-events: none;
      background: rgba(6, 8, 9, 0.66);
    }
    .death-body { display: flex; flex-direction: column; gap: 10px; }
    .death-cause { font-size: 17px; font-weight: 600; color: ${cssColor(UI.danger)}; }
    .death-when { font-family: monospace; font-size: 12px; color: ${cssColor(UI.textMuted)}; }
    .death-count {
      font-family: monospace; font-size: 13px; padding: 6px 9px; border-radius: 4px;
      background: rgba(0, 0, 0, 0.35); border: 1px solid ${cssColor(UI.slotEdge)};
    }
    .death-count--ready { border-color: ${cssColor(UI.accent, 0.8)}; color: ${cssColor(UI.accent)}; }
    .death-stats { display: grid; grid-template-columns: 1fr auto; gap: 2px 12px; }
    .death-stats dt { font-size: 12px; color: ${cssColor(UI.textMuted)}; }
    .death-stats dd { margin: 0; font-family: monospace; font-size: 12px; text-align: right; }
    .death-actions { display: flex; gap: 8px; flex-wrap: wrap; }

    /* ---- pause ---- */
    .panel--pause { width: min(420px, 92vw); }
    .pause-body { display: flex; flex-direction: column; gap: 10px; }
    .pause-status {
      font-size: 12px; padding: 6px 9px; border-radius: 4px;
      background: rgba(0, 0, 0, 0.35); border: 1px solid ${cssColor(UI.slotEdge)};
    }
    .pause-status--paused { border-color: ${cssColor(UI.accent, 0.8)}; color: ${cssColor(UI.accent)}; }
    .pause-status--live { border-color: ${cssColor(UI.warn, 0.8)}; color: ${cssColor(UI.warn)}; }
    .pause-controls {
      display: grid; grid-template-columns: 1fr auto; gap: 1px 12px;
      max-height: 42vh; overflow-y: auto;
    }
    .pause-controls dt { font-size: 12px; color: ${cssColor(UI.textMuted)}; }
    .pause-controls dd { margin: 0; font-family: monospace; font-size: 11px; text-align: right; }
    .pause-actions { display: flex; gap: 8px; flex-wrap: wrap; }

    /* ---- debug: docked top-right, small, monospaced ---- */
    .panel--debug {
      position: absolute; top: 14px; right: 14px; width: 234px;
      /* captures: false, so the world underneath must stay clickable through it. */
      pointer-events: none;
    }
    /* …except the close button, which would otherwise be a control that looks live
       and does nothing. F3 toggles the overlay too, but the × must still work. */
    .panel--debug .panel-head .btn { pointer-events: auto; }
    .dbg-body { display: flex; flex-direction: column; gap: 1px; padding: 8px 9px; }
    .dbg-row { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
    .dbg-key {
      font-size: 9px; text-transform: uppercase; letter-spacing: 0.07em;
      color: ${cssColor(UI.textMuted)};
    }
    .dbg-val { font-family: monospace; font-size: 11px; text-align: right; }
    .dbg-val--good { color: ${cssColor(UI.accent)}; }
    .dbg-val--warn { color: ${cssColor(UI.warn)}; }
    .dbg-val--bad { color: ${cssColor(UI.danger)}; }
    /* The two numbers that make netcode bugs visible get their own weight. */
    .dbg-row--headline .dbg-val { font-size: 13px; font-weight: 600; }
    .dbg-sep { height: 1px; margin: 4px 0; background: ${cssColor(UI.panelEdge)}; }
  `;
  document.head.append(style);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Turn `zombieBite` or `wood_log` into `Zombie Bite` / `Wood Log`. */
function labelFor(id: string): string {
  return humanize(id.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase());
}

/**
 * Write text into a retained node, but only when it actually changed.
 *
 * Every panel here updates at frame rate. Assigning an identical string still dirties
 * the node for the browser's next style pass, so the guard is not pedantry.
 */
function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

function setClass(node: HTMLElement, className: string): void {
  if (node.className !== className) node.className = className;
}

/**
 * The in-game calendar at an arbitrary tick.
 *
 * The world clock is a pure function of the tick (see `timeSystem` in the simulation),
 * so deriving "when did I die" from `deathTick` locally is arithmetic on an
 * authoritative number, not a decision: `session.time` only ever holds *now*, and the
 * death screen has to talk about a moment in the past.
 */
function calendarAt(tick: number): { day: number; hour: number; minute: number; season: string } {
  const safe = Math.max(0, Math.floor(tick));
  const dayIndex = Math.floor(safe / TICKS_PER_GAME_DAY);
  const withinDay = safe % TICKS_PER_GAME_DAY;
  return {
    day: dayIndex + 1,
    hour: Math.floor(withinDay / TICKS_PER_GAME_HOUR),
    minute: Math.floor((withinDay % TICKS_PER_GAME_HOUR) / TICKS_PER_GAME_MINUTE),
    season: SEASONS[Math.floor(dayIndex / DAYS_PER_SEASON) % SEASONS.length] ?? 'spring',
  };
}

function clockText(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** A `KeyboardEvent.code` as a player would recognise it on their keyboard. */
function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  switch (code) {
    case 'ArrowUp':
      return '↑';
    case 'ArrowDown':
      return '↓';
    case 'ArrowLeft':
      return '←';
    case 'ArrowRight':
      return '→';
    case 'ShiftLeft':
      return 'Left Shift';
    case 'ShiftRight':
      return 'Right Shift';
    case 'ControlLeft':
      return 'Left Ctrl';
    case 'ControlRight':
      return 'Right Ctrl';
    case 'AltLeft':
      return 'Left Alt';
    case 'AltRight':
      return 'Right Alt';
    case 'Escape':
      return 'Esc';
    case 'Space':
      return 'Space';
    default:
      return code;
  }
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

/** One line in the chat log. `name`/`text` are untrusted and only ever set as text. */
interface ChatEntry {
  /** Monotonic id, so the view can append instead of rebuilding. */
  id: number;
  name: string;
  text: string;
  channel: string;
  /**
   * True while this is nothing but a local echo of something this client sent. The
   * server may have rejected it (rate limit, mute, a channel this player cannot use),
   * and until a `chat` event confirms it, the panel says so rather than implying the
   * line was delivered.
   */
  unconfirmed: boolean;
}

/** How many lines to keep. A long session must not grow the log without bound. */
const CHAT_LOG_LIMIT = 120;

/**
 * The chat log.
 *
 * Chat arrives as a `chat` {@link SimEvent}, and a panel cannot see events: the game
 * scene installs the session's single listener set (`setListeners` replaces it
 * wholesale) and `GameSession` keeps no event buffer for anyone else to read. Editing
 * `session.ts` to add one is out of scope for this file, so the buffer lives here
 * instead, module-scoped so it survives the panel being closed and reopened.
 *
 * The honest consequence, stated plainly rather than hidden: what this log shows is
 * the lines *this* client sent — echoed locally and marked unconfirmed — plus whatever
 * is handed to {@link ingestChatEvents}. Other players' messages will not appear until
 * something that does see the event stream calls that function.
 */
const chatLog: ChatEntry[] = [];
let chatSequence = 0;

function appendChatEntry(name: string, text: string, channel: string, unconfirmed: boolean): void {
  chatSequence += 1;
  chatLog.push({ id: chatSequence, name, text, channel, unconfirmed });
  while (chatLog.length > CHAT_LOG_LIMIT) chatLog.shift();
}

/**
 * Promote the most recent matching local echo to confirmed.
 *
 * @returns true when an echo was matched, meaning the caller must not append a
 * duplicate line for the same message.
 */
function confirmChatEcho(name: string, text: string, channel: string): boolean {
  for (let i = chatLog.length - 1; i >= 0; i--) {
    const entry = chatLog[i];
    if (!entry) continue;
    if (!entry.unconfirmed) continue;
    if (entry.text !== text || entry.channel !== channel || entry.name !== name) continue;
    entry.unconfirmed = false;
    return true;
  }
  return false;
}

/**
 * Feed authoritative chat into the log.
 *
 * The seam for whoever owns the event stream: hand it an event batch and every `chat`
 * event in it becomes a line, with this client's own messages reconciled against the
 * local echo instead of appearing twice. Anything that is not a chat event is ignored,
 * so a caller can pass a whole batch.
 */
export function ingestChatEvents(events: readonly SimEvent[]): void {
  for (const event of events) {
    if (event.type !== 'chat') continue;
    if (confirmChatEcho(event.name, event.text, event.channel)) continue;
    appendChatEntry(event.name, event.text, event.channel, false);
  }
}

/** Channels a player may choose. `system` exists in the protocol but is server-only. */
const CHAT_CHANNELS: readonly ChatChannel[] = ['local', 'global'];

/** Server-side chat is length-limited; stop the field long before it gets there. */
const CHAT_MAX_LENGTH = 200;

/**
 * The chat panel.
 *
 * Docked bottom-left above the vitals so it reads as part of the HUD rather than as a
 * screen the player is stuck in, and `captures: true` because while it is open the
 * keyboard belongs to the text field, not to movement.
 */
export function createChatPanel(): Panel {
  let channel: ChatChannel = 'local';
  /** Latest context, so handlers built once always send through the live session. */
  let ui: UiContext | null = null;
  /** Highest entry id already in the DOM. */
  let renderedTo = 0;
  /** Rendered line nodes by entry id, for eviction and for the confirmed/unconfirmed flip. */
  const lineNodes = new Map<number, { node: HTMLElement; unconfirmed: boolean }>();
  let wantsFocus = false;

  interface Parts {
    log: HTMLDivElement;
    input: HTMLInputElement;
    select: HTMLSelectElement;
    body: HTMLDivElement;
  }
  let parts: Parts | null = null;

  function submit(): void {
    const context = ui;
    if (!parts || !context) return;
    const text = parts.input.value.trim().slice(0, CHAT_MAX_LENGTH);
    // An empty Enter is how a player dismisses the field, not a message.
    if (text.length === 0) {
      parts.input.value = '';
      return;
    }
    // `channel` is whatever the selector says, defaulting to 'local' — the server
    // decides who actually receives it, and rejects a channel this player may not use.
    context.send({ type: 'chat', text, channel });
    // Echoed under the player's authoritative name, marked unconfirmed: see ChatEntry.
    appendChatEntry(context.session.self?.name ?? 'you', text, channel, true);
    parts.input.value = '';
  }

  function ensureParts(): Parts {
    if (parts) return parts;

    const log = el('div', {
      className: 'chat-log',
      attrs: {
        role: 'log',
        'aria-live': 'polite',
        'aria-label': 'Chat messages',
        'data-testid': 'chat-log',
      },
    });

    const input = el('input', {
      className: 'chat-input',
      attrs: {
        type: 'text',
        placeholder: 'Say something…',
        maxlength: String(CHAT_MAX_LENGTH),
        autocomplete: 'off',
        'aria-label': 'Chat message',
        'data-testid': 'chat-input',
      },
      on: {
        keydown: (event: KeyboardEvent) => {
          // The field owns these two keys. The global handler already ignores keys
          // while a capturing panel is open, but stopping propagation keeps that true
          // no matter what else starts listening on window.
          if (event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            submit();
            return;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            ui?.close('chat');
          }
        },
      },
    });

    const select = el('select', {
      className: 'chat-channel',
      attrs: { 'aria-label': 'Chat channel', 'data-testid': 'chat-channel' },
      children: CHAT_CHANNELS.map((id) =>
        el('option', { text: labelFor(id), attrs: { value: id } }),
      ),
      on: {
        change: () => {
          const value = select.value;
          channel = value === 'global' ? 'global' : 'local';
          // Choosing a channel should not cost the player the text they were typing.
          input.focus();
        },
      },
    });
    select.value = channel;

    const send = button('Send', () => submit(), 'primary');
    send.setAttribute('data-testid', 'chat-send');

    const body = el('div', {
      className: 'panel-body chat-body',
      children: [log, el('div', { className: 'chat-form', children: [select, input, send] })],
    });

    parts = { log, input, select, body };
    return parts;
  }

  /** Append what is new and evict what the buffer has dropped. Never a full rebuild. */
  function renderLog(view: Parts): void {
    const live = new Set<number>();
    // Follow the tail only when the player is already at it, so scrolling back to read
    // is not yanked away by the next message.
    const atBottom = view.log.scrollHeight - view.log.scrollTop - view.log.clientHeight < 24;
    let appended = false;

    for (const entry of chatLog) {
      live.add(entry.id);
      const existing = lineNodes.get(entry.id);
      if (existing) {
        if (existing.unconfirmed !== entry.unconfirmed) {
          existing.unconfirmed = entry.unconfirmed;
          setClass(existing.node, `chat-line${entry.unconfirmed ? ' chat-line--unconfirmed' : ''}`);
        }
        continue;
      }
      if (entry.id <= renderedTo) continue;

      const channelClass =
        entry.channel === 'global' || entry.channel === 'system'
          ? ` chat-line-chan--${entry.channel}`
          : '';
      // `text:` sets textContent. Another player's name and message are untrusted
      // input and never touch innerHTML anywhere in this file.
      const node = el('div', {
        className: `chat-line${entry.unconfirmed ? ' chat-line--unconfirmed' : ''}`,
        children: [
          el('span', {
            className: `chat-line-chan${channelClass}`,
            text: entry.channel.slice(0, 3),
            title: `${entry.channel} channel`,
          }),
          el('span', { className: 'chat-line-name', text: `${entry.name}:` }),
          el('span', { className: 'chat-line-text', text: entry.text }),
        ],
      });
      if (entry.unconfirmed) node.title = 'Sent — not yet confirmed by the server';
      view.log.append(node);
      lineNodes.set(entry.id, { node, unconfirmed: entry.unconfirmed });
      renderedTo = entry.id;
      appended = true;
    }

    for (const [id, rendered] of lineNodes) {
      if (live.has(id)) continue;
      rendered.node.remove();
      lineNodes.delete(id);
    }

    if (appended && atBottom) view.log.scrollTop = view.log.scrollHeight;
  }

  return {
    id: 'chat',
    title: t('panel.chat'),
    captures: true,

    mount(ctx: UiContext): HTMLElement {
      injectSessionStyles();
      ui = ctx;
      const view = ensureParts();
      // Opening chat is a request to type: focus on the first update, once the layer
      // has actually put the element in the document.
      wantsFocus = true;
      const root = panelFrame('Chat', () => ctx.close('chat'), view.body, 'panel--chat');
      root.setAttribute('data-testid', 'chat-panel');
      return root;
    },

    update(ctx: UiContext): void {
      ui = ctx;
      const view = ensureParts();
      if (wantsFocus) {
        wantsFocus = false;
        view.input.focus();
      }
      if (view.select.value !== channel) view.select.value = channel;
      renderLog(view);
    },

    unmount(): void {
      // The buffer outlives the panel; the DOM does not. Forget the nodes so a reopen
      // re-renders the surviving lines into the fresh log element.
      lineNodes.clear();
      renderedTo = 0;
      parts = null;
      ui = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Death
// ---------------------------------------------------------------------------

/**
 * Damage types and other causes, phrased as a sentence.
 *
 * `deathCause` is the simulation's `DamageType` (or a free-form string), which reads
 * like a debug label. A death screen is the one place the game should use words.
 */
const DEATH_CAUSE_TEXT: Record<string, string> = {
  blunt: 'Beaten to death',
  slash: 'Cut down',
  pierce: 'Run through',
  bullet: 'Shot dead',
  explosive: 'Caught in a blast',
  fire: 'Burned alive',
  bleed: 'Bled out',
  infection: 'Taken by infection',
  starvation: 'Starved to death',
  dehydration: 'Died of thirst',
  exhaustion: 'Collapsed from exhaustion',
  cold: 'Froze to death',
  heat: 'Died of heatstroke',
  fall: 'Died from the fall',
  poison: 'Poisoned',
  zombieBite: 'Torn apart by the dead',
  suffocation: 'Suffocated',
};

/** Lifetime counters, in the order the summary lists them. */
const STAT_ROWS: readonly (readonly [keyof PlayerStats, string])[] = [
  ['daysSurvived', 'Days survived'],
  ['zombieKills', 'Zombies killed'],
  ['animalKills', 'Animals killed'],
  ['playerKills', 'Players killed'],
  ['deaths', 'Deaths'],
  ['distanceTravelled', 'Distance walked'],
  ['itemsCrafted', 'Items crafted'],
  ['structuresBuilt', 'Structures built'],
  ['cropsHarvested', 'Crops harvested'],
  ['resourcesGathered', 'Resources gathered'],
];

function statValueText(key: keyof PlayerStats, stats: PlayerStats): string {
  // Distance is accumulated in world pixels; a tile is the unit a player can picture.
  if (key === 'distanceTravelled') return `${Math.round(stats[key] / TILE_SIZE)} tiles`;
  return String(Math.round(stats[key]));
}

/**
 * The death screen.
 *
 * `UiScene` opens this the moment an authoritative snapshot says the player is dead and
 * closes it when one says they are alive again, which is why there is no close button:
 * dismissing it would only make the panel reappear on the next frame, and the state it
 * describes is not the player's to dismiss.
 */
export function createDeathPanel(): Panel {
  let ui: UiContext | null = null;
  let lastHeaderSignature = '';
  let lastStatsSignature = '';
  let lastCountdown = '';
  let lastReady: boolean | null = null;
  let lastBedShown: boolean | null = null;

  interface Parts {
    cause: HTMLDivElement;
    when: HTMLDivElement;
    countdown: HTMLDivElement;
    stats: HTMLDListElement;
    respawn: HTMLButtonElement;
    respawnAtBed: HTMLButtonElement;
    body: HTMLDivElement;
  }
  let parts: Parts | null = null;

  function ensureParts(): Parts {
    if (parts) return parts;

    const cause = el('div', { className: 'death-cause', attrs: { 'data-testid': 'death-cause' } });
    const when = el('div', { className: 'death-when', attrs: { 'data-testid': 'death-when' } });
    const countdown = el('div', {
      className: 'death-count',
      attrs: { role: 'status', 'aria-live': 'polite', 'data-testid': 'death-countdown' },
    });
    const stats = el('dl', { className: 'death-stats', attrs: { 'data-testid': 'death-stats' } });

    const respawn = button(
      'Respawn',
      () => ui?.send({ type: 'respawn', atBed: false }),
      'primary',
      true,
    );
    respawn.setAttribute('data-testid', 'respawn-button');
    const respawnAtBed = button(
      'Respawn at bed',
      () => ui?.send({ type: 'respawn', atBed: true }),
      'default',
      true,
    );
    respawnAtBed.setAttribute('data-testid', 'respawn-at-bed-button');

    const body = el('div', {
      className: 'panel-body death-body',
      children: [
        cause,
        when,
        countdown,
        el('div', { className: 'section-title', text: 'This life' }),
        stats,
        el('div', {
          className: 'death-actions',
          children: [respawn, respawnAtBed],
        }),
      ],
    });

    parts = { cause, when, countdown, stats, respawn, respawnAtBed, body };
    return parts;
  }

  function renderHeader(view: Parts, player: PlayerState): void {
    const signature = `${player.deathCause ?? ''}|${player.deathTick}`;
    if (signature === lastHeaderSignature) return;
    lastHeaderSignature = signature;

    const cause = player.deathCause;
    setText(view.cause, cause ? (DEATH_CAUSE_TEXT[cause] ?? labelFor(cause)) : 'Cause unknown');

    if (player.deathTick < 0) {
      // Dead without a recorded tick should not happen, but an empty line is better
      // than inventing "Day 1, 00:00".
      setText(view.when, '');
      return;
    }
    const at = calendarAt(player.deathTick);
    setText(
      view.when,
      `Day ${at.day} · ${clockText(at.hour, at.minute)} · ${at.season} · tick ${player.deathTick}`,
    );
  }

  function renderStats(view: Parts, stats: PlayerStats): void {
    const signature = STAT_ROWS.map(([key]) => `${key}:${Math.round(stats[key])}`).join('|');
    if (signature === lastStatsSignature) return;
    lastStatsSignature = signature;

    const nodes: HTMLElement[] = [];
    for (const [key, label] of STAT_ROWS) {
      nodes.push(el('dt', { text: label }));
      nodes.push(el('dd', { text: statValueText(key, stats) }));
    }
    view.stats.replaceChildren(...nodes);
  }

  return {
    id: 'death',
    title: t('panel.death'),
    captures: true,

    mount(ctx: UiContext): HTMLElement {
      injectSessionStyles();
      ui = ctx;
      lastHeaderSignature = '';
      lastStatsSignature = '';
      lastCountdown = '';
      lastReady = null;
      lastBedShown = null;
      const view = ensureParts();
      const root = panelFrame('You died', () => ctx.close('death'), view.body, 'panel--death');
      // Drop the frame's close button instead of styling it away: a control that is
      // present but inert is worse for a screen reader and for a Playwright test than
      // one that was never there. The frame is still built by `panelFrame` so the
      // header matches every other panel.
      root.querySelector('.panel-head .btn')?.remove();
      root.setAttribute('data-testid', 'death-panel');
      return root;
    },

    update(ctx: UiContext): void {
      ui = ctx;
      const view = ensureParts();
      const player = ctx.session.self;
      if (!player) return;

      renderHeader(view, player);
      renderStats(view, player.stats);

      // The respawn gate is the server's: `respawnAtTick` against the tick of the last
      // snapshot. Ticks are SIM_HZ (20) per second, so the wait in seconds is the tick
      // difference over 20. The buttons stay disabled until it reaches zero, and the
      // server re-checks the same condition when the command lands.
      const tick = ctx.session.store.tick;
      const ticksLeft = Math.max(0, player.respawnAtTick - tick);
      const ready = tick >= 0 && ticksLeft === 0;
      const countdownText = ready
        ? 'Ready to respawn'
        : `Respawn in ${(ticksLeft / SIM_HZ).toFixed(1)}s`;
      if (countdownText !== lastCountdown) {
        lastCountdown = countdownText;
        setText(view.countdown, countdownText);
        setClass(view.countdown, `death-count${ready ? ' death-count--ready' : ''}`);
      }

      if (ready !== lastReady) {
        lastReady = ready;
        view.respawn.disabled = !ready;
        view.respawnAtBed.disabled = !ready;
      }

      // The bed button only means anything when the player owns a bed to return to.
      const bedShown = player.bedStructureId !== undefined;
      if (bedShown !== lastBedShown) {
        lastBedShown = bedShown;
        view.respawnAtBed.style.display = bedShown ? '' : 'none';
      }
    },

    unmount(): void {
      parts = null;
      ui = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Pause
// ---------------------------------------------------------------------------

/** The control reference, read from the live bindings so it cannot go stale. */
const CONTROL_ROWS: readonly (readonly [keyof ControlBindings, string])[] = [
  ['up', 'Move up'],
  ['down', 'Move down'],
  ['left', 'Move left'],
  ['right', 'Move right'],
  ['sprint', 'Sprint'],
  ['crouch', 'Crouch'],
  ['interact', 'Interact'],
  ['block', 'Block'],
  ['reload', 'Reload'],
  ['drop', 'Drop held item'],
  ['inventory', 'Inventory'],
  ['crafting', 'Crafting'],
  ['build', 'Build menu'],
  ['rotate', 'Rotate placement'],
  ['health', 'Health'],
  ['map', 'Map'],
  ['chat', 'Chat'],
  ['sleep', 'Sleep'],
  ['debug', 'Debug overlay'],
  ['pause', 'Pause / close panel'],
];

/** Controls that are not key bindings, so the reference is not quietly incomplete. */
const POINTER_ROWS: readonly (readonly [string, string])[] = [
  ['Attack', 'Left mouse'],
  ['Use / interact', 'Right mouse'],
  ['Select hotbar slot', '1 – 9'],
  ['Cycle hotbar', 'Mouse wheel'],
];

/**
 * The pause menu.
 *
 * Pausing is a *request*: `setPaused` is honoured only when the server was started with
 * `pauseWhenClientPaused`, which is the single-player configuration (spec section 12).
 * A dedicated server ignores it, and rightly so — one player should not be able to
 * freeze everybody else. So the panel sends the intent and then reports what actually
 * happened by reading `session.store.paused`, rather than drawing a paused world and
 * letting a multiplayer player find out the hard way that zombies kept walking.
 */
export function createPausePanel(): Panel {
  let ui: UiContext | null = null;
  let lastStatus = '';

  interface Parts {
    status: HTMLDivElement;
    body: HTMLDivElement;
  }
  let parts: Parts | null = null;

  function ensureParts(): Parts {
    if (parts) return parts;

    const status = el('div', {
      className: 'pause-status',
      attrs: { role: 'status', 'aria-live': 'polite', 'data-testid': 'pause-status' },
    });

    const controlNodes: HTMLElement[] = [];
    for (const [key, label] of CONTROL_ROWS) {
      controlNodes.push(el('dt', { text: label }));
      controlNodes.push(el('dd', { text: DEFAULT_BINDINGS[key].map(keyLabel).join(' / ') }));
    }
    for (const [label, keys] of POINTER_ROWS) {
      controlNodes.push(el('dt', { text: label }));
      controlNodes.push(el('dd', { text: keys }));
    }
    const controls = el('dl', {
      className: 'pause-controls',
      attrs: { 'data-testid': 'pause-controls' },
      children: controlNodes,
    });

    const resume = button('Resume', () => ui?.close('pause'), 'primary');
    resume.setAttribute('data-testid', 'pause-resume');

    const disconnect = button(
      'Disconnect',
      () => {
        const context = ui;
        if (!context) return;
        /*
         * Leave the room, then reload the page.
         *
         * The clean thing would be to stop the game scenes and hand control back to
         * the menu, but a panel cannot reach the scenes: `UiContext` deliberately
         * exposes the session, the data and panel open/close, and nothing else.
         * Widening that contract for one button would let every panel drive the scene
         * graph. A reload runs `main.ts` again and lands on the menu, which is the
         * same destination by a blunter route — and the session has already left the
         * room by then, so the server sees a normal departure rather than a timeout.
         */
        void context.session
          .disconnect()
          .catch(() => undefined)
          .finally(() => window.location.reload());
      },
      'danger',
    );
    disconnect.setAttribute('data-testid', 'pause-disconnect');

    const body = el('div', {
      className: 'panel-body pause-body',
      children: [
        status,
        el('div', { className: 'pause-actions', children: [resume, disconnect] }),
        el('div', { className: 'section-title', text: 'Controls' }),
        controls,
      ],
    });

    parts = { status, body };
    return parts;
  }

  return {
    id: 'pause',
    title: t('panel.paused'),
    captures: true,

    mount(ctx: UiContext): HTMLElement {
      injectSessionStyles();
      ui = ctx;
      lastStatus = '';
      const view = ensureParts();
      // Ask on open. `UiScene.closePanel` sends `paused: false` on the way out, which
      // is why Resume is simply "close the panel".
      ctx.send({ type: 'setPaused', paused: true });
      const root = panelFrame('Paused', () => ctx.close('pause'), view.body, 'panel--pause');
      root.setAttribute('data-testid', 'pause-panel');
      return root;
    },

    update(ctx: UiContext): void {
      ui = ctx;
      const view = ensureParts();

      const paused = ctx.session.store.paused;
      const canPause = ctx.session.welcome?.config.canPause ?? false;
      const tone = paused ? 'paused' : canPause ? '' : 'live';
      const text = paused
        ? 'The simulation is paused.'
        : canPause
          ? 'Waiting for the server to pause…'
          : 'This server does not pause: the world keeps running while this menu is open.';

      const signature = `${text}|${tone}`;
      if (signature === lastStatus) return;
      lastStatus = signature;
      setText(view.status, text);
      setClass(view.status, `pause-status${tone ? ` pause-status--${tone}` : ''}`);
    },

    unmount(): void {
      parts = null;
      ui = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Debug
// ---------------------------------------------------------------------------

type DebugRowId =
  | 'error'
  | 'latency'
  | 'fps'
  | 'tick'
  | 'clientTick'
  | 'snapshot'
  | 'entities'
  | 'chunks'
  | 'pos'
  | 'server'
  | 'tile'
  | 'chunk'
  | 'time'
  | 'weather'
  | 'content';

type Tone = '' | 'good' | 'warn' | 'bad';

/**
 * Rows in display order. `headline` marks the two numbers this panel exists for:
 * prediction error and latency are what turn "the game feels wrong" into a diagnosis.
 * `null` is a separator.
 */
const DEBUG_ROWS: readonly (readonly [DebugRowId, string, boolean] | null)[] = [
  ['error', 'pred err', true],
  ['latency', 'latency', true],
  null,
  ['fps', 'fps', false],
  ['tick', 'server tick', false],
  ['clientTick', 'client tick', false],
  ['snapshot', 'snapshot', false],
  ['entities', 'entities', false],
  ['chunks', 'chunks', false],
  null,
  ['pos', 'predicted', false],
  ['server', 'authoritative', false],
  ['tile', 'tile', false],
  ['chunk', 'chunk', false],
  null,
  ['time', 'world time', false],
  ['weather', 'weather', false],
  ['content', 'content', false],
];

/**
 * Latency above which the connection is worth mentioning / worth complaining about.
 * Chosen to bracket the snapshot interval: at 10Hz snapshots, 200ms of round trip is
 * two whole snapshots of staleness and reconciliation starts to show.
 */
const LATENCY_WARN_MS = 120;
const LATENCY_BAD_MS = 250;

/**
 * The debug overlay.
 *
 * `captures: false`: it is a readout, it never takes the keyboard, and its CSS gives it
 * `pointer-events: none` so it cannot swallow a click meant for the world behind it.
 *
 * Everything here is measured or read, never derived from game rules. FPS is the one
 * number the client owns outright, because it is a property of this machine's renderer
 * and of nothing else.
 */
export function createDebugPanel(): Panel {
  /** Smoothed frames per second. */
  let fps = 0;
  let lastFrameMs = 0;
  const values = new Map<DebugRowId, HTMLSpanElement>();
  const tones = new Map<DebugRowId, Tone>();
  let body: HTMLDivElement | null = null;

  function ensureBody(): HTMLDivElement {
    if (body) return body;
    const children: HTMLElement[] = [];
    for (const row of DEBUG_ROWS) {
      if (!row) {
        children.push(el('div', { className: 'dbg-sep' }));
        continue;
      }
      const [id, label, headline] = row;
      const value = el('span', {
        className: 'dbg-val',
        text: '—',
        attrs: { 'data-testid': `debug-${id}` },
      });
      values.set(id, value);
      tones.set(id, '');
      children.push(
        el('div', {
          className: `dbg-row${headline ? ' dbg-row--headline' : ''}`,
          children: [el('span', { className: 'dbg-key', text: label }), value],
        }),
      );
    }
    body = el('div', { className: 'panel-body dbg-body', children });
    return body;
  }

  function set(id: DebugRowId, text: string, tone: Tone = ''): void {
    const node = values.get(id);
    if (!node) return;
    setText(node, text);
    if (tones.get(id) === tone) return;
    tones.set(id, tone);
    setClass(node, `dbg-val${tone ? ` dbg-val--${tone}` : ''}`);
  }

  /** Frames per second, smoothed. A raw per-frame reciprocal is unreadable noise. */
  function sampleFps(nowMs: number): void {
    if (lastFrameMs === 0) {
      lastFrameMs = nowMs;
      return;
    }
    const deltaMs = nowMs - lastFrameMs;
    lastFrameMs = nowMs;
    if (deltaMs <= 0) return;
    const instant = 1000 / deltaMs;
    fps = fps === 0 ? instant : fps + (instant - fps) * 0.1;
  }

  return {
    id: 'debug',
    title: t('panel.debug'),
    captures: false,

    mount(ctx: UiContext): HTMLElement {
      injectSessionStyles();
      lastFrameMs = 0;
      fps = 0;
      const root = panelFrame('Debug', () => ctx.close('debug'), ensureBody(), 'panel--debug');
      root.setAttribute('data-testid', 'debug-panel');
      return root;
    },

    update(ctx: UiContext): void {
      ensureBody();
      const { session } = ctx;
      sampleFps(performance.now());

      // Prediction error first: past RECONCILE_SNAP_DISTANCE the predictor stops
      // easing and teleports, which is exactly the rubber-band a player reports.
      const error = session.predictionError;
      set(
        'error',
        `${error.toFixed(1)} px`,
        error >= RECONCILE_SNAP_DISTANCE ? 'bad' : error >= TILE_SIZE ? 'warn' : 'good',
      );

      const latency = session.latencyMs;
      set(
        'latency',
        latency > 0 ? `${Math.round(latency)} ms` : '—',
        latency <= 0
          ? ''
          : latency >= LATENCY_BAD_MS
            ? 'bad'
            : latency >= LATENCY_WARN_MS
              ? 'warn'
              : 'good',
      );

      set(
        'fps',
        fps > 0 ? fps.toFixed(0) : '—',
        fps === 0 ? '' : fps < 30 ? 'bad' : fps < 50 ? 'warn' : '',
      );

      const serverTick = session.store.tick;
      set('tick', serverTick < 0 ? '—' : String(serverTick));
      // The client's own estimate of where the server is *now*, extrapolated between
      // snapshots; the gap between the two rows is the staleness of the last packet.
      set('clientTick', session.clock.synced ? String(session.clock.tick) : '—');
      set('snapshot', `${Math.round(session.snapshotIntervalMs)} ms`);
      set('entities', String(session.store.entityCount));
      set('chunks', String(session.store.chunkCount));

      const predicted = session.predicted;
      set('pos', `${predicted.x.toFixed(0)}, ${predicted.y.toFixed(0)}`);
      const self = session.self;
      set('server', self ? `${self.x.toFixed(0)}, ${self.y.toFixed(0)}` : '—');
      const tileX = Math.floor(predicted.x / TILE_SIZE);
      const tileY = Math.floor(predicted.y / TILE_SIZE);
      set('tile', `${tileX}, ${tileY}`);
      set('chunk', chunkKeyAtPixel(predicted.x, predicted.y));

      const time = session.time;
      set(
        'time',
        time
          ? `d${time.day} ${clockText(time.hour, time.minute)} ${time.season} l${time.lightLevel.toFixed(2)}`
          : '—',
      );
      const weather = session.weather;
      set(
        'weather',
        weather
          ? `${weather.type} ${Math.round(weather.intensity * 100)}% ${Math.round(weather.temperature)}°C`
          : '—',
      );
      set('content', session.welcome?.dataVersion ?? '—');
    },

    unmount(): void {
      // Keep nothing: the next open rebuilds the rows and re-measures the frame rate.
      values.clear();
      tones.clear();
      body = null;
    },
  };
}
