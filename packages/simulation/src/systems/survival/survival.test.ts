import { describe, expect, it } from 'vitest';
import {
  BODY_PART_IDS,
  Button,
  SIM_DT,
  TICKS_PER_GAME_HOUR,
  totalPain,
  type PlayerState,
} from '@survive/protocol';
import { createTestSimulation, type TestSimulation } from '@survive/test-utils';
import { killPlayer } from '../../core/death';
import { addEffect } from '../../core/effects';
import { createInputSystem } from '../movement/input';
import { createMovementSystem } from '../movement/movement';
import { isBloodCritical } from './injury';
import { createSurvivalSystem } from './survivalSystem';
import {
  BLACKOUT_PAIN,
  COLD_THRESHOLD,
  CRITICAL_BLOOD,
  FATIGUE_HOURS_TO_CRITICAL,
  HUNGER_DAYS_TO_CRITICAL,
  HUNGER_PER_SECOND,
  HYPOTHERMIA_THRESHOLD,
  LOW_BLOOD,
  NEED_WARN,
  SECONDS_PER_GAME_DAY,
  THIRST_PER_SECOND,
} from './tuning';

/**
 * The survival rules, driven the way the game drives them: build a world, step it,
 * assert on plain state.
 *
 * Two conventions run through the whole file.
 *
 * **Rates are checked against the design contract, not against a magic number.** The
 * assertion for hunger is "measured delta matches `HUNGER_PER_SECOND` over the elapsed
 * seconds" *and* "the constant means what its name says", which catches both a broken
 * integration and a retune that quietly made starvation a five-minute problem.
 *
 * **Chance is exercised across seeds, never once.** A roll asserted on one seed tests
 * the seed. Counting outcomes over a dozen seeds tests the *rule* - and because every
 * roll goes through the seeded RNG, the count is itself deterministic.
 */

/** Survival on its own: no input, no movement, nothing else that could interfere. */
function soloSim(): TestSimulation {
  return createTestSimulation({ systems: [createSurvivalSystem()] });
}

/** Survival with a specific seed, for the multi-seed chance tests. */
function seededSim(seed: number, needRate = 1): TestSimulation {
  return createTestSimulation({
    seed,
    systems: [createSurvivalSystem()],
    config: (config) => {
      config.tuning.needRate = needRate;
    },
  });
}

/** A player with every need satisfied, so one arc can be measured in isolation. */
function restedPlayer(sim: TestSimulation): PlayerState {
  const player = sim.addPlayer();
  player.hunger = 0;
  player.thirst = 0;
  player.fatigue = 0;
  return player;
}

// ---------------------------------------------------------------------------
// Needs
// ---------------------------------------------------------------------------

