import {
  EQUIP_SLOTS,
  SIM_HZ,
  TILE_SIZE,
  type CraftJobState,
  type EntityId,
  type ItemStack,
  type PlayerState,
} from '@survive/protocol';
import {
  UNLOCK_TAG_PREFIX,
  type RecipeCategory,
  type RecipeDef,
  type RecipeInput,
  type StationKind,
  type ToolKind,
} from '@survive/game-data';
import { UI, cssColor } from '../../art/palette';
import { button, el, humanize, itemIconUrl, itemSlot, itemTooltip, panelFrame } from '../kit';
import { t } from '../strings';
import type { Panel, UiContext } from '../panel';

/**
 * The crafting panel.
 *
 * There are north of a hundred recipes, so this screen is a browser first and a button
 * second: filter by category, filter by station, type a few letters, then look at one
 * recipe in detail and queue it.
 *
 * Three rules shape the whole file.
 *
 * 1. **The server decides.** Nothing here consumes an item, starts a timer or advances a
 *    job. Every button becomes a `craft` / `cancelCraft` intent and the next snapshot is
 *    what changes the display.
 * 2. **The greying-out logic re-derives the server's own predicate.** `checkCraft` in
 *    `@survive/simulation/systems/crafting/crafting` is the source of truth;
 *    {@link computeStatus} below walks the same checks in the same order against the same
 *    replicated state, purely so the player is never clicking into a wall. It deducts
 *    nothing: if the two ever disagree the server wins and emits `craftFailed`, which the
 *    HUD shows as a toast.
 * 3. **Diff before rebuilding.** `update` runs every rendered frame. A hundred rows of
 *    icons rebuilt at 60fps is visible jank, so the recipe list, the station strip, the
 *    detail footer and the queue each carry a signature of exactly the state they draw.
 *    Progress bars are the one thing that must move every frame, and they move by writing
 *    a width onto retained nodes rather than by re-creating them.
 */

/** Every recipe category, in the order the filter row shows them. */
const CATEGORIES: readonly RecipeCategory[] = [
  'basic',
  'tools',
  'weapons',
  'ammo',
  'armor',
  'building',
  'cooking',
  'medical',
  'farming',
  'smelting',
  'textiles',
];

/** Every station kind, for the station filter's explicit options. */
const STATION_KINDS: readonly StationKind[] = [
  'workbench',
  'campfire',
  'furnace',
  'anvil',
  'loom',
  'cookingPot',
  'chemistry',
  'grindstone',
];

/**
 * Server limits this panel has to respect, mirrored rather than imported.
 *
 * `STATION_REACH`, `MAX_CRAFT_COUNT` and `MAX_QUEUED_JOBS` are all exported from
 * `@survive/simulation`, but pulling the crafting *system* into the renderer to read three
 * numbers would drag the whole simulation graph into the client bundle for no gain. The
 * cost of that trade is drift, and the cost of drift here is bounded: every one of these
 * only ever decides whether a button looks pressable. The command is re-validated on
 * arrival, so being a tile stingy or one unit generous costs a rejection toast, never a
 * wrong outcome. Grep those names in `@survive/simulation` before changing them.
 */
const STATION_REACH = TILE_SIZE * 2;
const MAX_CRAFT_COUNT = 99;
const MAX_QUEUED_JOBS = 8;

type CategoryFilter = RecipeCategory | 'all';

/**
 * Station filter values.
 *
 * `available` is the honest default - hand recipes plus whatever the player is standing
 * next to. `all` is the teaching mode: it shows the entire tree with unreachable recipes
 * greyed rather than hidden, which is how a new player finds out that planks need a
 * workbench and a saw. The panel opens in `all` when there is no station in reach and in
 * `available` when there is, so the filter is useful at both ends of the game.
 */
type StationFilter = 'available' | 'all' | 'hand' | StationKind;

type QuantityMode = 'one' | 'five' | 'max';

/** A station structure the player can currently reach. */
interface NearbyStation {
  id: EntityId;
  kind: StationKind;
  name: string;
  lit: boolean;
  needsFuel: boolean;
  fuel: number;
  jobs: readonly CraftJobState[];
  /** Who built it. The station's owner may clear jobs that are not theirs. */
  ownerId: string | undefined;
  distance: number;
}

/** One input line of a recipe, resolved against what the player is carrying. */
interface InputStatus {
  /** What to draw the icon from. Tag inputs use the recipe's canonical example item. */
  iconDefId: string;
  label: string;
  /** Items needed per craft - or durability points, when {@link worn} is set. */
  need: number;
  have: number;
  ok: boolean;
  /**
   * True for a `consumeDurability` input: a mould or jig that is worn down rather than
   * eaten. It still bounds a batch, because the server demands the whole job's wear up
   * front, but it is measured in durability points and it is never reserved.
   */
  worn: boolean;
  /** Crafts this one input allows. `Infinity` for an input that cannot run out. */
  maxUnits: number;
}

/** Everything the panel needs to know about one recipe right now. */
interface RecipeStatus {
  recipe: RecipeDef;
  inputs: InputStatus[];
  missingTools: ToolKind[];
  /** The reachable station serving this recipe, or null (hand recipe, or none in reach). */
  station: NearbyStation | null;
  stationOk: boolean;
  skillLevel: number;
  /** Level the recipe demands, or null when it is ungated. */
  skillNeeded: number | null;
  /** Whether the player carries a schematic for a recipe that is not known by default. */
  unlocked: boolean;
  /** How many the carried materials allow, capped at the server's per-command limit. */
  maxCount: number;
  /** Why the craft button is off, or null when it is on. */
  blockedReason: string | null;
  /** Things worth saying that do not stop the player queueing the job. */
  warnings: string[];
}

/** One row of the active queue, whether it is in the player's hands or at a station. */
interface QueueEntry {
  job: CraftJobState;
  /** Station the row belongs to, for `cancelCraft`. Absent for a hand job. */
  stationId: EntityId | undefined;
  where: string;
  /** Only the head of each queue advances, so only the head has a moving bar. */
  active: boolean;
  /** The server only lets the crafter or the station's owner cancel a job. */
  cancellable: boolean;
}

const STYLE_ID = 'survive-crafting-styles';

