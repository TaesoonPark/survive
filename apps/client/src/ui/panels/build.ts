import { SIM_HZ, type ItemStack, type PlayerState, type SkillId } from '@survive/protocol';
import type { StructureCategory, StructureDef, ToolKind } from '@survive/game-data';
import { DEFAULT_STRUCTURE_COLOR, STRUCTURE_COLOR, UI, cssColor } from '../../art/palette';
import { button, el, humanize, itemIconUrl, panelFrame } from '../kit';
import { t } from '../strings';
import type { Panel, UiContext } from '../panel';

/**
 * The build menu.
 *
 * Forty-seven pieces, grouped by category behind collapsible headers in the `sortOrder`
 * the content table assigns. Picking one is the whole job of this panel: the click sends
 * `setBuildSelection`, the server records it on the player, and the ghost in `GameScene`
 * draws itself from `player.buildDefId` / `player.buildRotation` on the next snapshot.
 * Nothing is placed from here.
 *
 * ## Why this panel is different from every other one
 *
 * Every other panel sets `captures: true` and sits in the middle of the screen. This one
 * must not. The gesture it exists to serve is two-handed: select a piece in the menu, then
 * left-click **in the world** to place it, rotating with T between clicks. A panel that
 * swallowed pointer input would break the second half of that gesture, and a panel centred
 * on screen would sit exactly where the player is trying to build - you would be choosing
 * a wall while covering the wall's future location.
 *
 * So: `captures: false`, and the frame docks hard right through its own absolutely
 * positioned rule instead of the centring flex layout of `.panel-layer`. The world keeps
 * the keyboard - which is what lets T and B keep working while the menu is open - and
 * keeps the pointer everywhere except the strip of screen the panel actually covers.
 *
 * ## The client decides nothing
 *
 * The affordability colouring re-reads the same inputs the simulation validates against -
 * inventory counts, tool roles, skill level - purely so the player is not clicking into a
 * wall. It never subtracts a material, and an unaffordable piece stays selectable: holding
 * a selection you cannot yet pay for is how you learn what to go and gather. If this panel
 * and `canPlace` ever disagree, the server wins and emits a `buildRejected` the HUD shows
 * as a toast. Placement geometry is not second-guessed here at all - where a piece can go
 * is a question only the world can answer, and the ghost answers it live.
 *
 * ## Diffing
 *
 * `update` runs every rendered frame. The selection strip and the list carry separate
 * signatures, so rotating a piece - which changes state on every frame the key is held -
 * does not drag forty-seven rows through a rebuild with it. The inventory half of the
 * signature only counts item ids that appear in some build cost, so looting unrelated junk
 * costs nothing.
 */

/**
 * Human labels for the category headers.
 *
 * An exhaustive `Record` rather than a lookup with a fallback: adding a
 * `StructureCategory` to the content layer should be a compile error here, not a header
 * that silently reads "Other".
 */
const CATEGORY_LABEL: Readonly<Record<StructureCategory, string>> = {
  foundation: 'Foundations',
  wall: 'Walls',
  door: 'Doors',
  window: 'Windows',
  floor: 'Floors',
  furniture: 'Furniture',
  station: 'Stations',
  storage: 'Storage',
  farm: 'Farming',
  light: 'Lighting',
  defense: 'Defences',
  bed: 'Beds',
  misc: 'Other',
};

/** Degrees each rotation index turns the footprint. Rotation is 0..3 server-side. */
const ROTATION_DEGREES: readonly number[] = [0, 90, 180, 270];

const STYLE_ID = 'survive-build-styles';

/**
 * Panel-local styles.
 *
 * Injected from here behind a guarded id rather than added to `kit.ts`: the right-docked
 * frame and the two-line build row are layouts nothing else in the interface wants, and
 * the shared stylesheet stays shared. Everything that *is* shared - `.btn`, `.muted`,
 * `.row`, `.effect-chip` - is reused as-is.
 *
 * The `position: absolute` on `.panel--build` is the load-bearing rule: `.panel-layer` is
 * a centring flex container, and this panel has to leave the centre of the screen alone.
 */
function injectBuildStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .panel--build {
      position: absolute; top: 0; right: 0;
      width: min(340px, 92vw); max-height: calc(100vh - 170px);
    }
    .build-body { display: flex; flex-direction: column; gap: 8px; overflow: hidden; }

    .build-hint { flex: none; margin: 0; font-size: 11px; line-height: 1.55; }
    .build-hint b { color: ${cssColor(UI.accent)}; font-family: monospace; }

    .build-select {
      flex: none; display: flex; flex-direction: column; gap: 6px; padding: 7px 8px;
      background: ${cssColor(UI.slot, 0.55)}; border: 1px solid ${cssColor(UI.slotEdge)};
      border-radius: 4px;
    }
    .build-select--active { border-color: ${cssColor(UI.accent, 0.8)}; }
    .build-select-name { font-weight: 600; }
    .build-select-sub { font-size: 10px; color: ${cssColor(UI.textMuted)}; }
    .build-controls { display: flex; align-items: center; gap: 4px; }
    .build-controls .btn { padding: 3px 8px; font-size: 11px; }
    .build-rot-value {
      font-family: monospace; font-size: 11px; min-width: 44px; text-align: center;
      color: ${cssColor(UI.textMuted)};
    }
    .build-toolbar {
      flex: none; display: flex; align-items: center; gap: 8px; font-size: 10px;
      text-transform: uppercase; letter-spacing: 0.08em; color: ${cssColor(UI.textMuted)};
    }
    .build-toolbar .btn { padding: 3px 8px; font-size: 11px; text-transform: none; letter-spacing: 0; }
    .build-push { margin-left: auto; }

    .build-groups {
      flex: 1 1 auto; min-height: 120px; overflow-y: auto;
      display: flex; flex-direction: column; gap: 4px; padding-right: 2px;
    }
    .build-group { display: flex; flex-direction: column; gap: 3px; }
    .build-head {
      display: flex; align-items: center; gap: 7px; width: 100%; text-align: left;
      cursor: pointer; padding: 4px 7px; font: inherit; font-size: 10px;
      text-transform: uppercase; letter-spacing: 0.08em; color: ${cssColor(UI.textMuted)};
      background: transparent; border: 1px solid ${cssColor(UI.panelEdge)}; border-radius: 4px;
    }
    .build-head:hover { background: ${cssColor(UI.slotHover, 0.6)}; color: ${cssColor(UI.text)}; }
    .build-head[aria-expanded="true"] { color: ${cssColor(UI.text)}; }
    .build-caret { font-family: monospace; font-size: 9px; }
    .build-swatch { width: 8px; height: 8px; border-radius: 2px; flex: none; }
    .build-head-count {
      margin-left: auto; font-family: monospace; font-size: 10px; letter-spacing: 0;
    }

    .build-rows { display: flex; flex-direction: column; gap: 3px; padding-left: 7px; }
    .build-row {
      display: flex; flex-direction: column; gap: 3px; width: 100%; text-align: left;
      cursor: pointer; padding: 5px 7px; font: inherit; color: ${cssColor(UI.text)};
      background: ${cssColor(UI.slot, 0.55)}; border: 1px solid ${cssColor(UI.slotEdge)};
      border-radius: 4px;
    }
    .build-row:hover { background: ${cssColor(UI.slotHover, 0.85)}; }
    .build-row[aria-pressed="true"] {
      border-color: ${cssColor(UI.accent)}; background: ${cssColor(UI.slotHover, 0.95)};
    }
    /* Not yet payable: readable, but plainly not ready. Still selectable, on purpose. */
    .build-row--short { opacity: 0.62; }
    .build-row--short:hover { opacity: 0.88; }
    .build-row-top { display: flex; align-items: baseline; gap: 6px; }
    .build-row-top b { font-weight: 600; }
    .build-desc { font-size: 10px; line-height: 1.4; color: ${cssColor(UI.textMuted)}; }
    .build-facts {
      margin-left: auto; font-family: monospace; font-size: 10px; white-space: nowrap;
      color: ${cssColor(UI.textMuted)};
    }
    .build-chips { display: flex; flex-wrap: wrap; gap: 3px; }
    .build-chip {
      display: inline-flex; align-items: center; gap: 3px; padding: 1px 5px;
      border-radius: 3px; font-size: 10px; font-family: monospace;
      background: rgba(0,0,0,0.35); border: 1px solid ${cssColor(UI.slotEdge)};
    }
    .build-chip img { width: 14px; height: 14px; image-rendering: pixelated; }
    .build-chip--ok { border-color: ${cssColor(UI.accent, 0.7)}; color: ${cssColor(UI.accent)}; }
    .build-chip--miss { border-color: ${cssColor(UI.danger, 0.7)}; color: ${cssColor(UI.danger)}; }
    .build-chip--warn { border-color: ${cssColor(UI.warn, 0.7)}; color: ${cssColor(UI.warn)}; }
  `;
  document.head.append(style);
}

/** Turn `wateringCan` or `wood_log` into `Watering Can` / `Wood Log`. */
function labelFor(id: string): string {
  return humanize(id.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase());
}

/** Build times live in ticks; players think in seconds. */
function secondsLabel(ticks: number): string {
  if (ticks <= 0) return 'instant';
  const value = ticks / SIM_HZ;
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)}s`;
}

