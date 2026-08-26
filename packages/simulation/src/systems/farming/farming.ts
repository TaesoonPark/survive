import {
  Rng,
  TICKS_PER_GAME_DAY,
  Tile,
  biomeProps,
  clamp,
  clamp01,
  distance,
  hashString,
  tileCenter,
  tileProps,
  type CommandOf,
  type CropSubState,
  type EntityId,
  type EquipSlot,
  type ItemStack,
  type PlayerState,
  type PlotSubState,
  type Season,
  type StructureState,
} from '@survive/protocol';
import type { CropDef, GameData, ItemDef } from '@survive/game-data';
import { SystemOrder, type CommandRouter, type SimContext, type System } from '../../core/context';
import {
  addToInventory,
  createStack,
  findTool,
  recomputeCarryWeight,
  removeFromInventory,
  spendDurability,
} from '../../core/items';
import { dropStack } from '../../core/loot';
import { emitNoise } from '../../core/noise';
import { bump, markDirtyAt, markStructureDirty, structureAtTile } from '../../core/queries';
import { grantXp, skillLevel } from '../../core/skills';
import { spawnStructure } from '../../core/structures';
import {
  BLIGHT_CONTAGIOUS_AT,
  BLIGHT_HEALTH_PER_TICK,
  BLIGHT_PROGRESS_PER_TICK,
  BLIGHT_SEED_LEVEL,
  BLIGHT_SPREAD_PER_TICK,
  DROUGHT_HEALTH_PER_TICK,
  HEALTH_RECOVERY_PER_TICK,
  blightRiskMultiplier,
  evaporationRate,
  growthMultiplier,
  harvestYieldMultiplier,
  isFrostKilling,
  matureStage,
  plotRetention,
  plotTileFor,
  rainfallRate,
  regrowthStage,
  stageTicks,
  withinIdealTemperature,
} from './crops';

/**
 * Farming: the one loop in the game that pays you back for staying put.
 *
 * A crop lives inside a *structure*, not in a table of its own: a farm plot is a
 * `StructureState` carrying a {@link PlotSubState}, and the crop is that plot's
 * contents. That is why tilling spawns a structure rather than only painting a tile -
 * it buys the whole existing machinery (tile index, collision, chunk persistence,
 * area-of-interest replication, damage) for free, and it means a plot survives a
 * save/load without a single line of bespoke serialization.
 *
 * The system does two jobs:
 *
 * - **Commands.** Six `farm` actions, each validated against the world rather than
 *   trusted: reach, tool in hand, plot state, season, seed on hand, cooldown. A client
 *   that lies gets a `commandRejected` with a reason a UI can print.
 * - **Per tick.** Moisture, growth, health and blight, for every plot in the world.
 *   Plots are *staggered* across {@link FARM_TICK_STRIDE} ticks by a hash of their id,
 *   so a hundred-plot farm costs five plots of work per tick instead of a hundred. Each
 *   visited plot integrates a whole stride worth of change, which is why every rate in
 *   `./crops` is expressed per tick.
 *
 * Animals eating crops is deliberately out of scope, and so are greenhouses: a crop
 * planted out of season is rejected outright rather than planted and stalled.
 */

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * How far a player can reach to work a plot, in pixels.
 *
 * Two tiles plus a little: enough to stand next to a plot and hoe it, not enough to
 * farm a field from across the fence.
 */
export const FARM_REACH = 72;

/**
 * Ticks between farm actions. Stops a scripted client from harvesting a field instantly.
 *
 * Held in the player's shared `useReadyTick` rather than a farming-only field, because
 * that is what it is: one pair of hands. A player who has just swung a hoe cannot
 * simultaneously open a door, and the client already animates off that timer.
 */
export const FARM_ACTION_TICKS = 6;

/**
 * Plots are visited once every this many ticks.
 *
 * One second of wall time, one in-game minute. A plot's bucket is
 * `hashString(id) % FARM_TICK_STRIDE`, which is stable for the life of the structure,
 * so the interval between visits is exactly the stride and the growth integration needs
 * no per-plot timestamp (there is nowhere in `PlotSubState` to keep one).
 */
export const FARM_TICK_STRIDE = 20;

/**
 * How often the cached list of plot ids is rebuilt, in ticks.
 *
 * The cache exists so the per-tick pass does not walk the whole structure table looking
 * for plots. It is pure derived data - never persisted, never replicated.
 *
 * The schedule is anchored to the *world clock* (`tick % PLOT_INDEX_REFRESH_TICKS`), not
 * to how long it has been since the last rebuild, and that distinction is the whole point
 * of the constant. An elapsed-time schedule takes its phase from whenever the system
 * object happened to be constructed, so a world resumed from a save rebuilds on a
 * different set of ticks than the run that saved it - and every later plot built through
 * the build menu is then noticed a different number of ticks late in each run, which is a
 * permanent replay divergence rather than a transient one. Anchoring to the tick makes the
 * rebuild ticks a function of world state, so both runs agree from the first boundary on.
 *
 * Farming's own commands invalidate the cache immediately; a plot placed by another system
 * (a `farm_plot_kit` through the build menu) is picked up at the next boundary.
 */
export const PLOT_INDEX_REFRESH_TICKS = 100;

/** Moisture points one unit of water from a can or vessel delivers. */
export const MOISTURE_PER_FILL_UNIT = 30;

/** Fertility points a full in-game day's worth of fertilizer restores. */
export const FERTILITY_PER_BOOST_DAY = 50;

