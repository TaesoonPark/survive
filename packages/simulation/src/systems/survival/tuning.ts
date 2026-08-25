import { SIM_DT, TICKS_PER_GAME_DAY, TICKS_PER_GAME_HOUR, TILE_SIZE } from '@survive/protocol';

/**
 * Every number the survival system leans on, in one place.
 *
 * Two conventions keep these comparable with each other and with the content tables:
 *
 * - **Rates are per second of simulated time**, and the system multiplies by
 *   `ctx.clock.dt`. Writing "0.8 hp/second" is reviewable; writing "0.04 per tick"
 *   is not, and it silently breaks if `SIM_HZ` is ever retuned.
 * - **Need rates are derived from how long the arc should take**, not typed in as
 *   magic decimals. `HUNGER_DAYS_TO_CRITICAL = 2.5` is a design decision; the
 *   resulting 0.0278 points/second is arithmetic.
 *
 * One in-game day is {@link TICKS_PER_GAME_DAY} ticks, which at the shipped clock is
 * 24 real minutes, so `SECONDS_PER_GAME_DAY` below is 1440.
 */

/** Real seconds in one in-game day. The denominator of every need arc. */
export const SECONDS_PER_GAME_DAY = TICKS_PER_GAME_DAY * SIM_DT;

/** Real seconds in one in-game hour. */
export const SECONDS_PER_GAME_HOUR = TICKS_PER_GAME_HOUR * SIM_DT;

// ---------------------------------------------------------------------------
// Needs
// ---------------------------------------------------------------------------

/** In-game days from a full stomach to `hunger === 100`. */
export const HUNGER_DAYS_TO_CRITICAL = 2.5;
/** Thirst runs at twice the pace of hunger: water is the daily problem, food the weekly one. */
export const THIRST_DAYS_TO_CRITICAL = HUNGER_DAYS_TO_CRITICAL / 2;
/** In-game hours awake before `fatigue === 100`. */
export const FATIGUE_HOURS_TO_CRITICAL = 20;
/** In-game hours of undisturbed sleep to go from `fatigue === 100` to rested. */
export const FATIGUE_SLEEP_HOURS = 6;

export const HUNGER_PER_SECOND = 100 / (HUNGER_DAYS_TO_CRITICAL * SECONDS_PER_GAME_DAY);
export const THIRST_PER_SECOND = 100 / (THIRST_DAYS_TO_CRITICAL * SECONDS_PER_GAME_DAY);
export const FATIGUE_PER_SECOND = 100 / (FATIGUE_HOURS_TO_CRITICAL * SECONDS_PER_GAME_HOUR);
export const FATIGUE_RECOVERY_PER_SECOND = 100 / (FATIGUE_SLEEP_HOURS * SECONDS_PER_GAME_HOUR);

/** Sprinting burns through food, water and stamina far faster than strolling. */
export const SPRINT_NEED_SCALE = 1.8;
/** Walking is only slightly worse than standing still. */
export const WALK_NEED_SCALE = 1.15;
/** Crouch-walking is slow and quiet, and cheap. */
export const CROUCH_NEED_SCALE = 1.05;

/** Needs still tick while asleep, at this fraction of the waking rate. */
export const SLEEP_NEED_SCALE = 0.55;

/** Shivering burns calories: hunger rises faster the further below comfort you are. */
export const COLD_HUNGER_SCALE = 0.6;
/** Sweating costs water: thirst rises faster the further above comfort you are. */
export const HOT_THIRST_SCALE = 0.9;

/** A fever cooks water out of you. */
export const FEVER_THIRST_SCALE = 1.6;
/** Gut illness dehydrates hard and spoils the appetite. */
export const ILLNESS_THIRST_SCALE = 1.8;
export const ILLNESS_HUNGER_SCALE = 1.3;
/** Health lost per second to a gut illness. */
export const ILLNESS_DAMAGE_PER_SECOND = 0.14;

/** Need levels that earn the player a warning, in rising order of alarm. */
export const NEED_WARN = 50;
export const NEED_URGENT = 80;
export const NEED_CRITICAL = 100;

/** Health lost per second at `hunger === 100`. */
export const STARVATION_DAMAGE_PER_SECOND = 0.8;
/** Dehydration kills faster than starvation, as it does in life. */
export const DEHYDRATION_DAMAGE_PER_SECOND = 1.2;
/** Collapse from exhaustion is slow, and mostly a mobility problem. */
export const EXHAUSTION_DAMAGE_PER_SECOND = 0.35;
/** Stamina drained per second once fatigue is critical: you simply cannot run. */
export const EXHAUSTION_STAMINA_PER_SECOND = 8;