/**
 * Footprint as it will land on the ground.
 *
 * Odd rotations swap the axes, exactly as `structureTiles` does server-side, so a 2x1
 * doorway turned once reads as 1x2 here too.
 */
function footprintLabel(def: StructureDef, rotation: number): string {
  const swapped = rotation % 2 === 1;
  return `${swapped ? def.height : def.width}x${swapped ? def.width : def.height}`;
}

/** One material line of a cost, resolved against what the player is carrying. */
interface CostStatus {
  defId: string;
  label: string;
  need: number;
  have: number;
  ok: boolean;
}

/** Everything the panel needs to know about one buildable right now. */
interface EntryStatus {
  def: StructureDef;
  costs: CostStatus[];
  /** True when every material line is covered. */
  affordable: boolean;
  /** The tool role the player cannot fill, or null. */
  missingTool: ToolKind | null;
  required: { id: SkillId; need: number } | null;
  skillLevel: number;
  skillOk: boolean;
  /** Why the server would refuse this piece right now, or null when it would not. */
  blockedReason: string | null;
}

/** One category's worth of buildables, in `sortOrder` order. */
interface BuildGroup {
  category: StructureCategory;
  entries: readonly StructureDef[];
}

/**
 * Static shape derived from the content tables once per session.
 *
 * `buildableStructures()` is already sorted by `sortOrder`, so grouping by first
 * appearance gives the header order the content authors intended without a second sort,
 * and leaves each group internally in `sortOrder` too.
 *
 * The three id lists exist for the diff: they are the only inventory entries, skills and
 * tool roles that can change what this panel draws, so the per-frame signature never has
 * to walk the whole item table.
 */
interface Catalogue {
  groups: readonly BuildGroup[];
  /** Item ids appearing in some build cost, sorted. The inventory signature's domain. */
  costItemIds: readonly string[];
  costItemSet: ReadonlySet<string>;
  skillIds: readonly SkillId[];
  toolKinds: readonly ToolKind[];
}

function buildCatalogue(ctx: UiContext): Catalogue {
  const order: StructureCategory[] = [];
  const byCategory = new Map<StructureCategory, StructureDef[]>();
  const costItems = new Set<string>();
  const skills = new Set<SkillId>();
  const tools = new Set<ToolKind>();

  for (const def of ctx.data.buildableStructures()) {
    let bucket = byCategory.get(def.category);
    if (!bucket) {
      bucket = [];
      byCategory.set(def.category, bucket);
      order.push(def.category);
    }
    bucket.push(def);
    for (const entry of def.cost) costItems.add(entry.defId);
    if (def.requiredSkill) skills.add(def.requiredSkill.id);
    if (def.tool) tools.add(def.tool);
  }

  return {
    groups: order.map((category) => ({ category, entries: byCategory.get(category) ?? [] })),
    costItemIds: [...costItems].sort(),
    costItemSet: costItems,
    skillIds: [...skills].sort(),
    toolKinds: [...tools].sort(),
  };
}

/**
 * How much of each cost material the player is carrying.
 *
 * Backpack only, and by exact def id, because that is precisely what `missingMaterial`
 * counts server-side: a log in your hands pays for nothing. Restricted to ids that appear
 * in some cost so the map - and the signature built from it - stays small.
 */