/** Ceiling on stored fertilizer, so a stack of compost cannot bank a week of growth. */
export const MAX_FERTILIZED_TICKS = TICKS_PER_GAME_DAY * 2;

/** Plant fibre returned by clearing a plot, by whether the crop had grown at all. */
export const CLEAR_FIBER_MIN = 1;
export const CLEAR_FIBER_MAX = 3;

/** Audible radius of hoeing, in pixels. Quiet work, but not silent. */
export const TILL_NOISE_RADIUS = 130;

const XP_TILL = 3;
const XP_PLANT = 2;
const XP_WATER = 1;
const XP_FERTILIZE = 3;
const XP_CLEAR = 1;

/** Neighbours blight can jump to, in a fixed order so spread is deterministic. */
const CARDINAL_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/** Slots checked before the backpack when looking for a can or a bag of compost. */
const HAND_SLOTS: readonly EquipSlot[] = ['mainHand', 'offHand'];

// ---------------------------------------------------------------------------
// Small shared shapes
// ---------------------------------------------------------------------------

/** Where an item was found on a player. Mirrors what `findTool` returns. */
type ItemLocation =
  | { stack: ItemStack; where: 'equipment'; slot: EquipSlot }
  | { stack: ItemStack; where: 'inventory'; index: number };

/** A plot and the structure that owns it, resolved together. */
export interface PlotRef {
  structure: StructureState;
  plot: PlotSubState;
  /** Fertility this plot type is designed to sit at (100 dug, 130 composted planter). */
  nominalFertility: number;
}

// ---------------------------------------------------------------------------
// The system
// ---------------------------------------------------------------------------

export function createFarmingSystem(): System {
  /**
   * Cached plot ids, sorted so iteration order never depends on insertion order
   * (determinism rule). Rebuilt on a tick schedule and whenever this system creates or
   * empties a plot itself.
   */
  let plotIds: EntityId[] = [];
  let plotIndexTick = -1;

  const invalidate = (): void => {
    plotIndexTick = -1;
  };

  function refreshPlotIndex(ctx: SimContext): void {
    // `plotIndexTick < 0` is "never built, or invalidated by a command" and rebuilds at
    // once; otherwise the boundary is a property of the world clock. See
    // {@link PLOT_INDEX_REFRESH_TICKS} for why that is not the same as elapsed time.
    if (plotIndexTick >= 0 && ctx.state.tick % PLOT_INDEX_REFRESH_TICKS !== 0) return;
    plotIndexTick = ctx.state.tick;
    const ids: EntityId[] = [];
    for (const id of Object.keys(ctx.state.structures)) {
      if (ctx.state.structures[id]?.plot) ids.push(id);
    }
    plotIds = ids.sort();
  }

  return {
    id: 'farming',
    order: SystemOrder.Farming,

    init(_ctx: SimContext, router: CommandRouter): void {
      router.on('farm', (ctx, player, command) => {
        handleFarm(ctx, player, command, invalidate);
      });
    },

    update(ctx: SimContext): void {
      refreshPlotIndex(ctx);
      if (plotIds.length === 0) return;

      const phase = ctx.state.tick % FARM_TICK_STRIDE;
      for (const id of plotIds) {
        if (plotBucket(id) !== phase) continue;
        const structure = ctx.state.structures[id];
        if (!structure?.plot) continue;
        stepPlot(ctx, structure, structure.plot, FARM_TICK_STRIDE, plotRng(ctx, id));
      }
    },

    onChunkLoaded(): void {
      // A loaded chunk can bring plots with it.
      invalidate();
    },

    onChunkUnload(): void {
      invalidate();
    },
  };
}

/** Which of the {@link FARM_TICK_STRIDE} phases a plot is simulated on. */
export function plotBucket(structureId: EntityId): number {
  return hashString(structureId) % FARM_TICK_STRIDE;
}

/**
 * The random stream for one plot's tick.
 *
 * Deliberately *not* `ctx.rng.fork(...)`, for the same reason `craftUnitRng` is not - and
 * here the reason has teeth, because a plot is simulated for weeks rather than for the
 * few seconds a craft takes.
 *
 * Two things go wrong with a fork. A stream shared across the plots visited this tick
 * makes each plot's blight roll depend on *how many other plots exist*, so a stranger's
 * field on the far side of the map decides whether your wheat catches blight - measured,
 * before this was a seeded stream, as an onset eleven times earlier with forty unrelated
 * plots in the world. And because forking advances the master generator, whether that
 * advance happens at all would depend on plot-index membership: a plot placed through the
 * build menu enters the cache up to {@link PLOT_INDEX_REFRESH_TICKS} later than it would
 * after a save and reload, which is enough to shift every *other* system's rolls off the
 * saved timeline.
 *
 * Seeding from replicated state fixes both. A plot's rolls become a pure function of
 * which world, which plot and which tick: unchanged by its neighbours, by index staleness,
 * by iteration order, by a save/load in the middle, and incapable of perturbing anything
 * else in return.
 */
export function plotRng(ctx: SimContext, structureId: EntityId): Rng {
  return new Rng(`farm:plot:${ctx.state.seed}:${structureId}:${ctx.state.tick}`);
}

/**
 * The random stream for one harvest.
 *
 * State-seeded for the reasons in {@link plotRng}: two players picking their own crops on
 * the same tick must not shift each other's yields, and a harvest must roll the same
 * whether or not something else drew from the world's randomness that tick. The player id
 * is in the mix because the plot and tick alone cannot separate two people reaching for
 * the same plant, and `harvestsLeft` separates the successive pickings of a ratoon crop.
 */