/** Fatigue at which the `exhausted` condition applies. */
export const EXHAUSTED_THRESHOLD = 75;

// ---------------------------------------------------------------------------
// Temperature
// ---------------------------------------------------------------------------

/** Normal core temperature, in degrees Celsius. */
export const CORE_TEMPERATURE = 37;

/**
 * Ambient temperature a clothed, dry, idle human is comfortable at. Effective
 * ambient above or below this pulls core temperature off 37 proportionally.
 */
export const COMFORT_AMBIENT = 20;

/**
 * Degrees of core temperature shift per degree of effective-ambient deviation.
 *
 * The body is a good regulator, so this is far below 1: it takes a 30-degree
 * shortfall in effective ambient to drag the core down into hypothermia.
 */
export const TEMP_SENSITIVITY = 0.17;

/**
 * Insulation is worth slightly more than its face value in degrees, because a
 * full outfit also blocks wind and holds body heat in. 22 points of leather is
 * enough to shrug off a hard winter; a shirt and jeans is not.
 */
export const WARMTH_SCALE = 1.35;

/** A fire's `heat` is worth this much effective ambient at zero distance. */
export const FIRE_WARMTH_SCALE = 2;
/** How far to look for a fire, in pixels. */
export const FIRE_SEARCH_RADIUS = TILE_SIZE * 10;
/** Fallback warm radius for a lit structure that declares no light radius. */
export const FIRE_DEFAULT_RADIUS = TILE_SIZE * 5;
/** Heat credited to a lit structure that only declares a light, e.g. a wall torch. */
export const LIGHT_ONLY_HEAT = 3;

/** Effective ambient added by working hard, in degrees. */
export const SPRINT_WARMTH = 4;
export const WALK_WARMTH = 1.5;

/** Effective ambient removed by being soaked through. */
export const WET_CHILL = 14;
/** Wetness gained per second while standing in the rain or in water, 0..1. */
export const WET_GAIN_PER_SECOND = 0.05;
/** Wetness lost per second once out of the water. */
export const WET_DRY_PER_SECOND = 0.012;
/** Multiplier on drying speed next to a fire, per point of effective fire heat. */
export const WET_FIRE_DRY_SCALE = 0.35;
/** Wetness contribution of standing in shallow / deep water. */
export const WET_SHALLOW = 0.6;
export const WET_DEEP = 1;
/**
 * Wetness below which a drying player counts as dry.
 *
 * Only applied while *drying*. A player who has just stepped into the rain starts at
 * zero and gains {@link WET_GAIN_PER_SECOND} times one timestep - far below this - so
 * snapping on the way up as well would mean nobody ever got wet at all.
 */
export const WET_FLOOR = 0.02;

/** Seconds for core temperature to close ~63% of the gap to its target. */
export const TEMP_TAU_SECONDS = 20;

/** Below this the player is `cold`. */
export const COLD_THRESHOLD = 36;
/** Below this the player is `hypothermic`. */
export const HYPOTHERMIA_THRESHOLD = 34.5;
/** Below this hypothermia starts doing real damage. */
export const FREEZING_THRESHOLD = 32.5;
/** Above this the player is `hot`. */
export const HOT_THRESHOLD = 38.2;
/** Above this the player has `heatstroke`. */
export const HEATSTROKE_THRESHOLD = 39.5;
/** Above this heatstroke starts doing real damage. */
export const BURNING_THRESHOLD = 41;

/** Health lost per second, per degree below {@link FREEZING_THRESHOLD}. */
export const COLD_DAMAGE_PER_DEGREE_SECOND = 0.5;
/** Health lost per second, per degree above {@link BURNING_THRESHOLD}. */
export const HEAT_DAMAGE_PER_DEGREE_SECOND = 0.6;

/** A fever pushes the core temperature target up by this much. */
export const FEVER_TEMPERATURE_PUSH = 1.6;

// ---------------------------------------------------------------------------
// Bleeding and blood
// ---------------------------------------------------------------------------