function costCounts(player: PlayerState, domain: ReadonlySet<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const stack of player.inventory.slots) {
    if (!stack) continue;
    if (!domain.has(stack.defId)) continue;
    counts.set(stack.defId, (counts.get(stack.defId) ?? 0) + stack.count);
  }
  return counts;
}

/**
 * Tool roles the player can currently fill.
 *
 * Mirrors the simulation's `findBuildTool`, which checks both hands first and then the
 * whole pack - `StructureDef.tool` documents itself as "equipped" but the server is kinder
 * than that. Only membership matters here; which particular hammer gets worn down is the
 * server's business.
 */
function availableToolKinds(ctx: UiContext, player: PlayerState): Set<ToolKind> {
  const kinds = new Set<ToolKind>();
  const consider = (stack: ItemStack | null): void => {
    if (!stack) return;
    const tool = ctx.data.items.get(stack.defId)?.tool;
    if (!tool) return;
    for (const kind of tool.kinds) kinds.add(kind);
  };
  consider(player.equipment.mainHand);
  consider(player.equipment.offHand);
  for (const stack of player.inventory.slots) consider(stack);
  return kinds;
}

/**
 * Resolve one buildable against the player's situation.
 *
 * The blocked checks run in `canPlace`'s own order - dead, skill, tool, materials - so the
 * reason shown here is the reason the server would give if the click landed.
 */
function computeStatus(
  ctx: UiContext,
  player: PlayerState,
  def: StructureDef,
  counts: Map<string, number>,
  tools: ReadonlySet<ToolKind>,
): EntryStatus {
  const costs: CostStatus[] = def.cost.map((entry) => {
    const have = counts.get(entry.defId) ?? 0;
    return {
      defId: entry.defId,
      label: ctx.data.items.get(entry.defId)?.name ?? labelFor(entry.defId),
      need: entry.count,
      have,
      ok: have >= entry.count,
    };
  });
  const affordable = costs.every((cost) => cost.ok);

  const missingTool = def.tool !== undefined && !tools.has(def.tool) ? def.tool : null;
  const required = def.requiredSkill
    ? { id: def.requiredSkill.id, need: def.requiredSkill.level }
    : null;
  const skillLevel = required ? player.skills[required.id].level : 0;
  const skillOk = required === null || skillLevel >= required.need;

  let blockedReason: string | null = null;
  if (!player.alive) blockedReason = 'you are dead';
  else if (required && !skillOk) {
    blockedReason = `needs ${labelFor(required.id).toLowerCase()} ${required.need}`;
  } else if (missingTool) blockedReason = `needs a ${labelFor(missingTool).toLowerCase()}`;
  else if (!affordable) blockedReason = 'not enough materials';

  return { def, costs, affordable, missingTool, required, skillLevel, skillOk, blockedReason };
}

/** A small icon + text chip, used for materials, tools and skill requirements. */
function chip(
  ctx: UiContext,
  text: string,
  tone: 'ok' | 'miss' | 'warn',
  options: { iconDefId?: string; title?: string } = {},
): HTMLSpanElement {
  const url = options.iconDefId === undefined ? null : itemIconUrl(ctx.textures, options.iconDefId);
  return el('span', {
    className: `build-chip build-chip--${tone}`,
    ...(options.title === undefined ? {} : { title: options.title }),
    children: [url ? el('img', { attrs: { src: url, alt: '' } }) : null, el('span', { text })],
  });
}