describe('needs', () => {
  it('starves over two to three in-game days, and thirst runs at twice the pace', () => {
    const sim = soloSim();
    const player = restedPlayer(sim);

    sim.advanceGameHours(6);

    const seconds = 6 * TICKS_PER_GAME_HOUR * SIM_DT;
    // Shivering slightly below the comfort ambient adds a few percent, so the bound is
    // "the modelled rate, plus a little" rather than an exact equality.
    expect(player.hunger).toBeGreaterThan(HUNGER_PER_SECOND * seconds * 0.95);
    expect(player.hunger).toBeLessThan(HUNGER_PER_SECOND * seconds * 1.25);
    expect(player.thirst).toBeGreaterThan(player.hunger * 1.8);

    // The design contract behind those rates.
    expect(HUNGER_DAYS_TO_CRITICAL).toBeGreaterThanOrEqual(2);
    expect(HUNGER_DAYS_TO_CRITICAL).toBeLessThanOrEqual(3);
    expect(HUNGER_PER_SECOND * HUNGER_DAYS_TO_CRITICAL * SECONDS_PER_GAME_DAY).toBeCloseTo(100, 6);
    expect(THIRST_PER_SECOND).toBeCloseTo(HUNGER_PER_SECOND * 2, 8);
  });

  it('tires over a long waking day', () => {
    const sim = soloSim();
    const player = restedPlayer(sim);
    sim.advanceGameHours(FATIGUE_HOURS_TO_CRITICAL / 2);
    expect(player.fatigue).toBeGreaterThan(45);
    expect(player.fatigue).toBeLessThan(55);
  });

  it('scales every need by the needRate tuning knob', () => {
    const gentle = seededSim(9001, 1);
    const cruel = seededSim(9001, 2);
    const a = restedPlayer(gentle);
    const b = restedPlayer(cruel);

    gentle.advanceGameHours(2);
    cruel.advanceGameHours(2);

    expect(b.hunger / a.hunger).toBeCloseTo(2, 1);
    expect(b.thirst / a.thirst).toBeCloseTo(2, 1);
    expect(b.fatigue / a.fatigue).toBeCloseTo(2, 1);
  });

  it('charges more for sprinting than for standing still', () => {
    const sim = createTestSimulation({
      systems: [createInputSystem(), createMovementSystem(), createSurvivalSystem()],
    });
    const sprinter = restedPlayer(sim);
    const idler = sim.addPlayer({ id: 'idle' });
    idler.hunger = 0;
    idler.thirst = 0;
    idler.fatigue = 0;

    // Eight seconds is inside the stamina budget for a continuous sprint.
    for (let i = 0; i < 160; i++) {
      sim.input(sprinter, { moveX: 1, buttons: Button.Sprint });
      sim.step(1);
    }

    expect(sprinter.moveMode).toBe('run');
    expect(sprinter.hunger).toBeGreaterThan(idler.hunger * 1.5);
    expect(sprinter.thirst).toBeGreaterThan(idler.thirst * 1.5);
    expect(sprinter.fatigue).toBeGreaterThan(idler.fatigue * 1.5);
  });

  it('warns on crossing a need threshold instead of spamming damage events', () => {
    const sim = soloSim();
    const player = sim.addPlayer();
    player.hunger = NEED_WARN - 0.1;
    player.thirst = 0;
    player.fatigue = 0;
    sim.clearEvents();

    // Long enough to cross 50, nowhere near long enough to reach 80.
    sim.advanceSeconds(20);

    const warnings = sim
      .eventsOf('notification')
      .filter((event) => event.playerId === player.id && event.text.includes('hungry'));
    expect(warnings).toHaveLength(1);
  });

  it('applies attrition silently, so per-tick damage never reaches the feed', () => {
    const sim = soloSim();
    const player = sim.addPlayer();
    player.hunger = 100;
    sim.clearEvents();

    sim.step(200);

    expect(player.body.parts.torso.health).toBeLessThan(100);
    expect(sim.eventsOf('damage')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Temperature
// ---------------------------------------------------------------------------

describe('temperature', () => {
  /** Freeze the weather at a fixed air temperature; the time system is not running. */
  function chill(sim: TestSimulation, celsius: number): void {
    sim.sim.state.weather.temperature = celsius;
  }

  it('drives the core down into hypothermia in a hard frost with no clothing', () => {
    const sim = soloSim();
    const player = sim.addPlayer();
    chill(sim, 0);

    sim.advanceSeconds(60);

    expect(player.temperature).toBeLessThan(HYPOTHERMIA_THRESHOLD);
    expect(player.effects.map((effect) => effect.id)).toContain('hypothermia');
    expect(sim.eventsOf('notification').some((e) => e.text.includes('Hypothermia'))).toBe(true);
  });

  it('is held off by a warm coat', () => {
    const sim = soloSim();
    const player = sim.addPlayer();
    sim.equip(player, 'leather_jacket');
    chill(sim, 0);

    sim.advanceSeconds(60);

    expect(player.temperature).toBeGreaterThan(HYPOTHERMIA_THRESHOLD);
    expect(player.effects.map((effect) => effect.id)).not.toContain('hypothermia');
    // Still uncomfortable: a jacket is not a heated room.
    expect(player.temperature).toBeLessThan(COLD_THRESHOLD);
  });

  it('is held off by a lit campfire', () => {
    const sim = soloSim();
    const player = sim.addPlayer();
    chill(sim, 0);

    const fire = sim.placeStructure(
      'campfire',
      Math.floor(player.x / 32) + 1,
      Math.floor(player.y / 32),
    );
    expect(fire).not.toBeNull();
    // Lighting it is the stations system's job; this test only needs it burning.
    if (fire?.station) {
      fire.station.lit = true;
      fire.station.fuel = fire.station.maxFuel;
      fire.station.heat = sim.data.structures.require('campfire').station?.heat ?? 14;
    }
    if (fire?.light) fire.light.on = true;

    sim.advanceSeconds(60);

    expect(player.temperature).toBeGreaterThan(COLD_THRESHOLD);
    expect(player.effects.map((effect) => effect.id)).not.toContain('hypothermia');
  });

  it('overheats and eventually cooks in extreme heat', () => {
    const sim = soloSim();
    const player = sim.addPlayer();
    chill(sim, 46);

    sim.advanceSeconds(60);

    expect(player.temperature).toBeGreaterThan(39.5);
    expect(player.effects.map((effect) => effect.id)).toContain('heatstroke');
    expect(player.body.parts.torso.health).toBeLessThan(100);
  });

  it('soaks the player through in the rain and dries them off afterwards', () => {
    const sim = soloSim();
    const player = sim.addPlayer();
    sim.sim.state.weather.type = 'rain';
    sim.sim.state.weather.intensity = 1;

    sim.advanceSeconds(30);
    // Read out the number, not the effect: `setConditionEffect` updates the same record
    // in place, so holding the object would compare a value with itself.
    const soaked = player.effects.find((effect) => effect.id === 'wet')?.magnitude ?? 0;
    expect(soaked).toBeGreaterThan(0.5);

    sim.sim.state.weather.type = 'clear';
    sim.sim.state.weather.intensity = 0;
    sim.advanceSeconds(60);
    const drying = player.effects.find((effect) => effect.id === 'wet')?.magnitude ?? 0;
    expect(drying).toBeLessThan(soaked);
    expect(drying).toBeGreaterThan(0);
  });

  it('dries a soaked player far faster next to a fire', () => {
    const byFire = soloSim();
    const inTheOpen = soloSim();
    for (const harness of [byFire, inTheOpen]) {
      const player = harness.addPlayer();
      player.effects.push({ id: 'wet', startedTick: 0, endsTick: -1, magnitude: 1 });
      expect(player.effects).toHaveLength(1);
    }
    const warmed = byFire.sim.state.players.p1;
    expect(warmed).toBeDefined();
    const fire = byFire.placeStructure(
      'campfire',
      Math.floor((warmed?.x ?? 0) / 32) + 1,
      Math.floor((warmed?.y ?? 0) / 32),
    );
    if (fire?.station) {
      fire.station.lit = true;
      fire.station.heat = byFire.data.structures.require('campfire').station?.heat ?? 14;
    }

    byFire.advanceSeconds(30);
    inTheOpen.advanceSeconds(30);

    const wetByFire = warmed?.effects.find((effect) => effect.id === 'wet')?.magnitude ?? 0;
    const wetOutside =
      inTheOpen.sim.state.players.p1?.effects.find((effect) => effect.id === 'wet')?.magnitude ?? 0;
    expect(wetByFire).toBeLessThan(wetOutside);
  });

  it('reports low blood so the client can grey the screen out', () => {
    const sim = soloSim();
    const player = sim.addPlayer();
    expect(isBloodCritical(player)).toBe(false);
    player.blood = LOW_BLOOD - 1;
    expect(isBloodCritical(player)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bleeding and blood
// ---------------------------------------------------------------------------

describe('bleeding', () => {
  it('drains blood while a wound is open', () => {
    const sim = soloSim();
    const player = sim.addPlayer();
    player.body.parts.leftArm.bleeding = 3;
    sim.clearEvents();

    sim.advanceSeconds(10);

    // 3 units/second for 10 seconds, minus nothing: a wound this size does not clot.
    expect(player.blood).toBeLessThan(75);
    expect(player.blood).toBeGreaterThan(65);
    expect(player.body.parts.leftArm.bleeding).toBeCloseTo(3, 5);
    expect(player.effects.map((effect) => effect.id)).toContain('bleeding');
  });

  it('warns once on each blood threshold it crosses', () => {
    const sim = soloSim();
    const player = sim.addPlayer();
    player.body.parts.leftArm.bleeding = 3;
    sim.clearEvents();

    sim.advanceSeconds(16);

    expect(player.blood).toBeLessThan(LOW_BLOOD);
    expect(player.blood).toBeGreaterThan(CRITICAL_BLOOD);
    const warnings = sim
      .eventsOf('notification')
      .filter((event) => event.text.includes('lost a lot of blood'));
    expect(warnings).toHaveLength(1);
    expect(sim.eventsOf('notification').some((event) => event.text.includes('bleeding out'))).toBe(
      false,
    );
  });

  it('clots a graze on its own but never an arterial bleed', () => {
    const sim = soloSim();
    const player = sim.addPlayer();
    player.body.parts.leftLeg.bleeding = 0.4;
    // Small enough that the player is still alive when the graze finishes clotting.
    player.body.parts.rightLeg.bleeding = 1.4;

    sim.advanceSeconds(40);

    expect(player.body.parts.leftLeg.bleeding).toBe(0);
    expect(player.body.parts.rightLeg.bleeding).toBeCloseTo(1.4, 5);
    expect(sim.eventsOf('bleedingStopped').some((event) => event.bodyPart === 'leftLeg')).toBe(
      true,
    );
  });

  it('kills by exsanguination when blood runs out', () => {
    const sim = soloSim();
    const player = sim.addPlayer();
    player.body.parts.torso.bleeding = 20;

    sim.advanceSeconds(8);

    expect(player.alive).toBe(false);
    expect(sim.lastEvent('death')?.cause).toBe('bleed');
  });

  it('does real damage below the critical blood volume', () => {
    const sim = soloSim();
    const player = sim.addPlayer();
    player.blood = CRITICAL_BLOOD - 10;
    player.body.parts.torso.bleeding = 0;

    sim.advanceSeconds(20);

    expect(player.body.parts.torso.health).toBeLessThan(100);
    expect(LOW_BLOOD).toBeGreaterThan(CRITICAL_BLOOD);
  });

  it('rebuilds blood volume only when fed and watered', () => {
    const sim = soloSim();
    const fed = sim.addPlayer({ id: 'fed' });
    const starving = sim.addPlayer({ id: 'starving' });
    fed.blood = 70;
    fed.hunger = 0;
    fed.thirst = 0;
    starving.blood = 70;
    starving.hunger = 90;
    starving.thirst = 90;

    sim.advanceSeconds(60);

    expect(fed.blood).toBeGreaterThan(70);
    expect(starving.blood).toBeCloseTo(70, 5);
  });
});

// ---------------------------------------------------------------------------
// Infection
// ---------------------------------------------------------------------------

describe('infection', () => {
  it('climbs on an untreated wound and reports meaningful changes', () => {
    const sim = soloSim();
    const player = sim.addPlayer();
    player.body.parts.rightArm.infection = 1;
    sim.clearEvents();

    sim.advanceSeconds(120);

    expect(player.body.parts.rightArm.infection).toBeGreaterThan(5);
    const changes = sim.eventsOf('infectionChanged');
    expect(changes.length).toBeGreaterThan(0);
    // One event per 5-point step, not one per tick.
    expect(changes.length).toBeLessThan(10);
  });

  it('is reversed by the antibiotic effect', () => {
    const sim = soloSim();
    const treated = sim.addPlayer({ id: 'treated' });
    const untreated = sim.addPlayer({ id: 'untreated' });
    treated.body.parts.torso.infection = 40;
    untreated.body.parts.torso.infection = 40;
    addEffect(sim.ctx, treated, 'antibiotic', TICKS_PER_GAME_HOUR, 1);

    sim.advanceSeconds(60);

    expect(treated.body.parts.torso.infection).toBeLessThan(30);
    expect(untreated.body.parts.torso.infection).toBeGreaterThan(40);
  });

  it('raises a fever, then goes septic, then kills', () => {
    const sim = soloSim();
    const player = sim.addPlayer();
    player.body.parts.torso.infection = 34;

    sim.advanceSeconds(60);
    expect(player.effects.map((effect) => effect.id)).toContain('fever');

    player.body.parts.torso.infection = 99;
    sim.advanceSeconds(30);
    expect(player.effects.map((effect) => effect.id)).toContain('sepsis');
    expect(player.body.parts.torso.health).toBeLessThan(100);

    sim.advanceSeconds(200);
    expect(player.alive).toBe(false);
    expect(sim.lastEvent('death')?.cause).toBe('sepsis');
  });

  it('turns a bite that reaches 100 into a death by the bite itself', () => {
    const sim = soloSim();
    const player = sim.addPlayer();
    const part = player.body.parts.leftArm;
    part.bitten = true;
    part.infection = 99.5;

    sim.advanceSeconds(20);

    expect(player.alive).toBe(false);
    expect(sim.lastEvent('death')?.cause).toBe('zombieBite');
  });

  it('slows the climb while disinfectant is still on the wound', () => {
    const sim = soloSim();
    const guarded = sim.addPlayer({ id: 'guarded' });
    const open = sim.addPlayer({ id: 'open' });
    guarded.body.parts.torso.infection = 20;
    guarded.body.parts.torso.disinfectedTicks = TICKS_PER_GAME_HOUR;
    open.body.parts.torso.infection = 20;

    sim.advanceSeconds(120);

    expect(guarded.body.parts.torso.infection).toBeLessThan(open.body.parts.torso.infection);
  });

  it('fights infection worse when the player is starving', () => {
    const sim = soloSim();
    const fed = sim.addPlayer({ id: 'fed' });
    const starved = sim.addPlayer({ id: 'starved' });
    fed.body.parts.torso.infection = 10;
    fed.hunger = 10;
    starved.body.parts.torso.infection = 10;
    starved.hunger = 85;

    sim.advanceSeconds(120);

    expect(starved.body.parts.torso.infection).toBeGreaterThan(fed.body.parts.torso.infection);
  });
});

// ---------------------------------------------------------------------------
// Pain
// ---------------------------------------------------------------------------

describe('pain', () => {
  it('decays on its own, and far faster under painkillers', () => {
    const sim = soloSim();
    const dosed = sim.addPlayer({ id: 'dosed' });
    const sober = sim.addPlayer({ id: 'sober' });
    dosed.body.parts.torso.pain = 70;
    sober.body.parts.torso.pain = 70;
    addEffect(sim.ctx, dosed, 'painkiller', TICKS_PER_GAME_HOUR, 45);

    sim.advanceSeconds(20);

    expect(sober.body.parts.torso.pain).toBeLessThan(70);
    expect(dosed.body.parts.torso.pain).toBeLessThan(sober.body.parts.torso.pain - 5);
  });

  it('will not let an unsplinted fracture stop hurting', () => {
    const sim = soloSim();
    const unset = sim.addPlayer({ id: 'unset' });
    const splinted = sim.addPlayer({ id: 'splinted' });
    for (const player of [unset, splinted]) {
      player.body.parts.leftLeg.fractured = true;
      player.body.parts.leftLeg.pain = 90;
    }
    splinted.body.parts.leftLeg.splinted = true;

    sim.advanceSeconds(600);

    expect(unset.body.parts.leftLeg.pain).toBeGreaterThan(25);
    expect(splinted.body.parts.leftLeg.pain).toBeLessThan(unset.body.parts.leftLeg.pain);
  });

  it('blacks the player out when the pain is unbearable', () => {
    const sim = soloSim();
    const player = sim.addPlayer();

    let blackedOut = false;
    for (let i = 0; i < 600 && !blackedOut; i++) {
      // Hold the agony steady: the decay would otherwise drop it below the threshold
      // long before the per-second chance had a fair shot.
      for (const id of BODY_PART_IDS) player.body.parts[id].pain = 100;
      sim.step(1);
      blackedOut = player.actionLockedUntilTick > sim.sim.state.tick;
    }

    expect(totalPain(player.body)).toBeGreaterThanOrEqual(BLACKOUT_PAIN);
    expect(blackedOut).toBe(true);
    expect(sim.eventsOf('notification').some((event) => event.text.includes('whites'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Healing
// ---------------------------------------------------------------------------

describe('healing', () => {
  it('regrows tissue while rested, fed and watered', () => {
    const sim = soloSim();
    const player = restedPlayer(sim);
    player.body.parts.torso.health = 60;

    sim.advanceSeconds(120);

    expect(player.body.parts.torso.health).toBeGreaterThan(60);
    // Aggregate health is recomputed from the body, so it follows the part up.
    expect(player.health).toBeGreaterThan(86);
  });

  it('refuses to heal a starving player', () => {
    const sim = soloSim();
    const player = sim.addPlayer();
    player.hunger = 80;
    player.thirst = 0;
    player.body.parts.torso.health = 60;

    sim.advanceSeconds(60);

    expect(player.body.parts.torso.health).toBeLessThanOrEqual(60);
  });

  it('refuses to close a wound that is still bleeding', () => {
    const sim = soloSim();
    const player = restedPlayer(sim);
    player.body.parts.leftArm.health = 30;
    player.body.parts.leftArm.bleeding = 4;

    sim.advanceSeconds(60);

    expect(player.body.parts.leftArm.health).toBeCloseTo(30, 5);
  });

  it('mends a fracture only once it has been splinted', () => {
    const sim = soloSim();
    const splinted = sim.addPlayer({ id: 'splinted' });
    const unset = sim.addPlayer({ id: 'unset' });
    for (const player of [splinted, unset]) {
      player.hunger = 0;
      player.thirst = 0;
      player.fatigue = 0;
      const arm = player.body.parts.rightArm;
      arm.fractured = true;
      arm.health = arm.maxHealth - 1;
    }
    splinted.body.parts.rightArm.splinted = true;

    sim.step(1400);

    expect(splinted.body.parts.rightArm.fractured).toBe(false);
    expect(splinted.body.parts.rightArm.health).toBe(splinted.body.parts.rightArm.maxHealth);

    expect(unset.body.parts.rightArm.fractured).toBe(true);
    expect(unset.body.parts.rightArm.health).toBeCloseTo(
      unset.body.parts.rightArm.maxHealth - 1,
      5,
    );
  });
});

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

describe('conditions', () => {
  it('marks an overloaded player as overencumbered and drops it when they lighten', () => {
    const sim = soloSim();
    const player = sim.addPlayer();
    player.carryWeight = player.carryCapacity * 1.4;

    sim.step(2);
    expect(player.effects.map((effect) => effect.id)).toContain('overencumbered');

    player.carryWeight = 1;
    sim.step(2);
    expect(player.effects.map((effect) => effect.id)).not.toContain('overencumbered');
  });

  it('marks an exhausted player, and drains the stamina of a collapsing one', () => {
    const sim = soloSim();
    const player = sim.addPlayer();
    player.fatigue = 100;
    player.stamina = 100;

    sim.advanceSeconds(4);

    expect(player.effects.map((effect) => effect.id)).toContain('exhausted');
    expect(player.stamina).toBeLessThan(80);
  });

  it('expires timed effects on schedule', () => {
    const sim = soloSim();
    const player = sim.addPlayer();
    addEffect(sim.ctx, player, 'adrenaline', 40, 0.2);

    sim.step(20);
    expect(player.effects.map((effect) => effect.id)).toContain('adrenaline');

    sim.step(40);
    expect(player.effects.map((effect) => effect.id)).not.toContain('adrenaline');
    expect(sim.eventsOf('effectExpired').some((event) => event.effect === 'adrenaline')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Death
// ---------------------------------------------------------------------------

describe('death', () => {
  interface Cause {
    name: string;
    cause: string;
    ticks: number;
    setup: (sim: TestSimulation, player: PlayerState) => void;
  }

  const CAUSES: Cause[] = [
    {
      name: 'starvation',
      cause: 'starvation',
      ticks: 3000,
      setup: (_sim, player) => {
        player.hunger = 100;
        player.thirst = 0;
        player.fatigue = 0;
      },
    },
    {
      name: 'dehydration',
      cause: 'dehydration',
      ticks: 2000,
      setup: (_sim, player) => {
        player.thirst = 100;
        player.hunger = 0;
        player.fatigue = 0;
      },
    },
    {
      name: 'exhaustion',
      cause: 'exhaustion',
      ticks: 6400,
      setup: (_sim, player) => {
        player.fatigue = 100;
        player.hunger = 0;
        player.thirst = 0;
      },
    },
    {
      name: 'hypothermia',
      cause: 'hypothermia',
      ticks: 4000,
      setup: (sim, player) => {
        sim.sim.state.weather.temperature = -30;
        player.hunger = 0;
        player.thirst = 0;
        player.fatigue = 0;
      },
    },
    {
      name: 'blood loss',
      cause: 'bleed',
      ticks: 400,
      setup: (_sim, player) => {
        player.body.parts.torso.bleeding = 8;
      },
    },
    {
      name: 'a zombie bite',
      cause: 'zombieBite',
      ticks: 400,
      setup: (_sim, player) => {
        player.body.parts.leftLeg.bitten = true;
        player.body.parts.leftLeg.infection = 99;
      },
    },
  ];

  for (const entry of CAUSES) {
    it(`kills by ${entry.name}`, () => {
      const sim = soloSim();
      const player = sim.addPlayer();
      entry.setup(sim, player);

      sim.step(entry.ticks);

      expect(player.alive).toBe(false);
      expect(player.deathCause).toBe(entry.cause);
      expect(sim.lastEvent('death')?.cause).toBe(entry.cause);
      expect(player.deathTick).toBeGreaterThan(0);
      expect(player.respawnAtTick).toBeGreaterThan(player.deathTick);
    });
  }

  it('leaves a corpse alone: no needs, no healing, no further wounds', () => {
    const sim = soloSim();
    const player = sim.addPlayer();
    player.hunger = 100;
    killPlayer(sim.ctx, player, 'test');
    const torso = player.body.parts.torso.health;

    sim.step(400);

    expect(player.hunger).toBe(100);
    expect(player.body.parts.torso.health).toBe(torso);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  /** A script that touches every RNG-using path: sickness, wounds, treatment, pain. */
  function run(seed: number): { players: string; events: number } {
    const sim = seededSim(seed);
    const player = sim.addPlayer({ id: 'p1' });
    sim.giveItem(player, 'raw_meat', 4);
    sim.giveItem(player, 'bandage_dirty', 4);
    player.body.parts.leftArm.bleeding = 2.5;
    player.body.parts.leftArm.infection = 12;
    player.body.parts.rightLeg.fractured = true;
    player.body.parts.rightLeg.pain = 95;
    player.hunger = 70;
    player.thirst = 70;

    sim.run(player, { type: 'treat', ref: { kind: 'inventory' }, index: 1, bodyPart: 'leftArm' });
    sim.step(600);
    sim.run(player, { type: 'treat', ref: { kind: 'inventory' }, index: 1, bodyPart: 'leftArm' });
    sim.step(600);

    return {
      players: JSON.stringify(sim.sim.state.players),
      events: sim.events.length,
    };
  }

  it('produces identical state from an identical seed and script', () => {
    const a = run(4242);
    const b = run(4242);
    expect(a.players).toBe(b.players);
    expect(a.events).toBe(b.events);
  });

  it('produces different rolls from a different seed', () => {
    const a = run(4242);
    const c = run(99);
    expect(a.players).not.toBe(c.players);
  });
});
