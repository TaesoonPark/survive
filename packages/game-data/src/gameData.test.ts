import { describe, expect, it } from 'vitest';
import { Biome, TICKS_PER_GAME_DAY } from '@survive/protocol';
import type {
  ItemDef,
  ItemSource,
  LootTableDef,
  ResourceNodeSource,
  StationKind,
  ToolKind,
} from './types';
import { createRegistry } from './registry';
import {
  GameDataValidationError,
  buildGameData,
  collectGameDataProblems,
  computeDataVersion,
  createGameData,
  defaultTables,
  localizeTables,
  validateGameData,
} from './gameData';

const data = createGameData();
const tables = defaultTables();
/**
 * The shipped tables with their text merged in.
 *
 * `defaultTables()` returns definitions as authored - numbers, no words - because the
 * locale supplies the text later. Anything that wants a finished `GameData` has to go
 * through the same merge `createGameData` does, or it is checking a table the game never
 * actually runs on.
 */
const localized = localizeTables(tables);

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe('createRegistry', () => {
  it('indexes definitions by id and preserves authoring order', () => {
    const registry = createRegistry([{ id: 'b' }, { id: 'a' }], 'things');
    expect(registry.size).toBe(2);
    expect(registry.ids()).toEqual(['b', 'a']);
    expect(registry.get('a')).toEqual({ id: 'a' });
    expect(registry.has('a')).toBe(true);
    expect(registry.get('nope')).toBeUndefined();
    expect(registry.has('nope')).toBe(false);
  });

  it('rejects duplicate ids rather than silently shadowing one', () => {
    expect(() => createRegistry([{ id: 'a' }, { id: 'a' }], 'things')).toThrow(
      /things: duplicate definition id\(s\): a/,
    );
  });

  it('rejects a definition with no id', () => {
    expect(() => createRegistry([{ id: '' }], 'things')).toThrow(/missing or empty id/);
  });

  it('require() names the table and suggests near misses', () => {
    let message = '';
    try {
      data.items.require('wood_logs');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('items: unknown id "wood_logs"');
    expect(message).toContain('wood_log');
  });

  it('require() returns the definition for a known id', () => {
    expect(data.items.require('stone_hatchet').name).toBe('Stone Hatchet');
  });
});

// ---------------------------------------------------------------------------
// Assembly and versioning
// ---------------------------------------------------------------------------

describe('createGameData', () => {
  it('builds every table without a validation error', () => {
    expect(() => createGameData()).not.toThrow();
  });

  it('has content in every table', () => {
    expect(data.items.size).toBeGreaterThanOrEqual(120);
    expect(data.recipes.size).toBeGreaterThanOrEqual(90);
    expect(data.structures.size).toBeGreaterThanOrEqual(45);
    expect(data.nodes.size).toBeGreaterThanOrEqual(20);
    expect(data.crops.size).toBeGreaterThanOrEqual(10);
    expect(data.zombies.size).toBeGreaterThanOrEqual(10);
    expect(data.animals.size).toBeGreaterThanOrEqual(8);
    expect(data.projectiles.size).toBeGreaterThanOrEqual(9);
    expect(data.lootTables.size).toBeGreaterThanOrEqual(20);
  });

  it('uses snake_case ids everywhere', () => {
    const pattern = /^[a-z][a-z0-9_]*$/;
    for (const id of [
      ...data.items.ids(),
      ...data.recipes.ids(),
      ...data.structures.ids(),
      ...data.nodes.ids(),
      ...data.crops.ids(),
      ...data.zombies.ids(),
      ...data.animals.ids(),
      ...data.projectiles.ids(),
      ...data.lootTables.ids(),
    ]) {
      expect(id, `bad id "${id}"`).toMatch(pattern);
    }
  });

  it('derives a stable version hash rather than a timestamp', () => {
    expect(createGameData().version).toBe(data.version);
    expect(data.version).toMatch(/^gd1-[0-9a-f]{8}-[0-9a-z]+$/);
  });

  it('changes the version when any field of any table changes', () => {
    const first = tables.items[0];
    expect(first).toBeDefined();
    const nudged = [
      { ...(first as ItemDef), weight: (first as ItemDef).weight + 1 },
      ...tables.items.slice(1),
    ];
    expect(computeDataVersion({ ...tables, items: nudged })).not.toBe(data.version);
  });

  it('is insensitive to the key order inside a definition', () => {
    const first = tables.items[0] as ItemDef;
    const reordered: ItemDef = { ...first, id: first.id, name: first.name };
    const shuffled = [reordered, ...tables.items.slice(1)];
    expect(computeDataVersion({ ...tables, items: shuffled })).toBe(data.version);
  });
});

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

describe('lookup helpers', () => {
  it('recipesForStation(undefined) returns exactly the hand-craftable recipes', () => {
    const hand = data.recipesForStation(undefined);
    expect(hand.length).toBeGreaterThan(10);
    for (const recipe of hand) expect(recipe.station).toBeUndefined();
    expect(hand.map((r) => r.id)).toContain('craft_stone_hatchet');
    expect(hand.map((r) => r.id)).not.toContain('craft_wood_plank');
  });

  it('recipesForStation returns only that station', () => {
    for (const station of ['workbench', 'furnace', 'anvil', 'loom', 'chemistry'] as StationKind[]) {
      const recipes = data.recipesForStation(station);
      expect(recipes.length, station).toBeGreaterThan(0);
      for (const recipe of recipes) expect(recipe.station).toBe(station);
    }
  });

  it('buildableStructures is sorted for display and complete', () => {
    const buildable = data.buildableStructures();
    expect(buildable.length).toBe(data.structures.size);
    for (let i = 1; i < buildable.length; i++) {
      const previous = buildable[i - 1];
      const current = buildable[i];
      expect(previous).toBeDefined();
      expect(current).toBeDefined();
      expect((current as { sortOrder: number }).sortOrder).toBeGreaterThanOrEqual(
        (previous as { sortOrder: number }).sortOrder,
      );
    }
  });

  it('itemsWithTag indexes free-form tags', () => {
    const seeds = data.itemsWithTag('seed');
    expect(seeds.length).toBe(data.crops.size);
    for (const seed of seeds) expect(seed.cropDefId).toBeDefined();
    expect(data.itemsWithTag('firearm').map((item) => item.id)).toEqual(
      expect.arrayContaining(['pistol_9mm', 'rifle_308', 'shotgun']),
    );
    expect(data.itemsWithTag('no_such_tag')).toEqual([]);
  });

  it('nodesForBiome only returns nodes that list that biome', () => {
    const rocky = data.nodesForBiome(Biome.Rocky);
    expect(rocky.map((node) => node.id)).toContain('ore_iron');
    for (const node of rocky) expect(node.spawnBiomes[Biome.Rocky]).toBeGreaterThan(0);
    const lake = data.nodesForBiome(Biome.Lake);
    expect(lake.map((node) => node.id)).toContain('water_source');
    expect(lake.map((node) => node.id)).not.toContain('ore_iron');
  });

  it('animalsForBiome only returns animals that list that biome', () => {
    expect(data.animalsForBiome(Biome.Farmland).map((a) => a.id)).toContain('cow');
    expect(data.animalsForBiome(Biome.Rocky).map((a) => a.id)).not.toContain('cow');
  });

  it('zombiesForDay gates by day count and by night', () => {
    const dayOne = data.zombiesForDay(1, false).map((z) => z.id);
    expect(dayOne).toContain('walker');
    expect(dayOne).not.toContain('brute');
    expect(dayOne).not.toContain('feral_dog_zombie');

    // Night-only types appear at night once their minDay has passed, and not before.
    expect(data.zombiesForDay(2, true).map((z) => z.id)).not.toContain('feral_dog_zombie');
    expect(data.zombiesForDay(3, true).map((z) => z.id)).toContain('feral_dog_zombie');
    expect(data.zombiesForDay(3, false).map((z) => z.id)).not.toContain('feral_dog_zombie');

    const lateNight = data.zombiesForDay(30, true);
    expect(lateNight.length).toBe(data.zombies.size);
  });

  it('zombiesForDay is indexed, not recomputed, and matches a naive filter', () => {
    // The spawn system calls this every spawn tick, so it returns a shared frozen list
    // rather than a fresh array. That optimisation has to be exactly equivalent to the
    // obvious filter, at every day boundary and on both sides of it.
    for (let day = 0; day <= 40; day++) {
      for (const night of [false, true]) {
        const expected = data.zombies
          .all()
          .filter((def) => def.minDay <= day && (!def.nightOnly || night) && def.spawnWeight > 0)
          .map((def) => def.id);
        expect(
          data.zombiesForDay(day, night).map((def) => def.id),
          `day ${day} night=${night}`,
        ).toEqual(expected);
      }
    }
    expect(data.zombiesForDay(5, false)).toBe(data.zombiesForDay(5, false));
    expect(data.zombiesForDay(0, false)).toEqual([]);
  });

  it('hands out frozen arrays, so a consumer cannot corrupt a shared table', () => {
    const shared: Record<string, readonly unknown[]> = {
      handRecipes: data.recipesForStation(undefined),
      workbenchRecipes: data.recipesForStation('workbench'),
      grindstoneRecipes: data.recipesForStation('grindstone'),
      buildable: data.buildableStructures(),
      seeds: data.itemsWithTag('seed'),
      lakeNodes: data.nodesForBiome(Biome.Lake),
      forestAnimals: data.animalsForBiome(Biome.Forest),
      nightZombies: data.zombiesForDay(10, true),
      allItems: data.items.all(),
      itemIds: data.items.ids(),
    };
    for (const [name, list] of Object.entries(shared)) {
      expect(Object.isFrozen(list), name).toBe(true);
    }
    // And the misses, which share one frozen empty array.
    expect(Object.isFrozen(data.itemsWithTag('no_such_tag'))).toBe(true);
    expect(Object.isFrozen(data.recipesForStation('anvil'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('validateGameData', () => {
  it('passes on the shipped tables', () => {
    expect(collectGameDataProblems(tables)).toEqual([]);
    expect(() => validateGameData(tables)).not.toThrow();
  });

  it('reports a dangling recipe input and output together, not just the first', () => {
    const problems = collectGameDataProblems({
      ...tables,
      recipes: [
        {
          id: 'craft_broken',
          category: 'basic',
          inputs: [{ defId: 'unobtainium', count: 1 }],
          tools: [],
          outputs: [{ defId: 'also_missing', count: 1 }],
          craftTicks: 20,
          xp: { skill: 'crafting', amount: 1 },
          unlockedByDefault: true,
        },
      ],
    });
    expect(problems).toContain('recipe "craft_broken" input: unknown item "unobtainium"');
    expect(problems).toContain('recipe "craft_broken" output: unknown item "also_missing"');
  });

  it('throws a GameDataValidationError carrying every problem', () => {
    let error: GameDataValidationError | undefined;
    try {
      createGameData({ structures: [] });
    } catch (caught) {
      error = caught as GameDataValidationError;
    }
    expect(error).toBeInstanceOf(GameDataValidationError);
    expect(error?.problems.length).toBeGreaterThan(5);
    expect(error?.message).toContain('game-data validation failed');
  });

  it('catches a structure cost that points at nothing', () => {
    const first = tables.structures[0];
    expect(first).toBeDefined();
    const problems = collectGameDataProblems({
      ...tables,
      structures: [
        {
          ...(first as (typeof tables.structures)[number]),
          cost: [{ defId: 'ghost_plank', count: 1 }],
        },
      ],
    });
    expect(problems.some((p) => p.includes('cost: unknown item "ghost_plank"'))).toBe(true);
  });

  it('catches a node yield that points at nothing', () => {
    const node = tables.nodes[0] as ResourceNodeSource;
    const problems = collectGameDataProblems({
      ...tables,
      nodes: [{ ...node, yields: [{ defId: 'unobtainium', min: 1, max: 1, chance: 1 }] }],
    });
    expect(problems.some((p) => p.includes('yield: unknown item "unobtainium"'))).toBe(true);
  });

  it('catches a crop whose ticksPerStage does not match its stage count', () => {
    const crop = tables.crops[0];
    expect(crop).toBeDefined();
    const problems = collectGameDataProblems({
      ...tables,
      crops: [{ ...(crop as (typeof tables.crops)[number]), stages: 4, ticksPerStage: [10, 20] }],
    });
    expect(problems.some((p) => p.includes('expected 3 (stages - 1)'))).toBe(true);
  });

  it('catches a seed that does not point back at its crop', () => {
    const problems = collectGameDataProblems({
      ...tables,
      items: tables.items.map((item) =>
        item.id === 'seed_wheat' ? { ...item, cropDefId: 'corn' } : item,
      ),
    });
    expect(problems.some((p) => p.includes('seed "seed_wheat" plants "corn"'))).toBe(true);
  });

  it('catches ammo pointing at an unknown projectile', () => {
    const problems = collectGameDataProblems({
      ...tables,
      items: tables.items.map((item) =>
        item.id === 'ammo_9mm' ? { ...item, projectileDefId: 'bullet_nope' } : item,
      ),
    });
    expect(problems).toContain('item "ammo_9mm": unknown projectile "bullet_nope"');
  });

  it('catches a placeable that places a structure that does not exist', () => {
    const problems = collectGameDataProblems({
      ...tables,
      items: tables.items.map((item) =>
        item.id === 'workbench_kit' ? { ...item, placesStructureDefId: 'workbenchh' } : item,
      ),
    });
    expect(problems).toContain('item "workbench_kit": unknown structure "workbenchh"');
  });

  it('catches a loot entry with a condition range on an item that cannot wear out', () => {
    const table: LootTableDef = {
      id: 'test_table',
      rolls: [1, 1],
      entries: [{ defId: 'stone', min: 1, max: 1, chance: 1, weight: 1, condition: [0.2, 0.5] }],
    };
    const problems = collectGameDataProblems({
      ...tables,
      lootTables: [...tables.lootTables, table],
    });
    expect(problems.some((p) => p.includes('no maxDurability to apply it to'))).toBe(true);
  });

  it('catches a creature pointing at a loot table that does not exist', () => {
    const problems = collectGameDataProblems({
      ...tables,
      animals: tables.animals.map((animal) => ({ ...animal, lootTableId: 'animal_griffin' })),
    });
    expect(problems.some((p) => p.includes('unknown loot table "animal_griffin"'))).toBe(true);
  });

  it('catches a locked recipe with no schematic to unlock it', () => {
    const problems = collectGameDataProblems({
      ...tables,
      items: tables.items.filter((item) => !item.tags.includes('schematic')),
    });
    expect(
      problems.some((p) => p.includes('locked recipe has no schematic item unlocking it')),
    ).toBe(true);
  });

  it('buildGameData skips validation, so tests can build deliberately broken data', () => {
    expect(() => buildGameData({ ...localized, recipes: [] })).not.toThrow();
    expect(buildGameData({ ...localized, recipes: [] }).recipes.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Validation: the ranges the contract's doc comments promise
// ---------------------------------------------------------------------------

/**
 * These are the fields that produce *nonsense* rather than a crash when they are out of
 * range - a coverage of 1.4 absorbs more damage than was dealt, a `bleedStop` of -0.2
 * opens the wound. Nothing downstream re-checks them, so the validator is the only
 * place they can be caught.
 */
describe('validateGameData enforces documented ranges', () => {
  const patchItem = (id: string, patch: (def: ItemSource) => ItemSource): string[] =>
    collectGameDataProblems({
      ...tables,
      items: tables.items.map((item) => (item.id === id ? patch(item) : item)),
    });

  it('rejects armour coverage above 1', () => {
    const problems = patchItem('leather_jacket', (def) => ({
      ...def,
      armor: { ...def.armor!, coverage: { ...def.armor!.coverage, torso: 1.4 } },
    }));
    expect(problems.some((p) => p.includes('coverage.torso is 1.4, outside 0..1'))).toBe(true);
  });

  it('rejects negative armour protection', () => {
    const problems = patchItem('kevlar_vest', (def) => ({
      ...def,
      armor: { ...def.armor!, protection: { ...def.armor!.protection, bullet: -3 } },
    }));
    expect(problems.some((p) => p.includes('protection.bullet is -3'))).toBe(true);
  });

  it('rejects a bandage whose cleanliness or bleedStop leaves 0..1', () => {
    expect(
      patchItem('bandage_clean', (def) => ({
        ...def,
        medical: { ...def.medical!, cleanliness: 1.5 },
      })).some((p) => p.includes('medical.cleanliness is 1.5, outside 0..1')),
    ).toBe(true);
    expect(
      patchItem('bandage_clean', (def) => ({
        ...def,
        medical: { ...def.medical!, bleedStop: -0.2 },
      })).some((p) => p.includes('medical.bleedStop is -0.2, outside 0..1')),
    ).toBe(true);
  });

  it('rejects a status-effect grant with an impossible chance', () => {
    const problems = patchItem('coffee', (def) => ({
      ...def,
      drink: {
        ...def.drink!,
        effects: [{ id: 'adrenaline', durationTicks: 100, magnitude: 1, chance: 1.5 }],
      },
    }));
    expect(problems.some((p) => p.includes('chance is 1.5, outside (0, 1]'))).toBe(true);
  });

  it('rejects a wind-up longer than the attack it belongs to', () => {
    const problems = patchItem('stone_hatchet', (def) => ({
      ...def,
      weapon: { ...def.weapon!, windupTicks: def.weapon!.attackTicks + 1 },
    }));
    expect(problems.some((p) => p.includes('windupTicks'))).toBe(true);
  });

  it('rejects a melee weapon that sweeps no arc', () => {
    const problems = patchItem('stone_hatchet', (def) => ({
      ...def,
      weapon: { ...def.weapon!, arcDegrees: 0 },
    }));
    expect(problems.some((p) => p.includes('arcDegrees'))).toBe(true);
  });

  it('rejects a refrigeration multiplier that would speed spoilage up', () => {
    const problems = patchItem('berry', (def) => ({
      ...def,
      perishable: { ...def.perishable!, refrigeratedMultiplier: 1.5 },
    }));
    expect(problems.some((p) => p.includes('refrigeratedMultiplier'))).toBe(true);
  });

  it('rejects an unknown placement surface or stacking category', () => {
    const first = tables.structures[0] as (typeof tables.structures)[number];
    expect(
      collectGameDataProblems({
        ...tables,
        structures: [{ ...first, placeOn: 'ceiling' as never }],
      }).some((p) => p.includes('unknown placeOn surface "ceiling"')),
    ).toBe(true);
    expect(
      collectGameDataProblems({
        ...tables,
        structures: [{ ...first, stacksOver: ['roof' as never] }],
      }).some((p) => p.includes('unknown stacksOver category "roof"')),
    ).toBe(true);
  });

  it('catches a typo in a tagged input’s preferred defId, which still shows in the UI', () => {
    const problems = collectGameDataProblems({
      ...tables,
      recipes: [
        {
          id: 'craft_tagged',
          category: 'basic',
          inputs: [{ defId: 'clothh_rag', count: 1, tag: 'fibre_source' }],
          tools: [],
          outputs: [{ defId: 'rope', count: 1 }],
          craftTicks: 20,
          xp: { skill: 'crafting', amount: 1 },
          unlockedByDefault: true,
        },
      ],
      items: tables.items.map((item) =>
        item.id === 'cloth_rag' ? { ...item, tags: [...item.tags, 'fibre_source'] } : item,
      ),
    });
    expect(problems).toContain('recipe "craft_tagged" tagged input: unknown item "clothh_rag"');
  });
});

// ---------------------------------------------------------------------------
// Progression reachability
// ---------------------------------------------------------------------------

/**
 * Everything a player can obtain, starting from bare hands.
 *
 * A fixpoint over three mutually dependent facts: which items you hold, which nodes you
 * can work (needs tools, which are items), and which stations you can stand at (needs a
 * kit or resources, which are items). Seeded with the nodes bare hands can work
 * (`wrongToolMultiplier > 0`) plus wildlife, since hunting needs nothing but a rock.
 *
 * Deliberately excludes every scavenged container table: if the crafting tree only
 * closes because a shotgun spawns in a police station, the tree is broken.
 */
function reachableItems(): Set<string> {
  const reachable = new Set<string>();
  const nodeYields = (node: ResourceNodeSource): string[] =>
    [...node.yields, ...node.yieldPerHit].map((entry) => entry.defId);

  const bareHanded = (node: ResourceNodeSource): boolean =>
    node.toolKinds.length === 0 || node.wrongToolMultiplier > 0;

  for (const node of tables.nodes) {
    if (bareHanded(node)) for (const id of nodeYields(node)) reachable.add(id);
  }
  for (const table of tables.lootTables) {
    if (!table.id.startsWith('animal_')) continue;
    for (const entry of [...table.entries, ...(table.guaranteed ?? [])]) reachable.add(entry.defId);
  }

  const haveTool = (kind: string, minTier: number): boolean =>
    tables.items.some(
      (item) =>
        reachable.has(item.id) &&
        item.tool !== undefined &&
        item.tool.tier >= minTier &&
        item.tool.kinds.includes(kind as never),
    );

  const haveStation = (station: StationKind): boolean =>
    tables.structures.some(
      (def) => def.station?.kind === station && def.cost.every((c) => reachable.has(c.defId)),
    );

  /** Farming needs somewhere to farm: a plot structure whose cost you can afford. */
  const havePlot = (): boolean =>
    tables.structures.some(
      (def) => def.plot !== undefined && def.cost.every((c) => reachable.has(c.defId)),
    );

  for (let pass = 0; pass < 32; pass++) {
    const before = reachable.size;

    for (const node of tables.nodes) {
      if (bareHanded(node) || node.toolKinds.some((kind) => haveTool(kind, node.minToolTier))) {
        for (const id of nodeYields(node)) reachable.add(id);
      }
    }

    if (havePlot()) {
      for (const crop of tables.crops) {
        if (reachable.has(crop.seedDefId)) reachable.add(crop.produceDefId);
      }
    }

    for (const recipe of tables.recipes) {
      if (recipe.station !== undefined && !haveStation(recipe.station)) continue;
      if (!recipe.tools.every((kind) => haveTool(kind, 1))) continue;
      const inputsMet = recipe.inputs.every((input) =>
        input.tag !== undefined
          ? tables.items.some(
              (item) => reachable.has(item.id) && item.tags.includes(input.tag as string),
            )
          : reachable.has(input.defId),
      );
      if (!inputsMet) continue;
      for (const output of recipe.outputs) reachable.add(output.defId);
    }

    if (reachable.size === before) break;
  }

  return reachable;
}

describe('progression balance', () => {
  const reachable = reachableItems();

  it('bootstraps stone tools from what bare hands can gather', () => {
    for (const id of ['plant_fiber', 'wood_log', 'stick', 'stone', 'flint', 'water_dirty']) {
      expect(reachable.has(id), `${id} must be gatherable bare-handed`).toBe(true);
    }
    for (const id of [
      'stone_hatchet',
      'stone_pickaxe',
      'stone_knife',
      'campfire_kit',
      'workbench_kit',
    ]) {
      expect(reachable.has(id), `${id} must be craftable on day one`).toBe(true);
    }
  });

  it('cannot fell a living tree or crack a boulder bare-handed', () => {
    for (const id of [
      'tree_pine',
      'tree_oak',
      'tree_birch',
      'rock_boulder',
      'ore_iron',
      'ore_copper',
    ]) {
      expect(data.nodes.require(id).wrongToolMultiplier, id).toBe(0);
    }
    // ...but dead wood and loose rock give way, which is the whole bootstrap.
    expect(data.nodes.require('tree_dead').wrongToolMultiplier).toBeGreaterThan(0);
    expect(data.nodes.require('rock_small').wrongToolMultiplier).toBeGreaterThan(0);
    expect(data.nodes.require('scrap_pile').wrongToolMultiplier).toBeGreaterThan(0);
  });

  it('reaches iron, then steel, without scavenging a single container', () => {
    for (const id of ['iron_ingot', 'iron_pickaxe', 'steel_ingot', 'steel_axe']) {
      expect(reachable.has(id), `${id} unreachable`).toBe(true);
    }
  });

  it('makes every craftable weapon reachable from tier-1 gatherables', () => {
    const craftableWeapons = new Set<string>();
    for (const recipe of tables.recipes) {
      for (const output of recipe.outputs) {
        const def = data.items.get(output.defId);
        if (def?.weapon) craftableWeapons.add(def.id);
      }
    }
    expect(craftableWeapons.size).toBeGreaterThan(10);
    const unreachable = [...craftableWeapons].filter((id) => !reachable.has(id)).sort();
    expect(unreachable).toEqual([]);
  });

  it('leaves firearms and body armour to loot only', () => {
    for (const id of ['pistol_9mm', 'rifle_308', 'shotgun', 'kevlar_vest', 'plate_carrier']) {
      expect(reachable.has(id), `${id} should not be craftable`).toBe(false);
      expect(
        tables.recipes.some((r) => r.outputs.some((o) => o.defId === id)),
        `${id} should have no recipe`,
      ).toBe(false);
    }
  });

  it('reaches a full food and medicine chain', () => {
    for (const id of [
      'water_clean',
      'cooked_meat',
      'bread',
      'stew_meat',
      'antiseptic',
      'antibiotics',
    ]) {
      expect(reachable.has(id), `${id} unreachable`).toBe(true);
    }
  });

  it('closes the fishing loop: rod, catch and cook', () => {
    // The rod is craftable, something in the world accepts it, and the fish it lands
    // feeds a recipe. Break any one link and the other two become dead content.
    for (const id of ['fishing_rod', 'raw_fish', 'cooked_fish']) {
      expect(reachable.has(id), `${id} unreachable`).toBe(true);
    }
    const fishNodes = data.nodes
      .all()
      .filter((node) => node.toolKinds.includes('fishingRod'))
      .map((node) => node.id);
    expect(fishNodes.length).toBeGreaterThan(0);
    // ...and fish are the one food a rod is mandatory for.
    for (const id of fishNodes) {
      expect(data.nodes.require(id).wrongToolMultiplier, id).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Content completeness
// ---------------------------------------------------------------------------

/**
 * The properties that catch *dead content* - definitions that reference each other
 * consistently (so the validator is happy) but that no player can ever reach or use.
 * Referential integrity cannot see these; only a whole-table sweep can.
 */
describe('content completeness', () => {
  it('gives every item at least one source in the world', () => {
    const sourced = new Set<string>();
    for (const recipe of tables.recipes) for (const out of recipe.outputs) sourced.add(out.defId);
    for (const node of tables.nodes) {
      for (const entry of [...node.yields, ...node.yieldPerHit]) sourced.add(entry.defId);
    }
    for (const table of tables.lootTables) {
      for (const entry of [...table.entries, ...(table.guaranteed ?? [])]) sourced.add(entry.defId);
    }
    for (const crop of tables.crops) {
      sourced.add(crop.produceDefId);
      sourced.add(crop.seedDefId);
    }
    for (const item of tables.items) {
      if (item.perishable?.spoiledDefId) sourced.add(item.perishable.spoiledDefId);
      if (item.liquid?.contentDefId) sourced.add(item.liquid.contentDefId);
    }
    for (const projectile of tables.projectiles) {
      if (projectile.recoverDefId) sourced.add(projectile.recoverDefId);
    }

    const orphans = tables.items.filter((item) => !sourced.has(item.id)).map((item) => item.id);
    expect(orphans, 'items no recipe, node, loot table or crop can produce').toEqual([]);
  });

  it('demands every tool kind somewhere in the world', () => {
    // A tool kind is only real if a node, recipe or structure asks for it. The two
    // exceptions are interactions the contract has no other field for: watering a
    // `plot` (see `CropDef.waterPerTick`) and lighting a `station.needsFuel` fire.
    const simulationOnly = new Set<ToolKind>(['wateringCan', 'lighter']);
    const demanded = new Set<string>();
    for (const node of data.nodes.all()) for (const kind of node.toolKinds) demanded.add(kind);
    for (const recipe of data.recipes.all()) for (const kind of recipe.tools) demanded.add(kind);
    for (const structure of data.structures.all()) {
      if (structure.tool) demanded.add(structure.tool);
    }

    const provided = new Set<ToolKind>();
    for (const item of data.items.all())
      for (const kind of item.tool?.kinds ?? []) provided.add(kind);

    for (const kind of provided) {
      if (simulationOnly.has(kind)) continue;
      expect(demanded.has(kind), `tool kind "${kind}" is craftable but nothing needs it`).toBe(
        true,
      );
    }
    for (const kind of demanded) {
      expect(
        [...provided].includes(kind as ToolKind),
        `tool kind "${kind}" is required but no item provides it`,
      ).toBe(true);
    }
  });

  it('leaves no crafted item as a dead end', () => {
    // Spending fuel and materials on something with no use and no further recipe is
    // strictly worse than the recipe not existing. `lockpick` is the one exception:
    // `StructureDef.door.lockable` is the contract's hook for it, and the simulation
    // consumes it through a door interaction rather than a recipe.
    const simulationOnly = new Set(['lockpick']);
    const consumed = new Set<string>();
    for (const recipe of tables.recipes) {
      for (const input of recipe.inputs) {
        consumed.add(input.defId);
        if (input.tag) {
          for (const item of tables.items) {
            if (item.tags.includes(input.tag)) consumed.add(item.id);
          }
        }
      }
    }
    for (const structure of tables.structures) {
      for (const amount of structure.cost) consumed.add(amount.defId);
    }
    for (const item of tables.items) {
      for (const ammo of item.weapon?.ammoDefIds ?? []) consumed.add(ammo);
    }

    const deadEnds: string[] = [];
    for (const recipe of tables.recipes) {
      for (const output of recipe.outputs) {
        if (consumed.has(output.defId) || simulationOnly.has(output.defId)) continue;
        const def = data.items.get(output.defId);
        if (!def) continue;
        const usable =
          def.tool ??
          def.weapon ??
          def.armor ??
          def.food ??
          def.drink ??
          def.medical ??
          def.fuel ??
          def.liquid ??
          def.cropDefId ??
          def.containerSlots ??
          def.placesStructureDefId ??
          def.projectileDefId ??
          def.fertilizerTicks;
        if (usable === undefined) deadEnds.push(`${recipe.id} -> ${output.defId}`);
      }
    }
    expect(deadEnds, 'recipes producing an item with no use and no consumer').toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Balance sanity
// ---------------------------------------------------------------------------

describe('balance sanity', () => {
  it('gives every crop exactly stages - 1 growth transitions', () => {
    for (const crop of data.crops.all()) {
      expect(crop.ticksPerStage.length, crop.id).toBe(crop.stages - 1);
    }
  });

  it('grows every crop in three to eight in-game days', () => {
    for (const crop of data.crops.all()) {
      const total = crop.ticksPerStage.reduce((sum, ticks) => sum + ticks, 0);
      const dayCount = total / TICKS_PER_GAME_DAY;
      expect(dayCount, `${crop.id} takes ${dayCount} days`).toBeGreaterThanOrEqual(3);
      expect(dayCount, `${crop.id} takes ${dayCount} days`).toBeLessThanOrEqual(8);
    }
  });

  it('makes gunshots an order of magnitude louder than melee', () => {
    const firearms = data.itemsWithTag('firearm');
    expect(firearms.length).toBeGreaterThanOrEqual(3);
    let quietestGun = Infinity;
    for (const gun of firearms) {
      const loudness = gun.weapon?.loudness ?? 0;
      expect(loudness, gun.id).toBeGreaterThanOrEqual(4000);
      quietestGun = Math.min(quietestGun, loudness);
    }
    let loudestMelee = 0;
    for (const item of data.items.all()) {
      if (item.weapon?.kind === 'melee')
        loudestMelee = Math.max(loudestMelee, item.weapon.loudness);
    }
    expect(loudestMelee).toBeLessThan(quietestGun / 5);
    // Bows are the reward for not using a gun.
    expect(data.items.require('hunting_bow').weapon?.loudness).toBeLessThan(loudestMelee * 3);
  });

  it('keeps firearms and their ammunition rare', () => {
    for (const gun of data.itemsWithTag('firearm')) {
      expect(['rare', 'epic'], gun.id).toContain(gun.rarity);
    }
    for (const ammo of data.items.all()) {
      if (ammo.category !== 'ammo' || !ammo.tags.includes('bullet')) continue;
      expect(['uncommon', 'rare'], ammo.id).toContain(ammo.rarity);
    }
  });

  it('orders tool tiers monotonically in efficiency and durability', () => {
    const chains = [
      ['stone_hatchet', 'iron_axe', 'steel_axe'],
      ['stone_pickaxe', 'iron_pickaxe', 'steel_pickaxe'],
      ['stone_knife', 'iron_knife'],
    ];
    for (const chain of chains) {
      for (let i = 1; i < chain.length; i++) {
        const previousId = chain[i - 1] as string;
        const currentId = chain[i] as string;
        const previous = data.items.require(previousId);
        const current = data.items.require(currentId);
        expect(current.tool?.tier, currentId).toBeGreaterThan(previous.tool?.tier ?? 0);
        expect(current.tool?.efficiency, currentId).toBeGreaterThan(previous.tool?.efficiency ?? 0);
        expect(current.maxDurability, currentId).toBeGreaterThan(previous.maxDurability ?? 0);
      }
    }
  });

  it('makes stone and metal walls meaningfully tougher than wood', () => {
    // Effective toughness is health divided by the multiplier zombies get against it.
    const toughness = (id: string): number => {
      const def = data.structures.require(id);
      return def.maxHealth / def.zombieDamageMultiplier;
    };
    expect(toughness('wall_wood')).toBeGreaterThan(toughness('wall_wood_frame') * 2);
    expect(toughness('wall_stone')).toBeGreaterThan(toughness('wall_wood') * 3);
    expect(toughness('wall_metal')).toBeGreaterThan(toughness('wall_stone') * 3);
    expect(toughness('door_metal')).toBeGreaterThan(toughness('door_wood') * 4);
    expect(toughness('foundation_stone')).toBeGreaterThan(toughness('foundation_wood') * 2);
  });

  it('gates the good stuff behind skill levels', () => {
    const gated = data.recipes.all().filter((recipe) => recipe.requiredSkill !== undefined);
    expect(gated.length).toBeGreaterThanOrEqual(30);
    // Nothing hand-craftable requires a skill level: the bootstrap must never be locked.
    for (const recipe of data.recipesForStation(undefined)) {
      expect(recipe.requiredSkill, recipe.id).toBeUndefined();
      expect(recipe.tools, recipe.id).toEqual([]);
      expect(recipe.fuelCost, recipe.id).toBeUndefined();
    }
    // ...and the top of each tree does.
    for (const id of [
      'forge_steel_axe',
      'forge_iron_sword',
      'make_antibiotics',
      'craft_crossbow',
    ]) {
      expect(data.recipes.require(id).requiredSkill, id).toBeDefined();
    }
  });

  it('only asks for heat at stations that actually burn fuel', () => {
    for (const recipe of data.recipes.all()) {
      if (!recipe.requiresHeat) continue;
      expect(recipe.station, recipe.id).toBeDefined();
      const providers = data.structures.all().filter((def) => def.station?.kind === recipe.station);
      expect(providers.length, recipe.id).toBeGreaterThan(0);
      for (const provider of providers) {
        expect(provider.station?.needsFuel, `${recipe.id} at ${provider.id}`).toBe(true);
      }
      expect(recipe.fuelCost, recipe.id).toBeGreaterThan(0);
    }
  });

  it('gives every station kind both a structure and something to make there', () => {
    const kinds: StationKind[] = [
      'workbench',
      'campfire',
      'furnace',
      'anvil',
      'loom',
      'cookingPot',
      'chemistry',
      'grindstone',
    ];
    for (const kind of kinds) {
      expect(
        data.structures.all().some((def) => def.station?.kind === kind),
        kind,
      ).toBe(true);
      expect(data.recipesForStation(kind).length, kind).toBeGreaterThan(0);
    }
  });

  it('makes raw meat, fish and wild mushrooms a real gamble', () => {
    for (const id of ['raw_meat', 'raw_fish', 'mushroom']) {
      const def = data.items.require(id);
      expect(def.food?.sicknessChance, id).toBeGreaterThan(0.2);
    }
    for (const id of ['cooked_meat', 'cooked_fish']) {
      const def = data.items.require(id);
      expect(def.food?.sicknessChance, id).toBeLessThan(0.05);
      expect(def.food?.nutrition ?? 0, id).toBeGreaterThan(20);
    }
    expect(data.items.require('water_dirty').drink?.sicknessChance).toBeGreaterThan(0.2);
    expect(data.items.require('water_clean').drink?.sicknessChance).toBeLessThan(0.05);
  });

  it('keeps bandage cleanliness ordered, so a dirty rag is a trade-off', () => {
    const cleanliness = (id: string): number => data.items.require(id).medical?.cleanliness ?? -1;
    expect(cleanliness('bandage_dirty')).toBeLessThan(cleanliness('bandage_clean'));
    expect(cleanliness('bandage_clean')).toBeLessThan(cleanliness('bandage_sterile'));
    expect(data.items.require('bandage_dirty').medical?.bleedStop).toBeGreaterThan(0.5);
  });

  it('declares stackSize 1 for anything carrying per-item state', () => {
    for (const item of data.items.all()) {
      const hasPerItemState =
        item.maxDurability !== undefined ||
        item.weapon !== undefined ||
        item.armor !== undefined ||
        item.liquid !== undefined;
      if (hasPerItemState) expect(item.stackSize, item.id).toBe(1);
    }
  });

  it('ships the items the simulation hands a new character', () => {
    // Mirrors STARTING_KIT in @survive/simulation, which cannot be imported here - the
    // dependency runs the other way. `starting kit` in player.test.ts checks the real list
    // against the real recipes; this only checks the data ships.
    for (const id of [
      'stone_hatchet',
      'spear',
      'cloth_shirt',
      'cloth_pants',
      'cloth_rag',
      'berry',
      'water_bottle',
      'plant_fiber',
      'stick',
      'stone',
      'flint',
    ]) {
      expect(data.items.has(id), id).toBe(true);
    }
    // The starting bottle is full, or the first thirst tick is unanswerable.
    const bottle = data.items.require('water_bottle');
    expect(bottle.liquid?.contentDefId).toBe('water_clean');
    expect(bottle.liquid?.capacity).toBeGreaterThan(0);
    // The kit is worn, not carried: `outfitPlayer` reads the armour slot off the item, so
    // a cloth piece without one would be handed over and then silently left in a bag.
    expect(data.items.require('cloth_shirt').armor?.slot).toBe('chest');
    expect(data.items.require('cloth_pants').armor?.slot).toBe('legs');
  });

  it('lets every arrow and bolt be recovered, and no bullet', () => {
    for (const id of ['arrow_wooden', 'arrow_iron', 'bolt', 'thrown_rock']) {
      const def = data.projectiles.require(id);
      expect(def.recoverDefId, id).toBeDefined();
      expect(def.recoverChance ?? 0, id).toBeGreaterThan(0);
    }
    for (const id of ['bullet_9mm', 'bullet_308', 'pellet']) {
      expect(data.projectiles.require(id).recoverDefId, id).toBeUndefined();
    }
  });

  it('scales zombie speed so early types can be walked away from and later ones cannot', () => {
    const playerWalk = 110;
    const playerSprint = 185;
    expect(data.zombies.require('walker').speedChase).toBeLessThan(playerWalk);
    expect(data.zombies.require('shambler').speedChase).toBeLessThan(playerWalk);
    expect(data.zombies.require('runner').speedChase).toBeGreaterThan(playerSprint);
    expect(data.zombies.require('feral_dog_zombie').speedChase).toBeGreaterThan(playerSprint);
    // The brute cannot catch you; it goes through the wall instead.
    expect(data.zombies.require('brute').speedChase).toBeLessThan(playerSprint);
    expect(data.zombies.require('brute').structureDamage).toBeGreaterThan(
      data.zombies.require('walker').structureDamage * 5,
    );
  });

  it('makes the screamer as loud as a gunshot and everything else much quieter', () => {
    const screamer = data.zombies.require('screamer');
    expect(screamer.noise).toBeGreaterThanOrEqual(4000);
    for (const zombie of data.zombies.all()) {
      if (zombie.id === 'screamer') continue;
      expect(zombie.noise, zombie.id).toBeLessThan(screamer.noise / 5);
    }
  });

  it('rises in reward with zombie tier', () => {
    const byTier = new Map<number, number[]>();
    for (const zombie of data.zombies.all()) {
      const list = byTier.get(zombie.tier) ?? [];
      list.push(zombie.xp);
      byTier.set(zombie.tier, list);
    }
    const tiers = [...byTier.keys()].sort((a, b) => a - b);
    for (let i = 1; i < tiers.length; i++) {
      const previousTier = tiers[i - 1] as number;
      const currentTier = tiers[i] as number;
      const previous = byTier.get(previousTier) as number[];
      const current = byTier.get(currentTier) as number[];
      const avg = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
      expect(avg(current), `tier ${currentTier}`).toBeGreaterThan(avg(previous));
    }
  });

  it('keeps every animal huntable and every aggressive one dangerous', () => {
    for (const animal of data.animals.all()) {
      expect(data.lootTables.has(animal.lootTableId), animal.id).toBe(true);
      const loot = data.lootTables.require(animal.lootTableId);
      const guaranteed = (loot.guaranteed ?? []).map((entry) => entry.defId);
      expect(guaranteed, animal.id).toContain('raw_meat');
      if (animal.behavior === 'aggressive') expect(animal.damage, animal.id).toBeGreaterThan(10);
      if (animal.behavior === 'skittish') expect(animal.fleeRange, animal.id).toBeGreaterThan(100);
    }
  });
});