/** Hover text for a row: the things worth knowing but not worth a line of layout each. */
function rowTooltip(status: EntryStatus): string {
  const { def } = status;
  const lines: string[] = [def.name, def.description, ''];
  lines.push(
    `${def.maxHealth} HP · ${secondsLabel(def.buildTicks)} to build · ${def.width}x${def.height} tiles`,
  );
  lines.push(
    `Cost: ${def.cost.map((entry) => `${entry.count}x ${labelFor(entry.defId)}`).join(', ') || 'free'}`,
  );
  if (def.requiredSkill) {
    lines.push(
      `Skill: ${labelFor(def.requiredSkill.id)} ${status.skillLevel}/${def.requiredSkill.level}`,
    );
  }
  lines.push(def.tool ? `Tool: ${labelFor(def.tool)}` : 'Tool: none');
  lines.push(
    def.requiresSupport ? 'Must touch an existing wall or foundation' : `Placed on ${def.placeOn}`,
  );
  if (def.stacksOver.length > 0) {
    lines.push(
      `Stacks over: ${def.stacksOver.map((category) => CATEGORY_LABEL[category]).join(', ')}`,
    );
  }
  if (def.blocksMovement) lines.push('Blocks movement');
  lines.push(`Refunds ${Math.round(def.refundRatio * 100)}% when demolished`);
  if (status.blockedReason) lines.push('', status.blockedReason);
  return lines.join('\n');
}

/**
 * The build panel.
 *
 * The only mutable state in this closure is which groups are open - a fact about what the
 * player is looking at, which the server has no opinion about. The selection and its
 * rotation live on `PlayerState` and are read back out of the snapshot every frame, so the
 * menu and the ghost can never drift apart.
 */