/**
 * Panel-local styles.
 *
 * Injected from here with a guarded unique id rather than added to `kit.ts`: the recipe
 * row is a layout nothing else in the interface needs, and the shared stylesheet stays
 * the shared stylesheet. Everything that *is* shared - `.btn`, `.bar`, `.slot`,
 * `.effect-chip`, `.muted`, `.section-title`, `.row`, `.col` - is reused as-is.
 */
function injectCraftingStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .panel--craft { width: min(880px, 94vw); }
    .craft-body { display: flex; flex-direction: column; gap: 10px; overflow: hidden; }
    .craft-controls { display: flex; flex-direction: column; gap: 7px; flex: none; }
    .craft-search {
      flex: 1; min-width: 140px; padding: 5px 8px; font: inherit; font-size: 12px;
      color: ${cssColor(UI.text)}; background: ${cssColor(UI.slot)};
      border: 1px solid ${cssColor(UI.slotEdge)}; border-radius: 4px;
    }
    .craft-select {
      padding: 5px 8px; font: inherit; font-size: 12px; color: ${cssColor(UI.text)};
      background: ${cssColor(UI.slot)}; border: 1px solid ${cssColor(UI.slotEdge)};
      border-radius: 4px;
    }
    .craft-cats { display: flex; flex-wrap: wrap; gap: 4px; }
    .craft-cat { padding: 3px 8px; font-size: 11px; font-weight: 500; }
    .craft-cat[aria-pressed="true"] {
      border-color: ${cssColor(UI.accent)}; color: ${cssColor(UI.accent)};
    }
    .craft-nearby {
      display: flex; flex-wrap: wrap; gap: 4px; align-items: center; min-height: 18px;
    }

    .craft-list {
      flex: 1 1 auto; min-height: 160px; max-height: 44vh; overflow-y: auto;
      display: flex; flex-direction: column; gap: 3px; padding-right: 2px;
    }
    .craft-row {
      display: grid; grid-template-columns: 38px minmax(120px, 1fr) minmax(0, 1.6fr) auto;
      gap: 9px; align-items: center; width: 100%; text-align: left; cursor: pointer;
      padding: 5px 7px; font: inherit; color: ${cssColor(UI.text)};
      background: ${cssColor(UI.slot, 0.55)};
      border: 1px solid ${cssColor(UI.slotEdge)}; border-radius: 4px;
    }
    .craft-row:hover { background: ${cssColor(UI.slotHover, 0.85)}; }
    .craft-row[aria-pressed="true"] {
      border-color: ${cssColor(UI.accent)}; background: ${cssColor(UI.slotHover, 0.95)};
    }
    /* Station out of reach: readable, but plainly not available yet. */
    .craft-row--locked { opacity: 0.5; }
    .craft-row--locked:hover { opacity: 0.8; }
    .craft-out { display: grid; place-items: center; }
    .craft-out img { width: 28px; height: 28px; image-rendering: pixelated; }
    .craft-out-count { font-family: monospace; font-size: 10px; }
    .craft-name { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .craft-name b {
      font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .craft-sub { font-size: 10px; color: ${cssColor(UI.textMuted)}; }
    .craft-chips { display: flex; flex-wrap: wrap; gap: 3px; }
    .craft-chip {
      display: inline-flex; align-items: center; gap: 3px; padding: 1px 5px;
      border-radius: 3px; font-size: 10px; font-family: monospace;
      background: rgba(0,0,0,0.35); border: 1px solid ${cssColor(UI.slotEdge)};
    }
    .craft-chip img { width: 14px; height: 14px; image-rendering: pixelated; }
    .craft-chip--ok { border-color: ${cssColor(UI.accent, 0.7)}; color: ${cssColor(UI.accent)}; }
    .craft-chip--miss { border-color: ${cssColor(UI.danger, 0.7)}; color: ${cssColor(UI.danger)}; }
    .craft-chip--warn { border-color: ${cssColor(UI.warn, 0.7)}; color: ${cssColor(UI.warn)}; }
    .craft-time {
      font-family: monospace; font-size: 11px; text-align: right;
      color: ${cssColor(UI.textMuted)}; white-space: nowrap;
    }

    .craft-detail {
      flex: none; display: flex; gap: 12px; align-items: flex-start; padding-top: 9px;
      border-top: 1px solid ${cssColor(UI.panelEdge)};
    }
    .craft-detail-main { flex: 1; display: flex; flex-direction: column; gap: 5px; min-width: 0; }
    .craft-detail-actions {
      display: flex; flex-direction: column; gap: 6px; align-items: flex-end; flex: none;
    }
    .craft-qty { display: flex; gap: 4px; }
    .craft-qty .btn { padding: 4px 9px; font-size: 11px; }
    .craft-qty .btn[aria-pressed="true"] {
      border-color: ${cssColor(UI.accent)}; color: ${cssColor(UI.accent)};
    }

    .craft-queue {
      flex: none; display: flex; flex-direction: column; gap: 4px;
      max-height: 22vh; overflow-y: auto;
    }
    .craft-job {
      display: grid; grid-template-columns: minmax(110px, 1fr) minmax(90px, 1.4fr) auto auto auto;
      gap: 8px; align-items: center; padding: 4px 7px;
      background: ${cssColor(UI.slot, 0.55)}; border: 1px solid ${cssColor(UI.slotEdge)};
      border-radius: 4px;
    }
    .craft-job .btn { padding: 3px 8px; font-size: 11px; }
    .craft-job-name { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  `;
  document.head.append(style);
}

/** Turn `cookingPot` or `wood_log` into `Cooking Pot` / `Wood Log`. */
function labelFor(id: string): string {
  return humanize(id.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase());
}

/** Craft durations live in ticks; players think in seconds. */
function secondsLabel(ticks: number): string {
  const value = ticks / SIM_HZ;
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)}s`;
}

/** An input's have/need, with a readable stand-in for "cannot run out". */
function amountText(have: number, need: number): string {
  return `${Number.isFinite(have) ? Math.floor(have) : '∞'}/${need}`;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Distance in pixels from a point to the nearest edge of a structure's footprint.
 *
 * Same shape as the simulation's `distanceToStructure`, including the rotation swap: a
 * 2x1 workbench turned sideways is 1x2, and the player should be able to work at either
 * end of it.
 */
function distanceToFootprint(
  x: number,
  y: number,
  tileX: number,
  tileY: number,
  width: number,
  height: number,
): number {
  const minX = tileX * TILE_SIZE;
  const minY = tileY * TILE_SIZE;
  const maxX = minX + width * TILE_SIZE;
  const maxY = minY + height * TILE_SIZE;
  const dx = x < minX ? minX - x : x > maxX ? x - maxX : 0;
  const dy = y < minY ? minY - y : y > maxY ? y - maxY : 0;
  return Math.hypot(dx, dy);
}

/**
 * Every reachable station, nearest first.
 *
 * Read from the replicated structure entities, which is all the client has - and all it
 * needs, since a station outside the area of interest is by definition too far to use.
 * Unfinished blueprints (`progress < 1`) are skipped because the server refuses to work
 * at them.
 */
function findNearbyStations(ctx: UiContext, player: PlayerState): NearbyStation[] {
  const found: NearbyStation[] = [];
  for (const entity of ctx.session.store.entitiesOfKind('structure')) {
    if (entity.k !== 'structure') continue;
    const station = entity.station;
    if (!station) continue;
    if (entity.progress < 1) continue;
    const def = ctx.data.structures.get(entity.defId);
    if (!def?.station) continue;
    const swapped = entity.rotation % 2 === 1;
    const distance = distanceToFootprint(
      player.x,
      player.y,
      entity.tileX,
      entity.tileY,
      swapped ? def.height : def.width,
      swapped ? def.width : def.height,
    );
    if (distance > STATION_REACH) continue;
    found.push({
      id: entity.id,
      kind: def.station.kind,
      name: def.name,
      lit: station.lit,
      needsFuel: def.station.needsFuel,
      fuel: station.fuel,
      jobs: station.jobs,
      ownerId: entity.ownerId,
      distance,
    });
  }
  // Nearest first, then by id so the order cannot flicker between two equidistant
  // stations as the player's position jitters.
  found.sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
  return found;
}

/** Nearest reachable station per kind, so a recipe resolves to one unambiguous id. */
function stationsByKind(nearby: readonly NearbyStation[]): Map<StationKind, NearbyStation> {
  const map = new Map<StationKind, NearbyStation>();
  for (const station of nearby) if (!map.has(station.kind)) map.set(station.kind, station);
  return map;
}

/**
 * Total count of every item def in the backpack proper.
 *
 * Deliberately *not* including equipment: the simulation's `countItem` / `countTag` read
 * `player.inventory` alone, so a recipe cannot be paid for with the coat on your back.
 */
function inventoryCounts(player: PlayerState): Map<string, number> {
  const counts = new Map<string, number>();
  for (const stack of player.inventory.slots) {
    if (!stack) continue;
    counts.set(stack.defId, (counts.get(stack.defId) ?? 0) + stack.count);
  }
  return counts;
}

/**
 * Tool roles the player can currently fill.
 *
 * Mirrors the simulation's `findTool`: the two hands first, then anything in the
 * backpack. Only membership matters here - which specific hatchet gets worn down, and how
 * much its condition speeds the job up, is the server's business.
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
 * Has the player learned this recipe?
 *
 * Schematics are carried, not memorised: an item tagged `unlocks:<recipeId>` anywhere on
 * the player grants it. Same scan as the simulation's `isRecipeUnlocked`, over every
 * equipment slot and then the backpack.
 */
function isUnlocked(ctx: UiContext, player: PlayerState, recipe: RecipeDef): boolean {
  if (recipe.unlockedByDefault) return true;
  const tag = `${UNLOCK_TAG_PREFIX}${recipe.id}`;
  const carries = (stack: ItemStack | null): boolean =>
    stack !== null && (ctx.data.items.get(stack.defId)?.tags.includes(tag) ?? false);
  for (const slot of EQUIP_SLOTS) if (carries(player.equipment[slot])) return true;
  for (const stack of player.inventory.slots) if (carries(stack)) return true;
  return false;
}

/** Durability left on the first item of a def the player carries, hands and pockets. */
function durabilityOf(player: PlayerState, defId: string): number | null {
  for (const slot of EQUIP_SLOTS) {
    const stack = player.equipment[slot];
    if (stack?.defId === defId) return stack.durability ?? Number.POSITIVE_INFINITY;
  }
  for (const stack of player.inventory.slots) {
    if (stack?.defId === defId) return stack.durability ?? Number.POSITIVE_INFINITY;
  }
  return null;
}

/** How many of a recipe input the player has, following tag substitution. */
function haveFor(ctx: UiContext, input: RecipeInput, counts: Map<string, number>): number {
  if (input.tag === undefined) return counts.get(input.defId) ?? 0;
  let total = 0;
  for (const item of ctx.data.itemsWithTag(input.tag)) total += counts.get(item.id) ?? 0;
  return total;
}

/** Resolve one input line against the player, as the server's input loop would. */
function resolveInput(
  ctx: UiContext,
  player: PlayerState,
  input: RecipeInput,
  counts: Map<string, number>,
): InputStatus {
  const label =
    input.tag === undefined
      ? (ctx.data.items.get(input.defId)?.name ?? labelFor(input.defId))
      : `any ${labelFor(input.tag)}`;

  if (input.consumeDurability !== undefined && input.consumeDurability > 0) {
    // A worn input is checked against the item's remaining durability, not against a
    // stack count, and the whole batch's wear has to be there before the job is queued.
    const have = durabilityOf(player, input.defId) ?? 0;
    const need = input.consumeDurability;
    return {
      iconDefId: input.defId,
      label,
      need,
      have,
      ok: have >= need,
      worn: true,
      maxUnits: Math.floor(have / need),
    };
  }

  // `count` is clamped to at least one so a malformed table entry cannot divide by zero
  // while working out the batch size.
  const need = Math.max(1, input.count);
  const have = haveFor(ctx, input, counts);
  return {
    iconDefId: input.defId,
    label,
    need,
    have,
    ok: have >= need,
    worn: false,
    maxUnits: Math.floor(have / need),
  };
}

/**
 * Is there plausibly room for the result? Advisory only.
 *
 * The server projects the real bin-packing (`addToInventory` over a cloned inventory,
 * after the inputs come out) and refuses a hand craft that would not fit. Reproducing
 * that faithfully here would mean re-implementing stack merging in the UI layer, and
 * getting it slightly wrong would grey out a button the server would have honoured -
 * strictly worse than a rejection toast. So this is the cheap version and it only ever
 * produces a warning: an empty slot, or a partial stack of the output, means fine.
 */
function mayHaveRoom(ctx: UiContext, player: PlayerState, recipe: RecipeDef): boolean {
  if (recipe.station !== undefined) return true;
  for (const stack of player.inventory.slots) if (!stack) return true;
  for (const output of recipe.outputs) {
    const stackSize = ctx.data.items.get(output.defId)?.stackSize ?? 1;
    if (stackSize <= 1) continue;
    for (const stack of player.inventory.slots) {
      if (stack?.defId === output.defId && stack.count < stackSize) return true;
    }
  }
  return false;
}

/**
 * Resolve one recipe against the player's current situation.
 *
 * The order of the checks is the order of the simulation's `checkCraft`, so the reason
 * shown is the reason the server would have given. The split between `blockedReason` and
 * `warnings` follows the same authority: a blocked reason is something `checkCraft`
 * rejects outright, while a warning is something that merely stalls the job *after* it is
 * queued - an unlit fire under a recipe that does not demand heat, a hopper about to run
 * dry - which is why `CraftJobState` carries a `blockedReason` field at all.
 */
function computeStatus(
  ctx: UiContext,
  player: PlayerState,
  recipe: RecipeDef,
  counts: Map<string, number>,
  tools: Set<ToolKind>,
  byKind: Map<StationKind, NearbyStation>,
): RecipeStatus {
  const station = recipe.station === undefined ? null : (byKind.get(recipe.station) ?? null);
  const stationOk = recipe.station === undefined || station !== null;

  const inputs = recipe.inputs.map((input) => resolveInput(ctx, player, input, counts));
  const missingTools = recipe.tools.filter((kind) => !tools.has(kind));
  const required = recipe.requiredSkill;
  const skillLevel = required ? player.skills[required.id].level : 0;
  const unlocked = isUnlocked(ctx, player, recipe);

  // The server caps a single command at `MAX_CRAFT_COUNT`, so offering more would only
  // earn a rejection. Every input bounds the batch, worn ones included.
  let maxCount = MAX_CRAFT_COUNT;
  for (const input of inputs) maxCount = Math.min(maxCount, input.maxUnits);
  maxCount = Math.max(0, Math.floor(maxCount));

  const queueDepth = station ? station.jobs.length : player.craftQueue.length;

  const warnings: string[] = [];
  if (station && station.needsFuel && !station.lit && !recipe.requiresHeat) {
    warnings.push(`${station.name} is not lit`);
  }
  if (
    station &&
    station.needsFuel &&
    recipe.fuelCost !== undefined &&
    station.fuel < recipe.fuelCost
  ) {
    warnings.push('low on fuel');
  }
  if (!mayHaveRoom(ctx, player, recipe)) warnings.push('your pack may be full');

  let blockedReason: string | null = null;
  if (!player.alive) blockedReason = 'you are dead';
  else if (!unlocked) blockedReason = 'you have not learned that recipe';
  else if (required && skillLevel < required.level) {
    blockedReason = `needs ${labelFor(required.id).toLowerCase()} level ${required.level}`;
  } else if (recipe.station !== undefined && !station) {
    blockedReason = `needs a ${labelFor(recipe.station).toLowerCase()} nearby`;
  } else if (station && recipe.requiresHeat && !station.lit) {
    blockedReason = 'the station is not lit';
  } else if (queueDepth >= MAX_QUEUED_JOBS) blockedReason = 'that crafting queue is full';
  else if (missingTools.length > 0) {
    blockedReason = `needs ${missingTools.map((kind) => labelFor(kind).toLowerCase()).join(', ')}`;
  } else if (maxCount < 1) {
    const short = inputs.find((input) => !input.ok);
    blockedReason = short ? `needs ${short.need} x ${short.label}` : 'not enough materials';
  }

  return {
    recipe,
    inputs,
    missingTools,
    station,
    stationOk,
    skillLevel,
    skillNeeded: required ? required.level : null,
    unlocked,
    maxCount,
    blockedReason,
    warnings,
  };
}

/** Does the free-text query match this recipe, by its own name or its outputs'? */
function matchesSearch(ctx: UiContext, recipe: RecipeDef, query: string): boolean {
  if (query === '') return true;
  if (recipe.name.toLowerCase().includes(query)) return true;
  if (recipe.id.toLowerCase().includes(query)) return true;
  for (const output of recipe.outputs) {
    const name = ctx.data.items.get(output.defId)?.name ?? output.defId;
    if (name.toLowerCase().includes(query)) return true;
    if (output.defId.toLowerCase().includes(query)) return true;
  }
  return false;
}

function passesStationFilter(
  recipe: RecipeDef,
  filter: StationFilter,
  byKind: Map<StationKind, NearbyStation>,
): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'hand':
      return recipe.station === undefined;
    case 'available':
      return recipe.station === undefined || byKind.has(recipe.station);
    default:
      return recipe.station === filter;
  }
}

/** The whole queue in one list: the player's own jobs, then each nearby station's. */
function collectQueue(player: PlayerState, nearby: readonly NearbyStation[]): QueueEntry[] {
  const entries: QueueEntry[] = [];
  for (const [index, job] of player.craftQueue.entries()) {
    entries.push({
      job,
      stationId: undefined,
      where: 'By hand',
      active: index === 0,
      cancellable: true,
    });
  }
  for (const station of nearby) {
    for (const [index, job] of station.jobs.entries()) {
      entries.push({
        job,
        // A station job always carries its own station id; fall back to the structure we
        // found it on so a cancel still addresses the right queue.
        stationId: job.stationId ?? station.id,
        where: station.name,
        active: index === 0,
        // Same rule the server enforces: your job, or your machine.
        cancellable: job.crafterId === player.id || station.ownerId === player.id,
      });
    }
  }
  return entries;
}

/** A small icon + text chip, used for inputs, tools and station requirements. */
function chip(
  ctx: UiContext,
  text: string,
  tone: 'ok' | 'miss' | 'warn' | 'plain',
  iconDefId?: string,
  title?: string,
): HTMLSpanElement {
  const url = iconDefId === undefined ? null : itemIconUrl(ctx.textures, iconDefId);
  const node = el('span', {
    className: `craft-chip${tone === 'plain' ? '' : ` craft-chip--${tone}`}`,
    children: [url ? el('img', { attrs: { src: url, alt: '' } }) : null, el('span', { text })],
  });
  if (title !== undefined) node.title = title;
  return node;
}

/**
 * The crafting panel.
 *
 * All mutable view state (filters, selection, quantity) lives in this closure. None of it
 * is game state: it is what the player is *looking at*, which the server has no opinion
 * about.
 */
export function createCraftingPanel(): Panel {
  let category: CategoryFilter = 'all';
  let search = '';
  let stationFilter: StationFilter = 'available';
  /** Set once the player touches the station filter, so we stop overriding their choice. */
  let stationFilterPinned = false;
  let selectedId: string | null = null;
  let quantity: QuantityMode = 'one';

  // Signatures of exactly what each region draws. `mount` resets them to a value no
  // signature can take, so the first update after an open always paints.
  const FORCE = ' ';
  let listSignature = FORCE;
  let nearbySignature = FORCE;
  let detailSignature = FORCE;
  let queueSignature = FORCE;

  /** Retained progress nodes, keyed by job id, so bars can move without a rebuild. */
  const progressNodes = new Map<string, { fill: HTMLElement; value: HTMLElement }>();

  interface Parts {
    searchInput: HTMLInputElement;
    stationSelect: HTMLSelectElement;
    categoryButtons: Map<CategoryFilter, HTMLButtonElement>;
    nearbyRow: HTMLDivElement;
    list: HTMLDivElement;
    detail: HTMLDivElement;
    queue: HTMLDivElement;
    body: HTMLDivElement;
  }

  let parts: Parts | null = null;

  /**
   * Build the persistent chrome once.
   *
   * The search box in particular must survive every update: re-creating it would drop
   * focus and the caret mid-word. Same for the category buttons and the station select -
   * updates only flip their `aria-pressed` / `value`.
   */
  function ensureParts(): Parts {
    if (parts) return parts;

    const searchInput = el('input', {
      className: 'craft-search',
      attrs: {
        type: 'search',
        placeholder: 'Search recipes or outputs',
        'aria-label': 'Search recipes',
        'data-testid': 'craft-search',
      },
      on: {
        input: () => {
          search = searchInput.value.trim().toLowerCase();
        },
      },
    });

    const stationSelect = el('select', {
      className: 'craft-select',
      attrs: { 'aria-label': 'Filter by station', 'data-testid': 'craft-station-filter' },
      children: [
        el('option', { text: 'Available here', attrs: { value: 'available' } }),
        el('option', { text: 'All stations', attrs: { value: 'all' } }),
        el('option', { text: 'By hand', attrs: { value: 'hand' } }),
        ...STATION_KINDS.map((kind) =>
          el('option', { text: labelFor(kind), attrs: { value: kind } }),
        ),
      ],
      on: {
        change: () => {
          stationFilter = stationSelect.value as StationFilter;
          stationFilterPinned = true;
        },
      },
    });

    const categoryButtons = new Map<CategoryFilter, HTMLButtonElement>();
    const makeCategory = (value: CategoryFilter, label: string): HTMLButtonElement => {
      const node = button(label, () => {
        category = value;
      });
      node.classList.add('craft-cat');
      node.setAttribute('data-testid', `craft-category-${value}`);
      node.setAttribute('aria-pressed', String(value === category));
      categoryButtons.set(value, node);
      return node;
    };

    const categoryRow = el('div', {
      className: 'craft-cats',
      attrs: {
        role: 'group',
        'aria-label': 'Recipe categories',
        'data-testid': 'craft-categories',
      },
      children: [
        makeCategory('all', 'All'),
        ...CATEGORIES.map((id) => makeCategory(id, labelFor(id))),
      ],
    });

    const nearbyRow = el('div', {
      className: 'craft-nearby',
      attrs: { 'data-testid': 'craft-nearby' },
    });
    const list = el('div', {
      className: 'craft-list',
      attrs: { role: 'list', 'aria-label': 'Recipes', 'data-testid': 'craft-list' },
    });
    const detail = el('div', {
      className: 'craft-detail',
      attrs: { 'data-testid': 'craft-detail' },
    });
    const queue = el('div', { className: 'craft-queue', attrs: { 'data-testid': 'craft-queue' } });

    const body = el('div', {
      className: 'panel-body craft-body',
      children: [
        el('div', {
          className: 'craft-controls',
          children: [
            el('div', { className: 'row', children: [searchInput, stationSelect] }),
            categoryRow,
            nearbyRow,
          ],
        }),
        list,
        detail,
        el('div', {
          className: 'col',
          children: [el('div', { className: 'section-title', text: 'In progress' }), queue],
        }),
      ],
    });

    parts = { searchInput, stationSelect, categoryButtons, nearbyRow, list, detail, queue, body };
    return parts;
  }

  /** Push the current filter state onto the persistent controls. */
  function syncControls(view: Parts): void {
    for (const [value, node] of view.categoryButtons) {
      const pressed = String(value === category);
      if (node.getAttribute('aria-pressed') !== pressed) node.setAttribute('aria-pressed', pressed);
    }
    if (view.stationSelect.value !== stationFilter) view.stationSelect.value = stationFilter;
  }

  /** How many units the Craft button will ask for, given the quantity mode. */
  function effectiveCount(status: RecipeStatus): number {
    if (status.maxCount < 1) return 0;
    if (quantity === 'one') return 1;
    if (quantity === 'five') return Math.min(5, status.maxCount);
    return status.maxCount;
  }

  /** One recipe row. Selecting it is the only thing a click does. */
  function renderRow(ctx: UiContext, status: RecipeStatus): HTMLButtonElement {
    const { recipe } = status;
    const firstOutput = recipe.outputs[0];
    const outputDef = firstOutput ? ctx.data.items.get(firstOutput.defId) : undefined;
    const outputUrl = firstOutput ? itemIconUrl(ctx.textures, firstOutput.defId) : null;

    const outputCell = el('div', {
      className: 'craft-out',
      children: [
        outputUrl
          ? el('img', { attrs: { src: outputUrl, alt: outputDef?.name ?? '' } })
          : el('span', {
              className: 'craft-out-count',
              text: (outputDef?.name ?? firstOutput?.defId ?? '?').slice(0, 3),
            }),
        firstOutput && firstOutput.count > 1
          ? el('span', { className: 'craft-out-count', text: `x${firstOutput.count}` })
          : null,
      ],
    });

    // Category, where the work happens, and the gating skill with the level the player
    // actually has next to it - the whole point of showing it is the comparison.
    const subParts = [labelFor(recipe.category)];
    subParts.push(recipe.station === undefined ? 'by hand' : labelFor(recipe.station));
    if (status.skillNeeded !== null && recipe.requiredSkill) {
      subParts.push(
        `${labelFor(recipe.requiredSkill.id).toLowerCase()} ${status.skillLevel}/${status.skillNeeded}`,
      );
    }

    const chips: (Node | null)[] = status.inputs.map((input) =>
      chip(
        ctx,
        amountText(input.have, input.need),
        input.ok ? 'ok' : 'miss',
        input.iconDefId,
        input.worn
          ? `${input.label}: needs ${input.need} durability per craft`
          : `${input.label}: carrying ${input.have}, needs ${input.need}`,
      ),
    );
    for (const kind of recipe.tools) {
      const missing = status.missingTools.includes(kind);
      chips.push(
        chip(
          ctx,
          labelFor(kind).toLowerCase(),
          missing ? 'miss' : 'ok',
          undefined,
          missing
            ? `You have no ${labelFor(kind).toLowerCase()}`
            : `Using your ${labelFor(kind).toLowerCase()}`,
        ),
      );
    }
    if (!recipe.unlockedByDefault) {
      chips.push(
        chip(
          ctx,
          'schematic',
          status.unlocked ? 'ok' : 'warn',
          undefined,
          status.unlocked ? 'You are carrying the schematic' : 'Find the schematic to learn this',
        ),
      );
    }

    const row = el('button', {
      className: 'craft-row',
      attrs: {
        type: 'button',
        role: 'listitem',
        'aria-pressed': String(selectedId === recipe.id),
        'data-testid': `craft-recipe-${recipe.id}`,
      },
      title: status.blockedReason ?? `Craft ${recipe.name}`,
      children: [
        outputCell,
        el('div', {
          className: 'craft-name',
          children: [
            el('b', { text: recipe.name }),
            el('span', { className: 'craft-sub', text: subParts.join(' · ') }),
          ],
        }),
        el('div', { className: 'craft-chips', children: chips }),
        el('div', { className: 'craft-time', text: secondsLabel(recipe.craftTicks) }),
      ],
      on: {
        click: () => {
          selectedId = recipe.id;
          // A fresh selection starts at one: batching is an explicit choice, and "max"
          // carried over from another recipe is a good way to burn a stockpile.
          quantity = 'one';
        },
      },
    });
    // Greyed, never hidden: a recipe you cannot reach yet is how you learn what to build.
    if (!status.stationOk) row.classList.add('craft-row--locked');
    return row;
  }

  function renderList(ctx: UiContext, statuses: readonly RecipeStatus[]): void {
    const view = ensureParts();
    if (statuses.length === 0) {
      view.list.replaceChildren(
        el('p', {
          className: 'muted',
          text: 'No recipes match that filter.',
          attrs: { 'data-testid': 'craft-empty' },
        }),
      );
      return;
    }
    view.list.replaceChildren(...statuses.map((status) => renderRow(ctx, status)));
  }

  /** Chips naming the stations in reach, so "Available here" is never a mystery. */
  function renderNearby(nearby: readonly NearbyStation[]): void {
    const view = ensureParts();
    if (nearby.length === 0) {
      view.nearbyRow.replaceChildren(
        el('span', { className: 'muted', text: 'No station in reach — hand recipes only.' }),
      );
      return;
    }
    view.nearbyRow.replaceChildren(
      el('span', { className: 'muted', text: 'In reach:' }),
      ...nearby.map((station) =>
        el('span', {
          className: `effect-chip${station.needsFuel && !station.lit ? '' : ' effect-chip--good'}`,
          text: station.needsFuel
            ? `${station.name} ${station.lit ? 'lit' : 'unlit'}`
            : station.name,
          title: station.needsFuel
            ? `${station.name}: ${Math.round(station.fuel)} fuel, ${station.jobs.length} job(s)`
            : `${station.name}: ${station.jobs.length} job(s)`,
        }),
      ),
    );
  }

  function renderDetail(ctx: UiContext, status: RecipeStatus | null): void {
    const view = ensureParts();
    if (!status) {
      view.detail.replaceChildren(
        el('p', { className: 'muted', text: 'Select a recipe to craft it.' }),
      );
      return;
    }

    const { recipe } = status;
    const outputSlots = recipe.outputs.map((output) => {
      const stack: ItemStack = { defId: output.defId, count: output.count };
      const slot = itemSlot({ stack, data: ctx.data, textures: ctx.textures });
      slot.title =
        output.chance !== undefined && output.chance < 1
          ? `${itemTooltip(stack, ctx.data)}\n${Math.round(output.chance * 100)}% chance`
          : itemTooltip(stack, ctx.data);
      return slot;
    });

    const facts: string[] = [`${secondsLabel(recipe.craftTicks)} per unit`];
    facts.push(
      recipe.station === undefined
        ? 'craftable by hand'
        : `at a ${labelFor(recipe.station).toLowerCase()}`,
    );
    if (recipe.requiredSkill) {
      facts.push(
        `${labelFor(recipe.requiredSkill.id).toLowerCase()} ${status.skillLevel}/${recipe.requiredSkill.level}`,
      );
    }
    if (recipe.fuelCost !== undefined) facts.push(`${recipe.fuelCost} fuel`);
    if (recipe.requiresHeat) facts.push('needs heat');

    const inputChips = status.inputs.map((input) =>
      chip(
        ctx,
        `${input.label} ${amountText(input.have, input.need)}${input.worn ? ' dura' : ''}`,
        input.ok ? 'ok' : 'miss',
        input.iconDefId,
      ),
    );
    for (const kind of recipe.tools) {
      inputChips.push(
        chip(ctx, labelFor(kind).toLowerCase(), status.missingTools.includes(kind) ? 'miss' : 'ok'),
      );
    }

    const count = effectiveCount(status);
    const makeQuantity = (mode: QuantityMode, label: string): HTMLButtonElement => {
      const node = button(label, () => {
        quantity = mode;
      });
      node.setAttribute('aria-pressed', String(quantity === mode));
      node.setAttribute('data-testid', `craft-qty-${mode}`);
      node.disabled = status.maxCount < 1;
      return node;
    };

    const craftButton = button(
      `Craft x${count}`,
      () => {
        // Intent only. The server re-checks reach, schematic, skill, tools, materials and
        // queue space, then pushes the job onto `craftQueue` (or the station's) in the
        // next snapshot. Nothing is deducted here.
        ctx.send({
          type: 'craft',
          recipeId: recipe.id,
          count,
          ...(status.station ? { stationId: status.station.id } : {}),
        });
      },
      'primary',
      status.blockedReason !== null || count < 1,
    );
    craftButton.setAttribute('data-testid', 'craft-confirm');
    craftButton.setAttribute(
      'aria-label',
      `Craft ${count} ${recipe.name}${status.blockedReason ? ` — ${status.blockedReason}` : ''}`,
    );

    view.detail.replaceChildren(
      el('div', { className: 'row', children: outputSlots }),
      el('div', {
        className: 'craft-detail-main',
        children: [
          el('b', { text: recipe.name }),
          el('span', { className: 'craft-sub', text: facts.join(' · ') }),
          el('div', { className: 'craft-chips', children: inputChips }),
          status.blockedReason
            ? el('span', {
                className: 'effect-chip effect-chip--bad',
                text: status.blockedReason,
                attrs: { 'data-testid': 'craft-blocked' },
              })
            : null,
          status.warnings.length > 0
            ? el('div', {
                className: 'craft-chips',
                children: status.warnings.map((warning) => chip(ctx, warning, 'warn')),
              })
            : null,
        ],
      }),
      el('div', {
        className: 'craft-detail-actions',
        children: [
          el('div', {
            className: 'craft-qty',
            attrs: { role: 'group', 'aria-label': 'Quantity' },
            children: [
              makeQuantity('one', '1'),
              makeQuantity('five', '5'),
              makeQuantity('max', `Max (${status.maxCount})`),
            ],
          }),
          craftButton,
        ],
      }),
    );
  }

  /**
   * The active queue.
   *
   * Rebuilt only when a job appears, finishes, changes its remaining count or gets stuck;
   * the bars themselves are advanced by {@link advanceProgress} every frame.
   */
  function renderQueue(ctx: UiContext, entries: readonly QueueEntry[]): void {
    const view = ensureParts();
    progressNodes.clear();

    if (entries.length === 0) {
      view.queue.replaceChildren(el('p', { className: 'muted', text: 'Nothing being crafted.' }));
      return;
    }

    view.queue.replaceChildren(
      ...entries.map((entry) => {
        const recipe = ctx.data.recipes.get(entry.job.recipeId);
        const name = recipe?.name ?? labelFor(entry.job.recipeId);
        const fill = el('div', { className: 'bar-fill' });
        fill.style.background = cssColor(entry.job.blockedReason ? UI.warn : UI.accent);
        const value = el('span', { className: 'bar-value', text: '0%' });
        progressNodes.set(entry.job.jobId, { fill, value });

        const cancel = button(
          'Cancel',
          () => {
            // The server refunds every unstarted unit; the one under the hammer is lost.
            ctx.send({
              type: 'cancelCraft',
              jobId: entry.job.jobId,
              ...(entry.stationId ? { stationId: entry.stationId } : {}),
            });
          },
          'danger',
          !entry.cancellable,
        );
        cancel.setAttribute('data-testid', `craft-cancel-${entry.job.jobId}`);
        cancel.setAttribute(
          'aria-label',
          entry.cancellable ? `Cancel ${name}` : `Cannot cancel ${name} — not your job`,
        );

        return el('div', {
          className: 'craft-job',
          attrs: { 'data-testid': `craft-job-${entry.job.jobId}` },
          children: [
            el('div', {
              className: 'craft-job-name',
              children: [
                el('b', { text: name }),
                el('span', {
                  className: 'craft-sub',
                  // Only the head of a queue advances, so say so rather than showing a
                  // bar that will sit at zero for a minute.
                  text: entry.active ? entry.where : `${entry.where} · waiting`,
                }),
              ],
            }),
            el('div', {
              className: 'bar bar--compact',
              children: [el('div', { className: 'bar-track', children: [fill] }), value],
            }),
            el('span', {
              className: 'craft-time',
              text: `x${entry.job.remaining}`,
              title: `${entry.job.remaining} left, ${secondsLabel(entry.job.ticksPerUnit)} each`,
            }),
            entry.job.blockedReason
              ? el('span', {
                  className: 'effect-chip effect-chip--bad',
                  text: entry.job.blockedReason,
                })
              : el('span', { text: '' }),
            cancel,
          ],
        });
      }),
    );
  }

  /** Move the retained progress bars. The only per-frame DOM writes in the panel. */
  function advanceProgress(entries: readonly QueueEntry[]): void {
    for (const entry of entries) {
      const nodes = progressNodes.get(entry.job.jobId);
      if (!nodes) continue;
      const total = entry.job.ticksPerUnit > 0 ? entry.job.ticksPerUnit : 1;
      const fraction = clamp01(1 - entry.job.ticksLeft / total);
      const width = `${(fraction * 100).toFixed(1)}%`;
      if (nodes.fill.style.width !== width) nodes.fill.style.width = width;
      const text = `${Math.round(fraction * 100)}%`;
      if (nodes.value.textContent !== text) nodes.value.textContent = text;
    }
  }

  return {
    id: 'crafting',
    title: t('panel.crafting'),
    captures: true,

    mount(ctx: UiContext): HTMLElement {
      injectCraftingStyles();
      const view = ensureParts();
      // Each open re-derives the station filter from where the player is standing, and
      // forgets every cached signature so the first update paints from scratch.
      stationFilterPinned = false;
      listSignature = FORCE;
      nearbySignature = FORCE;
      detailSignature = FORCE;
      queueSignature = FORCE;
      const root = panelFrame('Crafting', () => ctx.close('crafting'), view.body, 'panel--craft');
      root.setAttribute('data-testid', 'crafting-panel');
      return root;
    },

    update(ctx: UiContext): void {
      const view = ensureParts();
      const player = ctx.session.self;
      if (!player) {
        // No authoritative player yet (still joining): say so once and do nothing else.
        if (listSignature !== 'joining') {
          listSignature = 'joining';
          nearbySignature = FORCE;
          detailSignature = FORCE;
          queueSignature = FORCE;
          view.list.replaceChildren(
            el('p', { className: 'muted', text: 'Waiting for the world…' }),
          );
          view.nearbyRow.replaceChildren();
          view.detail.replaceChildren();
          view.queue.replaceChildren();
          progressNodes.clear();
        }
        return;
      }

      // Proximity is judged from the authoritative position, not the predicted one: the
      // server validates reach against exactly this value, so agreeing with it is what
      // stops the panel offering a station the server will refuse.
      const nearby = findNearbyStations(ctx, player);
      const byKind = stationsByKind(nearby);

      if (!stationFilterPinned) {
        // With a station in reach, "what can I make here" is the useful default. With
        // none, "everything, greyed" is: that is how a player learns the tech tree.
        stationFilter = byKind.size > 0 ? 'available' : 'all';
      }
      syncControls(view);

      const counts = inventoryCounts(player);
      const tools = availableToolKinds(ctx, player);

      const visible: RecipeStatus[] = [];
      for (const recipe of ctx.data.recipes.all()) {
        if (category !== 'all' && recipe.category !== category) continue;
        if (!passesStationFilter(recipe, stationFilter, byKind)) continue;
        if (!matchesSearch(ctx, recipe, search)) continue;
        visible.push(computeStatus(ctx, player, recipe, counts, tools, byKind));
      }
      // Reachable recipes first, then alphabetically. Sorting on station reach rather
      // than on materials keeps the order stable while a craft drains a stack.
      visible.sort(
        (a, b) =>
          Number(a.stationOk === false) - Number(b.stationOk === false) ||
          a.recipe.name.localeCompare(b.recipe.name),
      );

      if (selectedId !== null && !ctx.data.recipes.has(selectedId)) selectedId = null;
      const selectedRecipe = selectedId === null ? undefined : ctx.data.recipes.get(selectedId);
      // Recomputed rather than looked up in `visible`, so the footer survives a filter
      // change that hides its row instead of blanking out under the player's cursor.
      const selected = selectedRecipe
        ? computeStatus(ctx, player, selectedRecipe, counts, tools, byKind)
        : null;

      const entries = collectQueue(player, nearby);

      // --- signatures: one per region, covering exactly what that region draws -----

      // Everything a row's contents depend on. Station *fuel* is deliberately absent: no
      // row renders it, and it ticks down every snapshot while a fire burns, which would
      // otherwise rebuild forty rows at 10Hz for no visible change.
      const shared = [
        [...counts]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([defId, count]) => `${defId}:${count}`)
          .join(','),
        [...tools].sort().join(','),
        Object.entries(player.skills)
          .map(([id, state]) => `${id}:${state.level}`)
          .join(','),
        nearby.map((s) => `${s.id}:${s.kind}:${s.lit ? 1 : 0}:${s.jobs.length}`).join(','),
        `${player.craftQueue.length}`,
        player.alive ? '1' : '0',
      ].join('|');

      const nextList = `${category}|${search}|${stationFilter}|${selectedId ?? '-'}|${visible.length}|${shared}`;
      if (nextList !== listSignature) {
        listSignature = nextList;
        renderList(ctx, visible);
      }

      const nextNearby = nearby
        // Fuel bucketed to ten points: the chip's tooltip shows it, and a fresh render per
        // burnt tick would be pure churn.
        .map((s) => `${s.id}:${s.lit ? 1 : 0}:${Math.round(s.fuel / 10)}:${s.jobs.length}`)
        .join(',');
      if (nextNearby !== nearbySignature) {
        nearbySignature = nextNearby;
        renderNearby(nearby);
      }

      // Built from the resolved status rather than from raw state, so it changes exactly
      // when the footer's pixels would.
      const nextDetail = selected
        ? [
            selected.recipe.id,
            quantity,
            selected.maxCount,
            selected.blockedReason ?? '',
            selected.warnings.join(';'),
            selected.inputs.map((input) => `${input.have}/${input.need}`).join(','),
            selected.missingTools.join(','),
            selected.skillLevel,
            selected.station?.id ?? '-',
          ].join('|')
        : 'none';
      if (nextDetail !== detailSignature) {
        detailSignature = nextDetail;
        renderDetail(ctx, selected);
      }

      // Length leads, so an empty queue still differs from the initial signature and the
      // "nothing being crafted" line actually gets drawn.
      const nextQueue = `${entries.length}|${entries
        .map(
          (entry) =>
            `${entry.job.jobId}:${entry.job.remaining}:${entry.active ? 1 : 0}:${
              entry.cancellable ? 1 : 0
            }:${entry.job.blockedReason ?? ''}:${entry.where}`,
        )
        .join(',')}`;
      if (nextQueue !== queueSignature) {
        queueSignature = nextQueue;
        renderQueue(ctx, entries);
      }
      advanceProgress(entries);
    },

    unmount(): void {
      // Drop the retained progress nodes; the next mount rebuilds them from the snapshot.
      progressNodes.clear();
      listSignature = FORCE;
      nearbySignature = FORCE;
      detailSignature = FORCE;
      queueSignature = FORCE;
    },
  };
}