/** Blood units drained per second, per point of a part's `bleeding` rate. */
export const BLOOD_LOSS_SCALE = 1;
/** A wound this small will clot on its own. */
export const MINOR_BLEED_CAP = 1;
/** Bleed rate lost per second while clotting. */
export const BLEED_CLOT_PER_SECOND = 0.015;
/** Clotting multiplier for a dressed wound; a bandage is mostly a clotting aid. */
export const BANDAGED_CLOT_SCALE = 4;
/** Clotting multiplier for a stitched wound. */
export const STITCHED_CLOT_SCALE = 8;

/** Below this blood volume the screen greys out and the player is visibly failing. */
export const LOW_BLOOD = 60;
/** Below this blood volume organs start to fail. */
export const CRITICAL_BLOOD = 35;
/** Health lost per second, per point of blood below {@link CRITICAL_BLOOD}. */
export const BLOOD_LOSS_DAMAGE_PER_SECOND = 0.03;
/** Blood regenerated per second while fed, watered and not bleeding. */
export const BLOOD_REGEN_PER_SECOND = 0.05;
/** Blood regeneration needs hunger and thirst below this. */
export const BLOOD_REGEN_NEED_MAX = 55;

// ---------------------------------------------------------------------------
// Infection
// ---------------------------------------------------------------------------

/** Infection points gained per second by an untreated, open, infected wound. */
export const INFECTION_PER_SECOND = 0.05;
/** An open (undressed) wound is worse than a clean dressing. */
export const INFECTION_OPEN_SCALE = 1.3;
/**
 * Dressing multiplier as a function of bandage cleanliness: a sterile dressing at
 * cleanliness 1 gives 0.4, a filthy rag at 0.15 gives ~2.0.
 */
export const INFECTION_BANDAGE_BASE = 2.2;
export const INFECTION_BANDAGE_PER_CLEANLINESS = 1.8;
/** Stitching closes the wound, which halves what gets in. */
export const INFECTION_STITCHED_SCALE = 0.5;
/** Active disinfectant on the wound itself. */
export const INFECTION_DISINFECTED_SCALE = 0.25;
/** The `antiseptic` status effect, from a swig of moonshine or a bottle of the stuff. */
export const INFECTION_ANTISEPTIC_SCALE = 0.6;
/** Being starved or parched leaves nothing for the immune system to fight with. */
export const INFECTION_MALNOURISHED_SCALE = 1.35;
export const INFECTION_MALNOURISHED_NEED = 70;
/** Infection points *removed* per second while the `antibiotic` effect holds. */
export const ANTIBIOTIC_CURE_PER_SECOND = 0.25;

/** Emit `infectionChanged` when the value crosses a multiple of this. */
export const INFECTION_EVENT_STEP = 5;

/** Infection at which the wound produces a fever. */
export const FEVER_THRESHOLD = 35;
/** Infection at which the infection is systemic. */
export const SEPSIS_THRESHOLD = 70;
/** Health lost per second, per point of infection above {@link SEPSIS_THRESHOLD}. */
export const SEPSIS_DAMAGE_PER_SECOND = 0.02;
/** A zombie bite past this point is visibly turning. */
export const ZOMBIFICATION_THRESHOLD = 85;

/** Chance a bandage below {@link DIRTY_BANDAGE_CLEANLINESS} seeds an infection. */
export const DIRTY_BANDAGE_INFECT_CHANCE = 0.75;
/** Cleanliness below which a dressing counts as dirty. */
export const DIRTY_BANDAGE_CLEANLINESS = 0.5;
/** Infection seeded by a dirty dressing. */
export const DIRTY_BANDAGE_SEED = 6;
/** Ticks of disinfectant protection granted by a `disinfect` item. */
export const DISINFECT_PROTECTION_TICKS = TICKS_PER_GAME_HOUR * 8;

// ---------------------------------------------------------------------------
// Pain
// ---------------------------------------------------------------------------

/** Pain points a part sheds per second on its own. */
export const PAIN_DECAY_PER_SECOND = 0.35;
/** Painkiller magnitude 45 roughly triples that; morphine at 95 is ~5x. */
export const PAINKILLER_DECAY_SCALE = 1 / 22;
/** An unsplinted fracture will not stop hurting, however long you wait. */
export const FRACTURE_PAIN_FLOOR = 30;
/** A splinted fracture aches instead of screaming. */
export const SPLINTED_PAIN_FLOOR = 10;

/** Aggregate pain above which a blackout becomes possible. */
export const BLACKOUT_PAIN = 85;
/** Chance per second of blacking out at maximum pain. */
export const BLACKOUT_CHANCE_PER_SECOND = 0.05;
/** How long a blackout locks the player out of acting, in seconds. */
export const BLACKOUT_SECONDS = 1.5;