export function createBuildPanel(): Panel {
  const expanded = new Set<StructureCategory>();
  /** Cleared on mount so each open re-seeds one group, then leaves the set to the player. */
  let seededExpansion = false;

  let catalogue: Catalogue | null = null;
  let selectionSignature = '';
  let listSignature = '';

  interface Parts {
    selection: HTMLDivElement;
    toolbar: HTMLDivElement;
    groups: HTMLDivElement;
    body: HTMLDivElement;
  }
  let parts: Parts | null = null;

  /**
   * Build the persistent chrome once.
   *
   * The scroll container in particular must survive every update: replacing it would jump
   * the player back to the top of the list every time a stack of nails changed count.
   */
  function ensureParts(): Parts {
    if (parts) return parts;

    const selection = el('div', {
      className: 'build-select',
      attrs: { 'data-testid': 'build-selection' },
    });
    const toolbar = el('div', {
      className: 'build-toolbar',
      attrs: { 'data-testid': 'build-toolbar' },
    });
    const groups = el('div', {
      className: 'build-groups',
      attrs: { 'data-testid': 'build-list' },
    });

    const body = el('div', {
      className: 'panel-body build-body',
      children: [
        el('p', {
          className: 'build-hint muted',
          html:
            'Left click in the world to place · <b>T</b> rotates · <b>B</b> closes.' +
            '<br>The ghost turns red where the server would refuse it.',
          attrs: { 'data-testid': 'build-hint' },
        }),
        selection,
        toolbar,
        groups,
      ],
    });

    parts = { selection, toolbar, groups, body };
    return parts;
  }

  function catalogueFor(ctx: UiContext): Catalogue {
    catalogue ??= buildCatalogue(ctx);
    return catalogue;
  }

  /**
   * Send a selection change.
   *
   * Rotation is read out of the live snapshot at click time rather than captured when the
   * row was built: a row survives many frames, and a stale rotation would quietly untwist
   * a piece the player had just turned with T.
   */
  function select(ctx: UiContext, defId: string | null): void {
    const player = ctx.session.self;
    ctx.send({
      type: 'setBuildSelection',
      defId,
      // Clearing resets rotation server-side anyway; sending 0 keeps the two in step.
      rotation: defId === null ? 0 : (player?.buildRotation ?? 0),
    });
  }

  /**
   * Turn the current selection by `delta` quarter turns.
   *
   * Rotation is player state, not view state, which is why this is a command and not a
   * local variable - and why the T key in `GameScene` sends exactly the same one.
   */
  function rotate(ctx: UiContext, delta: number): void {
    const player = ctx.session.self;
    const defId = player?.buildDefId;
    if (!player || defId === undefined) return;
    ctx.send({
      type: 'setBuildSelection',
      defId,
      rotation: (player.buildRotation + delta + 4) % 4,
    });
  }

  /** The strip above the list: what is selected, how it is turned, how to drop it. */
  function renderSelection(ctx: UiContext, selected: EntryStatus | null, rotation: number): void {
    const view = ensureParts();
    view.selection.classList.toggle('build-select--active', selected !== null);

    const rotateLeft = button('⟲', () => rotate(ctx, -1));
    rotateLeft.setAttribute('aria-label', 'Rotate selection anticlockwise');
    rotateLeft.setAttribute('data-testid', 'build-rotate-ccw');
    rotateLeft.title = 'Rotate anticlockwise (Shift+T)';
    rotateLeft.disabled = selected === null;

    const rotateRight = button('⟳', () => rotate(ctx, 1));
    rotateRight.setAttribute('aria-label', 'Rotate selection clockwise');
    rotateRight.setAttribute('data-testid', 'build-rotate-cw');
    rotateRight.title = 'Rotate clockwise (T)';
    rotateRight.disabled = selected === null;

    const degrees = ROTATION_DEGREES[rotation] ?? 0;
    const rotationValue = el('span', {
      className: 'build-rot-value',
      text: `${degrees}°`,
      attrs: {
        'data-testid': 'build-rotation-value',
        'aria-label': `Rotation ${degrees} degrees`,
      },
    });

    const clear = button('Clear', () => select(ctx, null), 'danger');
    clear.classList.add('build-push');
    clear.setAttribute('data-testid', 'build-clear');
    clear.setAttribute('aria-label', 'Clear the build selection');
    clear.disabled = selected === null;

    const controls = el('div', {
      className: 'build-controls',
      attrs: { role: 'group', 'aria-label': 'Selection controls' },
      children: [rotateLeft, rotationValue, rotateRight, clear],
    });

    if (!selected) {
      view.selection.replaceChildren(
        el('span', {
          className: 'muted',
          text: 'Nothing selected. Pick a piece below, then click in the world.',
        }),
        controls,
      );
      return;
    }

    const { def } = selected;
    // `replaceChildren` takes no nulls, so the optional blocked chip is filtered out
    // rather than passed through as one.
    const children: (Node | null)[] = [
      el('span', {
        className: 'build-select-name',
        text: def.name,
        attrs: { 'data-testid': 'build-selected-name' },
      }),
      el('span', {
        className: 'build-select-sub',
        text: [
          footprintLabel(def, rotation),
          `${def.maxHealth} HP`,
          secondsLabel(def.buildTicks),
          CATEGORY_LABEL[def.category],
        ].join(' · '),
      }),
      el('div', {
        className: 'build-chips',
        children: selected.costs.map((cost) =>
          chip(ctx, `${cost.have}/${cost.need}`, cost.ok ? 'ok' : 'miss', {
            iconDefId: cost.defId,
            title: `${cost.label}: carrying ${cost.have}, needs ${cost.need}`,
          }),
        ),
      }),
      selected.blockedReason
        ? el('span', {
            className: 'effect-chip effect-chip--bad',
            text: selected.blockedReason,
            attrs: { 'data-testid': 'build-blocked' },
          })
        : null,
      controls,
    ];
    view.selection.replaceChildren(...children.filter((child): child is Node => child !== null));
  }

  /** One buildable. Clicking it does exactly one thing: change the selection. */
  function renderRow(
    ctx: UiContext,
    status: EntryStatus,
    selectedId: string | undefined,
  ): HTMLButtonElement {
    const { def } = status;

    const chips: (Node | null)[] = status.costs.map((cost) =>
      chip(ctx, `${cost.have}/${cost.need}`, cost.ok ? 'ok' : 'miss', {
        iconDefId: cost.defId,
        title: `${cost.label}: carrying ${cost.have}, needs ${cost.need}`,
      }),
    );
    if (status.required) {
      chips.push(
        chip(
          ctx,
          `${labelFor(status.required.id).toLowerCase()} ${status.skillLevel}/${status.required.need}`,
          status.skillOk ? 'ok' : 'miss',
          { title: `Requires ${labelFor(status.required.id)} level ${status.required.need}` },
        ),
      );
    }
    if (def.tool) {
      chips.push(
        chip(ctx, labelFor(def.tool).toLowerCase(), status.missingTool ? 'miss' : 'ok', {
          title: status.missingTool
            ? `You are carrying no ${labelFor(def.tool).toLowerCase()}`
            : `Uses your ${labelFor(def.tool).toLowerCase()}`,
        }),
      );
    }
    if (def.requiresSupport) {
      chips.push(
        chip(ctx, 'needs support', 'warn', {
          title: 'Must touch an existing wall or foundation',
        }),
      );
    }

    const row = el('button', {
      className: 'build-row',
      title: rowTooltip(status),
      attrs: {
        type: 'button',
        'aria-pressed': String(selectedId === def.id),
        'aria-label': `${def.name}, ${def.maxHealth} health, ${secondsLabel(def.buildTicks)} to build${
          status.blockedReason === null ? '' : `, ${status.blockedReason}`
        }`,
        'data-testid': `build-entry-${def.id}`,
      },
      children: [
        el('span', {
          className: 'build-row-top',
          children: [
            el('b', { text: def.name }),
            el('span', {
              className: 'build-facts',
              text: `${def.maxHealth} HP · ${secondsLabel(def.buildTicks)} · ${def.width}x${def.height}`,
            }),
          ],
        }),
        el('span', { className: 'build-desc', text: def.description }),
        el('span', { className: 'build-chips', children: chips }),
      ],
      on: { click: () => select(ctx, def.id) },
    });
    if (status.blockedReason !== null) row.classList.add('build-row--short');
    return row;
  }

  /** One category: a header that toggles, plus its rows when open. */
  function renderGroup(
    ctx: UiContext,
    group: BuildGroup,
    statuses: readonly EntryStatus[],
    selectedId: string | undefined,
  ): HTMLDivElement {
    const open = expanded.has(group.category);
    const ready = statuses.filter((status) => status.blockedReason === null).length;
    const label = CATEGORY_LABEL[group.category];
    // Reuse the world's structure palette so a header reads as the thing it builds.
    const color = STRUCTURE_COLOR[group.category] ?? DEFAULT_STRUCTURE_COLOR;
    const bodyId = `build-group-body-${group.category}`;

    const swatch = el('span', { className: 'build-swatch' });
    swatch.style.background = cssColor(color.fill);
    swatch.style.border = `1px solid ${cssColor(color.edge)}`;

    const head = el('button', {
      className: 'build-head',
      title: `${ready} of ${statuses.length} ready to build`,
      attrs: {
        type: 'button',
        'aria-expanded': String(open),
        'aria-controls': bodyId,
        'data-testid': `build-group-${group.category}`,
      },
      children: [
        el('span', {
          className: 'build-caret',
          text: open ? '▾' : '▸',
          attrs: { 'aria-hidden': 'true' },
        }),
        swatch,
        el('span', { text: label }),
        el('span', {
          className: 'build-head-count',
          text: `${ready}/${statuses.length}`,
          attrs: { 'aria-label': `${ready} of ${statuses.length} ready` },
        }),
      ],
      on: {
        click: () => {
          if (expanded.has(group.category)) expanded.delete(group.category);
          else expanded.add(group.category);
        },
      },
    });

    const children: (Node | null)[] = [head];
    if (open) {
      // Collapsed groups keep their rows out of the DOM entirely: forty-seven rows of
      // chips is real layout work, and most of them are not being looked at.
      children.push(
        el('div', {
          className: 'build-rows',
          attrs: {
            id: bodyId,
            role: 'group',
            'aria-label': label,
            'data-testid': bodyId,
          },
          children: statuses.map((status) => renderRow(ctx, status, selectedId)),
        }),
      );
    }
    return el('div', { className: 'build-group', children });
  }

  function renderList(
    ctx: UiContext,
    groups: readonly { group: BuildGroup; statuses: EntryStatus[] }[],
    selectedId: string | undefined,
  ): void {
    const view = ensureParts();
    const allOpen =
      groups.length > 0 && groups.every((entry) => expanded.has(entry.group.category));
    const ready = groups.reduce(
      (total, entry) =>
        total + entry.statuses.filter((status) => status.blockedReason === null).length,
      0,
    );
    const total = groups.reduce((count, entry) => count + entry.statuses.length, 0);

    const toggleAll = button(allOpen ? 'Collapse all' : 'Expand all', () => {
      if (allOpen) expanded.clear();
      else for (const entry of groups) expanded.add(entry.group.category);
    });
    toggleAll.classList.add('build-push');
    toggleAll.setAttribute('data-testid', 'build-toggle-all');

    view.toolbar.replaceChildren(el('span', { text: `${ready} of ${total} buildable` }), toggleAll);
    view.groups.replaceChildren(
      ...groups.map((entry) => renderGroup(ctx, entry.group, entry.statuses, selectedId)),
    );
  }

  return {
    id: 'build',
    title: t('panel.build'),
    // Deliberately false - see the file header. Select here, place in the world, so this
    // panel may not take the pointer or the keyboard away from the world.
    captures: false,

    mount(ctx: UiContext): HTMLElement {
      injectBuildStyles();
      const view = ensureParts();
      // Forget the cached signatures so the first update after an open draws from scratch.
      selectionSignature = '';
      listSignature = '';
      seededExpansion = false;
      const root = panelFrame('Build', () => ctx.close('build'), view.body, 'panel--build');
      root.setAttribute('data-testid', 'build-panel');
      return root;
    },

    update(ctx: UiContext): void {
      const view = ensureParts();
      const player = ctx.session.self;
      if (!player) {
        // Still joining: no authoritative player, so there is nothing honest to draw.
        if (listSignature !== 'none') {
          listSignature = 'none';
          selectionSignature = '';
          view.selection.replaceChildren(
            el('span', { className: 'muted', text: 'Waiting for the world…' }),
          );
          view.toolbar.replaceChildren();
          view.groups.replaceChildren(
            el('p', {
              className: 'muted',
              text: 'The build menu fills in once the server has spawned you.',
              attrs: { 'data-testid': 'build-waiting' },
            }),
          );
        }
        return;
      }

      const cat = catalogueFor(ctx);
      const counts = costCounts(player, cat.costItemSet);
      const tools = availableToolKinds(ctx, player);
      const selectedId = player.buildDefId;

      // Open the group holding whatever is already selected, once per open, so a player
      // coming back to the menu can see what their ghost is. After that the set is theirs.
      if (!seededExpansion) {
        seededExpansion = true;
        const selectedDef =
          selectedId === undefined ? undefined : ctx.data.structures.get(selectedId);
        const first = cat.groups[0];
        if (selectedDef) expanded.add(selectedDef.category);
        else if (first) expanded.add(first.category);
      }

      // --- signatures -----------------------------------------------------
      // Two of them, because rotating a held piece changes the strip on every frame the
      // key is down and that must not rebuild the list with it.
      const inventoryKey = cat.costItemIds.map((id) => counts.get(id) ?? 0).join(',');
      const toolKey = cat.toolKinds.map((kind) => (tools.has(kind) ? '1' : '0')).join('');
      const skillKey = cat.skillIds.map((id) => player.skills[id].level).join(',');
      const shared = `${inventoryKey}|${toolKey}|${skillKey}|${player.alive ? 1 : 0}`;

      const nextList = `${[...expanded].sort().join(',')}|${selectedId ?? '-'}|${shared}`;
      const nextSelection = `${selectedId ?? '-'}|${player.buildRotation}|${shared}`;
      const listChanged = nextList !== listSignature;
      const selectionChanged = nextSelection !== selectionSignature;
      if (!listChanged && !selectionChanged) return;

      if (selectionChanged) {
        selectionSignature = nextSelection;
        // The strip describes the selection even when its group is collapsed, so this
        // status is resolved from the registry rather than from the rendered rows.
        const selectedDef =
          selectedId === undefined ? undefined : ctx.data.structures.get(selectedId);
        renderSelection(
          ctx,
          selectedDef ? computeStatus(ctx, player, selectedDef, counts, tools) : null,
          player.buildRotation,
        );
      }

      if (listChanged) {
        listSignature = nextList;
        const groups = cat.groups.map((group) => ({
          group,
          // Statuses are computed for collapsed groups too: the header's ready count is
          // the reason a player expands one in the first place.
          statuses: group.entries.map((def) => computeStatus(ctx, player, def, counts, tools)),
        }));
        renderList(ctx, groups, selectedId);
      }
    },

    unmount(): void {
      // Only view state is dropped. The selection itself belongs to the server and
      // survives the panel closing, which is the point: close the menu, keep placing.
      selectionSignature = '';
      listSignature = '';
    },
  };
}