export function harvestRng(
  ctx: SimContext,
  structure: StructureState,
  player: PlayerState,
  harvestsLeft: number,
): Rng {
  return new Rng(
    `farm:harvest:${ctx.state.seed}:${structure.id}:${player.id}:${ctx.state.tick}:${harvestsLeft}`,
  );
}

/**
 * Whether a hoe can break this terrain into a seed bed.
 *
 * `TileProps.tillable` is the content answer, and it is deliberately `false` for
 * farmland - a tile that is *already* soil has nothing left to break. But a farm plot is
 * a structure, and a structure can be burned down or chewed through by a zombie, which
 * leaves the farmland tile behind with nothing on it. Without this second clause that
 * square would be dead ground forever: too worked to till, with no plot to plant in.
 * Re-hoeing it is the repair.
 */
export function canBeTilled(tile: number): boolean {
  return tileProps(tile).tillable || tile === Tile.FarmlandDry || tile === Tile.FarmlandWet;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function handleFarm(
  ctx: SimContext,
  player: PlayerState,
  command: CommandOf<'farm'>,
  invalidate: () => void,
): void {
  if (!player.alive) return reject(ctx, player, 'you are dead');
  if (!Number.isInteger(command.tileX) || !Number.isInteger(command.tileY)) {
    return reject(ctx, player, 'bad target tile');
  }
  if (ctx.state.tick < player.useReadyTick) return reject(ctx, player, 'still busy');

  const { tileX, tileY } = command;
  const reach = distance(player.x, player.y, tileCenter(tileX), tileCenter(tileY));
  if (reach > FARM_REACH) return reject(ctx, player, 'too far away');

  switch (command.action) {
    case 'till':
      return till(ctx, player, tileX, tileY, invalidate);
    case 'plant':
      return plant(ctx, player, tileX, tileY, command.seedDefId);
    case 'water':
      return water(ctx, player, tileX, tileY);
    case 'fertilize':
      return fertilize(ctx, player, tileX, tileY);
    case 'harvest':
      return harvest(ctx, player, tileX, tileY, invalidate);
    case 'clear':
      return clearPlot(ctx, player, tileX, tileY, invalidate);
    default:
      return reject(ctx, player, 'unknown farm action');
  }
}

/**
 * Break sod into a seed bed.
 *
 * Two paths. Ground with no structure on it becomes a `farm_plot` over a
 * {@link Tile.FarmlandDry} tile - and per {@link canBeTilled} that includes orphaned
 * farmland left behind by a plot something destroyed, which is how a wrecked field gets
 * repaired. An existing planter that has somehow been left untilled (an old save, or a
 * frame that was never finished) is simply marked tilled instead. Anything else is
 * refused rather than quietly overwritten - a hoe must not be able to delete a chest.
 */
function till(
  ctx: SimContext,
  player: PlayerState,
  tileX: number,
  tileY: number,
  invalidate: () => void,
): void {
  const tool = findTool(player, 'hoe', ctx.data);
  if (!tool) return reject(ctx, player, 'you need a hoe');

  const existing = structureAtTile(ctx.state, tileX, tileY);
  if (existing) {
    if (!existing.plot) return reject(ctx, player, 'something is already built here');
    if (existing.plot.tilled) return reject(ctx, player, 'already tilled');
    existing.plot.tilled = true;
    finishTill(ctx, player, existing, tool, invalidate);
    return;
  }

  if (ctx.world.isSolidTile(tileX, tileY)) return reject(ctx, player, 'the ground is blocked');
  const previousTile = ctx.world.getTile(tileX, tileY);
  if (!canBeTilled(previousTile)) {
    return reject(ctx, player, 'this ground cannot be tilled');
  }

  ctx.world.setTile(tileX, tileY, Tile.FarmlandDry);
  markDirtyAt(ctx.state, tileCenter(tileX), tileCenter(tileY));

  const structure = spawnStructure(ctx, 'farm_plot', tileX, tileY, 0, player.id);
  if (!structure?.plot) {
    // The plot definition is missing from the tables. Put the ground back exactly as it
    // was rather than leaving farmland nobody can plant in - restoring the tile the
    // player actually dug, not a guess at grass, so hoeing a dirt path and failing does
    // not turn the path into a lawn.
    ctx.world.setTile(tileX, tileY, previousTile);
    return reject(ctx, player, 'farm plots are unavailable');
  }
  ctx.events.emit({
    type: 'structurePlaced',
    structureId: structure.id,
    defId: structure.defId,
    tileX,
    tileY,
    builderId: player.id,
  });
  finishTill(ctx, player, structure, tool, invalidate);
}

function finishTill(
  ctx: SimContext,
  player: PlayerState,
  structure: StructureState,
  tool: ItemLocation,
  invalidate: () => void,
): void {
  wearTool(ctx, player, tool, toolWear(ctx.data, tool.stack));
  syncFarmlandTile(ctx, structure, structure.plot);
  bump(structure);
  markStructureDirty(ctx.state, structure);
  invalidate();

  ctx.events.emit({
    type: 'plotTilled',
    structureId: structure.id,
    tileX: structure.tileX,
    tileY: structure.tileY,
  });
  emitNoise(
    ctx,
    tileCenter(structure.tileX),
    tileCenter(structure.tileY),
    TILL_NOISE_RADIUS,
    0.6,
    player.id,
  );
  grantXp(ctx, player, 'farming', XP_TILL);
  startCooldown(ctx, player);
}

/**
 * Sow a seed.
 *
 * The seed id may be omitted, in which case the player's own stock is searched - which
 * is what lets a client bind "plant" to a bare keypress rather than to a hotbar slot.
 * Season is a hard gate: greenhouses are out of scope, so a summer crop in winter is
 * refused with a reason instead of being planted into a permanent stall.
 */
function plant(
  ctx: SimContext,
  player: PlayerState,
  tileX: number,
  tileY: number,
  requestedSeed: string | undefined,
): void {
  const ref = plotAt(ctx, tileX, tileY);
  if (!ref) return reject(ctx, player, 'there is no plot here');
  if (!ref.plot.tilled) return reject(ctx, player, 'the ground is not tilled');
  if (ref.plot.crop) {
    // A dead crop blocks the plot exactly as a living one does, but the player's way out
    // is `clear`, not waiting - so say so rather than reporting that something is growing
    // in a square full of dead stalks.
    return reject(
      ctx,
      player,
      ref.plot.crop.dead
        ? 'a dead crop is in the way - clear it first'
        : 'something is already growing here',
    );
  }

  const seedDefId = requestedSeed ?? findSeed(player, ctx.data, ctx.state.time.season)?.stack.defId;
  if (!seedDefId) return reject(ctx, player, 'no seed selected');

  const seedDef = ctx.data.items.get(seedDefId);
  if (!seedDef) return reject(ctx, player, 'unknown seed');
  const cropDef = seedDef.cropDefId ? ctx.data.crops.get(seedDef.cropDefId) : undefined;
  if (!cropDef) return reject(ctx, player, `${seedDef.name} is not a seed`);

  if (!cropDef.seasons.includes(ctx.state.time.season)) {
    return reject(
      ctx,
      player,
      `${cropDef.name} will not grow in ${ctx.state.time.season} (needs ${cropDef.seasons.join(', ')})`,
    );
  }

  if (removeFromInventory(player.inventory, seedDefId, 1) !== 1) {
    return reject(ctx, player, `you have no ${seedDef.name}`);
  }
  recomputeCarryWeight(player, ctx.data);
  bump(player);

  ref.plot.crop = {
    defId: cropDef.id,
    plantedTick: ctx.state.tick,
    stage: 0,
    stageProgress: 0,
    water: ref.plot.moisture,
    health: 100,
    blight: 0,
    fertilizedTicks: 0,
    harvestsLeft: Math.max(1, Math.floor(cropDef.harvestsPerPlant)),
    dead: false,
  };
  bump(ref.structure);
  markStructureDirty(ctx.state, ref.structure);

  ctx.events.emit({
    type: 'cropPlanted',
    structureId: ref.structure.id,
    cropDefId: cropDef.id,
  });
  grantXp(ctx, player, 'farming', XP_PLANT);
  startCooldown(ctx, player);
}

/**
 * Water a plot.
 *
 * A watering can is preferred over a canteen so a player does not empty their drinking
 * water onto the beans by accident, but any fillable vessel holding water works - which
 * is what makes a bucket a bucket without the item table needing to name one. One unit
 * of fill delivers {@link MOISTURE_PER_FILL_UNIT} points.
 */
function water(ctx: SimContext, player: PlayerState, tileX: number, tileY: number): void {
  const ref = plotAt(ctx, tileX, tileY);
  if (!ref) return reject(ctx, player, 'there is no plot here');
  if (ref.plot.moisture >= 100) return reject(ctx, player, 'the soil is already soaked');

  const vessel = findWaterVessel(player, ctx.data);
  if (!vessel) return reject(ctx, player, 'you need a watering can or a full vessel');

  vessel.stack.fill = Math.max(0, (vessel.stack.fill ?? 0) - 1);
  const vesselDef = ctx.data.items.get(vessel.stack.defId);
  if (vesselDef?.tool) wearTool(ctx, player, vessel, toolWear(ctx.data, vessel.stack));
  else bump(player);

  ref.plot.moisture = clamp(ref.plot.moisture + MOISTURE_PER_FILL_UNIT, 0, 100);
  if (ref.plot.crop) ref.plot.crop.water = ref.plot.moisture;
  syncFarmlandTile(ctx, ref.structure, ref.plot);
  bump(ref.structure);
  markStructureDirty(ctx.state, ref.structure);

  ctx.events.emit({
    type: 'cropWatered',
    structureId: ref.structure.id,
    moisture: ref.plot.moisture,
  });
  grantXp(ctx, player, 'farming', XP_WATER);
  startCooldown(ctx, player);
}

/**
 * Work fertilizer or compost into a plot.
 *
 * It does two separate things, which is why it is worth doing on an empty plot as well
 * as a planted one: it puts fertility back (the number harvests eat, and the number
 * blight risk reads), and it gives the standing crop a burst of growth for
 * `ItemDef.fertilizerTicks`.
 */
function fertilize(ctx: SimContext, player: PlayerState, tileX: number, tileY: number): void {
  const ref = plotAt(ctx, tileX, tileY);
  if (!ref) return reject(ctx, player, 'there is no plot here');

  const crop = ref.plot.crop;
  const soilFull = ref.plot.fertility >= ref.nominalFertility;
  // A dead crop counts as nothing to feed: the boost below refuses to touch one, so
  // without `crop.dead` here a plot at full fertility holding dead stalks passed this
  // guard, consumed the fertilizer and changed nothing - repeatably, forever.
  const cropFull = !crop || crop.dead || crop.fertilizedTicks >= MAX_FERTILIZED_TICKS;
  if (soilFull && cropFull) return reject(ctx, player, 'this soil needs nothing');

  const found = findFertilizer(player, ctx.data);
  if (!found) return reject(ctx, player, 'you have no fertilizer');
  const def = ctx.data.items.get(found.stack.defId);
  const boostTicks = Math.max(0, def?.fertilizerTicks ?? 0);

  consumeOne(ctx, player, found);

  ref.plot.fertility = clamp(
    ref.plot.fertility + (FERTILITY_PER_BOOST_DAY * boostTicks) / TICKS_PER_GAME_DAY,
    0,
    ref.nominalFertility,
  );
  if (crop && !crop.dead) {
    crop.fertilizedTicks = Math.min(crop.fertilizedTicks + boostTicks, MAX_FERTILIZED_TICKS);
  }
  bump(ref.structure);
  markStructureDirty(ctx.state, ref.structure);

  ctx.events.emit({ type: 'cropFertilized', structureId: ref.structure.id });
  grantXp(ctx, player, 'farming', XP_FERTILIZE);
  startCooldown(ctx, player);
}

/**
 * Pick a mature crop.
 *
 * The roll is `yieldMin..yieldMax` scaled by plant health, soil fertility and the
 * farming skill, so the same seed is worth two potatoes to someone who planted and
 * forgot and six to someone who watered it. Harvesting is also the only thing that
 * *takes* fertility, which is what turns "plant the same square forever" into a slowly
 * failing plot rather than a free lunch.
 */
function harvest(
  ctx: SimContext,
  player: PlayerState,
  tileX: number,
  tileY: number,
  invalidate: () => void,
): void {
  const ref = plotAt(ctx, tileX, tileY);
  if (!ref) return reject(ctx, player, 'there is no plot here');
  const crop = ref.plot.crop;
  if (!crop) return reject(ctx, player, 'nothing is growing here');
  if (crop.dead) return reject(ctx, player, 'the crop is dead - clear it instead');

  const def = ctx.data.crops.get(crop.defId);
  if (!def) return reject(ctx, player, 'unknown crop');
  if (crop.stage < matureStage(def)) return reject(ctx, player, 'it is not ready yet');
  if (crop.harvestsLeft <= 0) return reject(ctx, player, 'this plant is spent');

  const rng = harvestRng(ctx, ref.structure, player, crop.harvestsLeft);
  const rolled = rng.int(def.yieldMin, def.yieldMax);
  const multiplier = harvestYieldMultiplier(
    crop,
    ref.plot,
    ref.nominalFertility,
    skillLevel(player, 'farming'),
  );
  const produceCount = Math.max(1, Math.round(rolled * multiplier));
  const seedCount = rng.int(
    Math.max(0, def.seedYield[0]),
    Math.max(def.seedYield[0], def.seedYield[1]),
  );

  const yields: ItemStack[] = [];
  yields.push(giveOrDrop(ctx, player, def.produceDefId, produceCount));
  if (seedCount > 0) yields.push(giveOrDrop(ctx, player, def.seedDefId, seedCount));

  ref.plot.fertility = clamp(
    ref.plot.fertility - Math.max(0, def.fertilityCost),
    0,
    ref.nominalFertility,
  );

  // Ratoon crops keep the plant and fall back a stage; everything else is pulled up.
  if (def.regrows) {
    crop.harvestsLeft -= 1;
    if (crop.harvestsLeft > 0) {
      crop.stage = regrowthStage(def);
      crop.stageProgress = 0;
    } else {
      delete ref.plot.crop;
    }
  } else {
    delete ref.plot.crop;
  }

  bump(ref.structure);
  markStructureDirty(ctx.state, ref.structure);
  invalidate();

  player.stats.cropsHarvested += 1;
  bump(player);

  ctx.events.emit({
    type: 'cropHarvested',
    structureId: ref.structure.id,
    playerId: player.id,
    yields,
  });
  grantXp(ctx, player, 'farming', def.xpPerHarvest);
  startCooldown(ctx, player);
}

/**
 * Pull up a dead or unwanted crop.
 *
 * Always returns a little plant fibre - a failed crop is still a pile of dry stalks,
 * and getting *something* back is what stops a blighted plot from feeling like a
 * dead end you never touch again.
 */
function clearPlot(
  ctx: SimContext,
  player: PlayerState,
  tileX: number,
  tileY: number,
  invalidate: () => void,
): void {
  const ref = plotAt(ctx, tileX, tileY);
  if (!ref) return reject(ctx, player, 'there is no plot here');
  const crop = ref.plot.crop;
  if (!crop) return reject(ctx, player, 'nothing to clear');

  const def = ctx.data.crops.get(crop.defId);
  const grown = def ? clamp01(crop.stage / Math.max(1, matureStage(def))) : 0;
  const fiber = Math.max(
    CLEAR_FIBER_MIN,
    Math.round(CLEAR_FIBER_MIN + grown * (CLEAR_FIBER_MAX - CLEAR_FIBER_MIN)),
  );

  delete ref.plot.crop;
  bump(ref.structure);
  markStructureDirty(ctx.state, ref.structure);
  invalidate();

  giveOrDrop(ctx, player, 'plant_fiber', fiber);
  ctx.events.emit({
    type: 'notification',
    playerId: player.id,
    severity: 'info',
    // Two codes rather than one with an optional blank: a language that puts the crop
    // first cannot build the second sentence out of the first.
    message: def
      ? { code: 'notify.plotClearedOf', params: { crop: def.name } }
      : { code: 'notify.plotCleared' },
  });
  grantXp(ctx, player, 'farming', XP_CLEAR);
  startCooldown(ctx, player);
}

// ---------------------------------------------------------------------------
// Per-tick simulation
// ---------------------------------------------------------------------------

/**
 * Advance one plot by `dt` ticks.
 *
 * Order matters: moisture first (growth and health both read it), then the crop, then
 * one revision bump if anything a client can see actually moved. Bumping only on a
 * visible change keeps a field of plots from saturating the snapshot stream with
 * fourth-decimal moisture drift.
 */
function stepPlot(
  ctx: SimContext,
  structure: StructureState,
  plot: PlotSubState,
  dt: number,
  rng: Rng,
): void {
  const structureDef = ctx.data.structures.get(structure.defId);
  const nominalFertility = structureDef?.plot?.fertility ?? 100;
  const retention = plotRetention(structureDef?.plot?.moisture ?? 40);

  const before = plotSignature(plot);

  const crop = plot.crop;
  let cropDef: CropDef | undefined;
  if (crop) {
    cropDef = ctx.data.crops.get(crop.defId);
    if (!cropDef) {
      // Content was removed from under a save. Drop the crop rather than simulating a
      // plant with no definition, which is the only way this could produce NaN.
      ctx.log.warn('farming: plot holds an unknown crop', {
        structureId: structure.id,
        cropDefId: crop.defId,
      });
      delete plot.crop;
    }
  }

  const light = clamp01(ctx.state.time.lightLevel);
  const temperature = plotTemperature(ctx, structure);
  const rain = rainfallRate(ctx.state.weather);
  const evaporation = evaporationRate(ctx.state.weather, light, retention);
  const draw = plot.crop && cropDef && !plot.crop.dead ? Math.max(0, cropDef.waterPerTick) : 0;

  plot.moisture = clamp(plot.moisture + (rain - evaporation - draw) * dt, 0, 100);
  syncFarmlandTile(ctx, structure, plot);

  const living = plot.crop;
  if (living && cropDef) {
    stepCrop(ctx, structure, plot, living, cropDef, dt, rng, temperature, light, nominalFertility);
  }

  sanitizePlot(plot, nominalFertility, cropDef);

  if (plotSignature(plot) !== before) {
    bump(structure);
    markStructureDirty(ctx.state, structure);
  }
}

function stepCrop(
  ctx: SimContext,
  structure: StructureState,
  plot: PlotSubState,
  crop: CropSubState,
  def: CropDef,
  dt: number,
  rng: Rng,
  temperature: number,
  lightLevel: number,
  nominalFertility: number,
): void {
  crop.water = plot.moisture;
  if (crop.dead) return;

  // Frost is not a health drain, it is an event: a tomato that sees -1 degrees is
  // finished, however healthy it was the tick before.
  if (isFrostKilling(def, temperature)) {
    killCrop(ctx, structure, crop, 'frost');
    return;
  }

  if (crop.fertilizedTicks > 0) crop.fertilizedTicks = Math.max(0, crop.fertilizedTicks - dt);

  stepBlight(ctx, structure, plot, crop, def, dt, rng, nominalFertility);

  const dry = plot.moisture < def.minMoisture;
  let health = crop.health;
  if (dry) {
    const severity = clamp01((def.minMoisture - plot.moisture) / Math.max(1, def.minMoisture));
    health -= DROUGHT_HEALTH_PER_TICK * (0.35 + 0.65 * severity) * dt;
  }
  if (crop.blight > 0) health -= BLIGHT_HEALTH_PER_TICK * clamp01(crop.blight / 100) * dt;
  if (!dry && crop.blight <= 0 && withinIdealTemperature(def, temperature)) {
    health += HEALTH_RECOVERY_PER_TICK * dt;
  }
  crop.health = clamp(health, 0, 100);
  if (crop.health <= 0) {
    killCrop(ctx, structure, crop, crop.blight >= 30 ? 'blight' : 'drought');
    return;
  }

  const mature = matureStage(def);
  if (crop.stage >= mature) return;

  const rate = growthMultiplier(def, {
    moisture: plot.moisture,
    fertility: plot.fertility,
    nominalFertility,
    temperature,
    season: ctx.state.time.season,
    lightLevel,
    fertilized: crop.fertilizedTicks > 0,
    growthRateTuning: ctx.config.tuning.cropGrowthRate,
  });
  if (rate <= 0) return;

  let stage = crop.stage;
  let progress = crop.stageProgress + (dt * rate) / Math.max(1, stageTicks(def, stage));
  while (progress >= 1 && stage < mature) {
    // Carry the overflow across in *ticks*, not in fractions: stages have different
    // lengths, so 1.4 of a one-day stage is not 0.4 of a two-day one.
    const overflowTicks = (progress - 1) * Math.max(1, stageTicks(def, stage));
    stage += 1;
    ctx.events.emit({ type: 'cropStageAdvanced', structureId: structure.id, stage });
    if (stage >= mature) {
      progress = 0;
      break;
    }
    progress = overflowTicks / Math.max(1, stageTicks(def, stage));
  }
  crop.stage = stage;
  crop.stageProgress = stage >= mature ? 0 : clamp01(progress);
}

/** Catch blight, worsen it, and pass it along the row. */
function stepBlight(
  ctx: SimContext,
  structure: StructureState,
  plot: PlotSubState,
  crop: CropSubState,
  def: CropDef,
  dt: number,
  rng: Rng,
  nominalFertility: number,
): void {
  if (crop.blight <= 0) {
    const chance = clamp01(
      Math.max(0, def.blightChance) * dt * blightRiskMultiplier(plot, nominalFertility),
    );
    if (chance > 0 && rng.chance(chance)) {
      crop.blight = BLIGHT_SEED_LEVEL;
      ctx.events.emit({ type: 'cropBlighted', structureId: structure.id });
    }
    return;
  }

  crop.blight = clamp(crop.blight + BLIGHT_PROGRESS_PER_TICK * dt, 0, 100);
  if (crop.blight < BLIGHT_CONTAGIOUS_AT) return;
  const spread = clamp01(BLIGHT_SPREAD_PER_TICK * dt * clamp01(crop.blight / 100));
  if (spread > 0 && rng.chance(spread)) infectNeighbour(ctx, structure);
}

/** Infect the first healthy adjacent plot, in a fixed compass order. */
function infectNeighbour(ctx: SimContext, source: StructureState): void {
  for (const [dx, dy] of CARDINAL_OFFSETS) {
    const neighbour = structureAtTile(ctx.state, source.tileX + dx, source.tileY + dy);
    const crop = neighbour?.plot?.crop;
    if (!neighbour || !crop) continue;
    if (crop.dead || crop.blight >= BLIGHT_SEED_LEVEL) continue;
    crop.blight = BLIGHT_SEED_LEVEL;
    bump(neighbour);
    markStructureDirty(ctx.state, neighbour);
    ctx.events.emit({ type: 'cropBlighted', structureId: neighbour.id });
    return;
  }
}

function killCrop(
  ctx: SimContext,
  structure: StructureState,
  crop: CropSubState,
  reason: string,
): void {
  crop.dead = true;
  crop.health = 0;
  crop.stageProgress = 0;
  ctx.events.emit({ type: 'cropDied', structureId: structure.id, reason });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the plot at a tile, with the fertility its definition is scaled against. */
export function plotAt(ctx: SimContext, tileX: number, tileY: number): PlotRef | null {
  const structure = structureAtTile(ctx.state, tileX, tileY);
  if (!structure?.plot) return null;
  const def = ctx.data.structures.get(structure.defId);
  return {
    structure,
    plot: structure.plot,
    nominalFertility: def?.plot?.fertility ?? 100,
  };
}

/**
 * Air temperature at a plot.
 *
 * Weather carries one world temperature; the biome offset is what makes a plot in the
 * deep forest two degrees colder than the same plot in a field, which is enough to
 * change whether a frost-tender crop survives the night.
 */
export function plotTemperature(ctx: SimContext, structure: StructureState): number {
  const biome = biomeProps(ctx.world.getBiome(structure.tileX, structure.tileY));
  return ctx.state.weather.temperature + biome.temperatureOffset;
}

/**
 * Keep the terrain tile in step with the soil's moisture.
 *
 * Only tiles that are already farmland are repainted: a planter box sits on whatever
 * the ground happens to be, and turning the floorboards under it into wet soil would be
 * a bug, not a feature.
 */
function syncFarmlandTile(ctx: SimContext, structure: StructureState, plot?: PlotSubState): void {
  if (!plot) return;
  const current = ctx.world.getTile(structure.tileX, structure.tileY);
  if (current !== Tile.FarmlandDry && current !== Tile.FarmlandWet) return;
  const wanted = plotTileFor(plot);
  if (current === wanted) return;
  ctx.world.setTile(structure.tileX, structure.tileY, wanted);
  markDirtyAt(ctx.state, tileCenter(structure.tileX), tileCenter(structure.tileY));
}

/**
 * A cheap string of everything about a plot a client can see.
 *
 * Deliberately rounded: it is the "did anything visible change" test that decides
 * whether to spend a revision bump, and fourth-decimal moisture drift is not a change.
 */
function plotSignature(plot: PlotSubState): string {
  const crop = plot.crop;
  const soil = `${plot.tilled ? 1 : 0}|${plot.moisture.toFixed(1)}|${plot.fertility.toFixed(1)}`;
  if (!crop) return `${soil}|-`;
  return [
    soil,
    crop.defId,
    crop.stage,
    crop.stageProgress.toFixed(3),
    crop.health.toFixed(1),
    crop.blight.toFixed(1),
    crop.fertilizedTicks,
    crop.harvestsLeft,
    crop.dead ? 1 : 0,
  ].join('|');
}

/**
 * Clamp every number on a plot into its documented range.
 *
 * The growth maths is written to be finite, but a plot can also arrive from a save file,
 * a mod table or a debug command, and one `NaN` in `moisture` would silently poison
 * growth, health and blight forever after. This is the backstop that guarantees a plot
 * left alone for a month still holds numbers.
 */
export function sanitizePlot(
  plot: PlotSubState,
  nominalFertility: number,
  cropDef?: CropDef,
): void {
  plot.tilled = plot.tilled === true;
  plot.moisture = finite(plot.moisture, 0, 0, 100, 3);
  plot.fertility = finite(plot.fertility, 0, 0, Math.max(100, nominalFertility), 3);

  const crop = plot.crop;
  if (!crop) return;
  const maxStage = cropDef ? matureStage(cropDef) : 32;
  crop.stage = Number.isFinite(crop.stage) ? clamp(Math.floor(crop.stage), 0, maxStage) : 0;
  crop.stageProgress = finite(crop.stageProgress, 0, 0, 1, 5);
  crop.water = finite(crop.water, 0, 0, 100, 3);
  crop.health = finite(crop.health, 0, 0, 100, 3);
  crop.blight = finite(crop.blight, 0, 0, 100, 3);
  crop.fertilizedTicks = finite(crop.fertilizedTicks, 0, 0, MAX_FERTILIZED_TICKS, 0);
  crop.harvestsLeft = finite(crop.harvestsLeft, 0, 0, 64, 0);
  crop.plantedTick = Number.isFinite(crop.plantedTick) ? crop.plantedTick : 0;
  crop.dead = crop.dead === true;
}

/** Clamp, round and guarantee finiteness in one step. */
function finite(value: number, fallback: number, min: number, max: number, places: number): number {
  if (!Number.isFinite(value)) return fallback;
  const scale = 10 ** places;
  return Math.round(clamp(value, min, max) * scale) / scale;
}

/** Durability a tool spends on one farm action. */
function toolWear(data: GameData, stack: ItemStack): number {
  return data.items.get(stack.defId)?.tool?.durabilityPerUse ?? 1;
}

/** Spend durability, and discard the tool if this was the use that finished it. */
function wearTool(
  ctx: SimContext,
  player: PlayerState,
  location: ItemLocation,
  amount: number,
): void {
  const broke = spendDurability(location.stack, amount);
  if (broke) {
    if (location.where === 'equipment') player.equipment[location.slot] = null;
    else player.inventory.slots[location.index] = null;
    ctx.events.emit({ type: 'weaponBroke', ownerId: player.id, defId: location.stack.defId });
    recomputeCarryWeight(player, ctx.data);
  }
  bump(player);
}

/** Consume a single unit of a stack wherever it sits. */
function consumeOne(ctx: SimContext, player: PlayerState, location: ItemLocation): void {
  location.stack.count -= 1;
  if (location.stack.count <= 0) {
    if (location.where === 'equipment') player.equipment[location.slot] = null;
    else player.inventory.slots[location.index] = null;
  }
  recomputeCarryWeight(player, ctx.data);
  bump(player);
}

/**
 * Put items in the player's pack, dropping whatever will not fit at their feet.
 *
 * A full inventory must never destroy a harvest: the produce lands on the ground where
 * the player is standing instead.
 */
function giveOrDrop(ctx: SimContext, player: PlayerState, defId: string, count: number): ItemStack {
  const stack = createStack(ctx.data, defId, Math.max(1, Math.floor(count)));
  const leftover = addToInventory(player.inventory, { ...stack }, ctx.data);
  if (leftover > 0) {
    dropStack(ctx, player.x, player.y, { ...stack, count: leftover }, player.id);
  }
  recomputeCarryWeight(player, ctx.data);
  bump(player);
  return stack;
}

/** Hands first, then the pack, in slot order so the choice is deterministic. */
function findItemOn(
  player: PlayerState,
  data: GameData,
  matches: (def: ItemDef, stack: ItemStack) => boolean,
): ItemLocation | null {
  for (const slot of HAND_SLOTS) {
    const stack = player.equipment[slot];
    if (!stack) continue;
    const def = data.items.get(stack.defId);
    if (def && matches(def, stack)) return { stack, where: 'equipment', slot };
  }
  for (let index = 0; index < player.inventory.slots.length; index++) {
    const stack = player.inventory.slots[index];
    if (!stack) continue;
    const def = data.items.get(stack.defId);
    if (def && matches(def, stack)) return { stack, where: 'inventory', index };
  }
  return null;
}

/** True when a vessel's contents are water rather than fuel or something worse. */
function holdsWater(def: ItemDef, stack: ItemStack, data: GameData): boolean {
  const content = stack.contentDefId ?? def.liquid?.contentDefId;
  if (!content) return true;
  return data.items.get(content)?.tags.includes('water') === true;
}

/** A watering can with something in it, or failing that any full water vessel. */
export function findWaterVessel(player: PlayerState, data: GameData): ItemLocation | null {
  const can = findItemOn(
    player,
    data,
    (def, stack) => def.tool?.kinds.includes('wateringCan') === true && (stack.fill ?? 0) > 0,
  );
  if (can) return can;
  return findItemOn(
    player,
    data,
    (def, stack) =>
      def.liquid !== undefined && (stack.fill ?? 0) > 0 && holdsWater(def, stack, data),
  );
}

/** Any item that declares a fertilizer strength. */
export function findFertilizer(player: PlayerState, data: GameData): ItemLocation | null {
  return findItemOn(player, data, (def) => (def.fertilizerTicks ?? 0) > 0);
}

/**
 * A seed on the player, for the `plant` action with no explicit seed id.
 *
 * Seeds carry no equip slot, so "whatever is in your hand" is not a thing a seed can
 * be: the player's whole stock has to be searched instead. A seed that will actually
 * grow *now* wins over one that will not, so pressing plant in winter reaches past the
 * corn to the cabbage rather than reporting that corn is a summer crop. When nothing in
 * the pack is in season the first seed found is still returned, so the caller's season
 * check can name a real crop in its rejection instead of saying "no seed selected".
 */
export function findSeed(player: PlayerState, data: GameData, season: Season): ItemLocation | null {
  const inSeason = findItemOn(player, data, (def) => {
    const crop = def.cropDefId ? data.crops.get(def.cropDefId) : undefined;
    return crop !== undefined && crop.seasons.includes(season);
  });
  if (inSeason) return inSeason;
  return findItemOn(player, data, (def) => def.cropDefId !== undefined);
}

function startCooldown(ctx: SimContext, player: PlayerState): void {
  player.useReadyTick = ctx.state.tick + FARM_ACTION_TICKS;
  bump(player);
}

function reject(ctx: SimContext, player: PlayerState, reason: string): void {
  ctx.events.emit({ type: 'commandRejected', playerId: player.id, command: 'farm', reason });
}