// ---------------------------------------------------------------------------
// Healing
// ---------------------------------------------------------------------------

/** Body-part health regained per second while resting, fed and uninfected. */
export const HEAL_PER_SECOND = 0.06;
/** Healing needs hunger and thirst below this: the body rebuilds from surplus. */
export const HEAL_NEED_MAX = 45;
/** Sleeping is when the body actually does the work. */
export const SLEEP_HEAL_SCALE = 4;
/** Blood below this stalls healing; there is nothing to carry the repairs. */
export const HEAL_BLOOD_MIN = 40;
/** Fraction of max stamina that counts as "at rest" when no input frame is available. */
export const REST_STAMINA_FRACTION = 0.75;
/** Burn severity shed per second. Burns are slow. */
export const BURN_HEAL_PER_SECOND = 0.04;

// ---------------------------------------------------------------------------
// Eating, drinking and medicine
// ---------------------------------------------------------------------------

/** Freshness below which food counts as spoiled. */
export const SPOILED_FRESHNESS = 0.3;
/** Extra sickness chance added on top of the item's own when it has gone off. */
export const SPOILED_SICKNESS_BONUS = 0.4;
/** How long a gut illness lasts. */
export const SICKNESS_TICKS = TICKS_PER_GAME_HOUR * 4;

/** Eating down to this hunger earns the `well_fed` bonus. */
export const WELL_FED_HUNGER = 12;
export const WELL_FED_TICKS = TICKS_PER_GAME_HOUR * 3;
/** Drinking down to this thirst earns the `hydrated` bonus. */
export const HYDRATED_THIRST = 12;
export const HYDRATED_TICKS = TICKS_PER_GAME_HOUR * 3;

/** Chance of botching a treatment, per level of medicine skill the player lacks. */
export const FUMBLE_PER_MISSING_LEVEL = 0.2;
/** Worst possible botch chance: even a total novice gets it right sometimes. */
export const FUMBLE_MAX_CHANCE = 0.6;
/** Pain added to the part by a botched treatment. */
export const FUMBLE_PAIN = 12;
/** Base medicine XP for a successful treatment, before the item's difficulty. */
export const TREAT_XP = 4;
/** Extra medicine XP per level of skill the item nominally requires. */
export const TREAT_XP_PER_SKILL = 2;

// ---------------------------------------------------------------------------
// Sleep
// ---------------------------------------------------------------------------

/** How close, in pixels, a player must be to a bed to lie down in it. */
export const SLEEP_REACH = TILE_SIZE * 2;
/**
 * Extra recovery a single-player sleeper gets.
 *
 * The simulation never touches its own clock, so "sleep through the night" is
 * expressed as accelerated recovery for the sleeper rather than by fast-forwarding
 * the world: a host that wants literal fast-forward steps the simulation faster,
 * which is a server-loop concern and keeps single-player and multiplayer running
 * the identical rule set (Architecture Guard rules 5 and 8).
 */
export const SINGLE_PLAYER_SLEEP_SCALE = 6;
/** A zombie inside this radius wakes a sleeper. */
export const SLEEP_THREAT_RADIUS = TILE_SIZE * 8;

/**
 * What a night in a bed is worth beyond the fatigue it sheds.
 *
 * `well_rested` slows the *next* day's fatigue accumulation (see `needs.ts`), so it is
 * the mechanical reason to sleep properly rather than to doze until the exhaustion
 * damage stops. Both halves of "a night" are required - long enough to be one, and
 * ending actually rested - because either alone is farmable: a sleeper who lies down
 * already fresh would collect it instantly, and one who naps for a second at a time
 * would collect it repeatedly.
 */
export const WELL_RESTED_FATIGUE = 20;
/** Sleep shorter than this is a doze, whatever it did to the numbers. */
export const WELL_RESTED_MIN_SLEEP_TICKS = TICKS_PER_GAME_HOUR / 4;
/** How long the bonus lasts after waking. */
export const WELL_RESTED_TICKS = TICKS_PER_GAME_HOUR * 4;
/**
 * Fraction of the fatigue rate a rested player avoids. Deliberately a shade above
 * coffee's 0.35: a bed should beat a cup of stale grounds.
 */
export const WELL_RESTED_MAGNITUDE = 0.4;
