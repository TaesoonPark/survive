import {
  BODY_PART_DAMAGE_MULTIPLIER,
  BODY_PART_HIT_WEIGHTS,
  BODY_PART_IDS,
  EQUIP_SLOTS,
  bodyHealthFraction,
  isFatalBody,
  type AnimalState,
  type BodyPartId,
  type BodyState,
  type DamageType,
  type EntityId,
  type EquipmentState,
  type PlayerState,
  type ResourceNodeState,
  type StructureState,
  type ZombieState,
} from '@survive/protocol';
import type { SimContext } from './context';
import { spendDurability } from './items';
import { addEffect } from './effects';
import { bump, findEntity, markDirtyAt, markStructureDirty } from './queries';

/**
 * The single damage pipeline.
 *
 * Everything that hurts anything goes through here: melee swings, bullets, zombie
 * bites, starvation, cold, falling structures. Concentrating it in one place is what
 * keeps armour, body-part multipliers, bleeding, fractures and death consistent no
 * matter which system pulled the trigger (spec section 6's resolution chain).
 */

export interface DamageSpec {
  /** Base damage before body part, armour, crit and tuning multipliers. */
  amount: number;
  type: DamageType;
  attackerId?: EntityId;
  /** Force the hit onto a specific body part. Omit to roll one by hit weight. */
  bodyPart?: BodyPartId;
  /** Fraction of armour ignored, 0..1. */
  armorPen?: number;
  critChance?: number;
  critMultiplier?: number;
  /** Impulse magnitude in px/second applied along `angle`. */
  knockback?: number;
  /** Direction of the blow in radians, used for knockback. */
  angle?: number;
  /** Scales the chance and severity of bleeding. 0 disables it. */
  bleedFactor?: number;
  /** Probability of a fracture on a blunt hit, 0..1. */
  fractureChance?: number;
  /** This hit is a bite: it can start an infection. */
  bite?: boolean;
  /** Overrides the configured infection chance for a bite. */
  infectionChance?: number;
  /** Skip armour entirely. Used by environmental damage. */
  ignoreArmor?: boolean;
  /** Suppress the `damage` event, e.g. for per-tick attrition that would spam. */
  silent?: boolean;
  /** Human-readable cause for the death screen. */
  cause?: string;
}

export interface DamageResult {
  /** Damage actually taken after every modifier. */
  applied: number;
  /** Damage absorbed by armour. */
  blocked: number;
  critical: boolean;
  bodyPart?: BodyPartId;
  killed: boolean;
}

const NO_DAMAGE: DamageResult = { applied: 0, blocked: 0, critical: false, killed: false };

/** Damage types that armour can meaningfully stop. */
const PHYSICAL: readonly DamageType[] = [
  'blunt',
  'slash',
  'pierce',
  'bullet',
  'explosive',
  'zombieBite',
];

/** Damage types that come from inside the body and bypass gear entirely. */
const INTERNAL: readonly DamageType[] = [
  'bleed',
  'infection',
  'starvation',
  'dehydration',
  'exhaustion',
  'poison',
  'suffocation',
];

export function isPhysical(type: DamageType): boolean {
  return PHYSICAL.includes(type);
}

export function isInternal(type: DamageType): boolean {
  return INTERNAL.includes(type);
}

/** Pick a body part by hit weight. Deterministic through the seeded RNG. */
export function rollBodyPart(ctx: SimContext, label = 'hit'): BodyPartId {
  const rng = ctx.rng.fork(`bodypart:${label}:${ctx.state.tick}`);
  const picked = rng.pickWeighted(BODY_PART_IDS, (id) => BODY_PART_HIT_WEIGHTS[id]);
  return picked ?? 'torso';
}

/**
 * Total armour value protecting a body part against a damage type.
 *
 * Coverage is probabilistic in intent but resolved deterministically here as a linear
 * weight: a vest covering 80% of the torso gives 80% of its protection value. That
 * reads better in play than a coin flip between "full stop" and "nothing".
 */
export function armorAt(
  ctx: SimContext,
  equipment: EquipmentState,
  part: BodyPartId,
  type: DamageType,
): number {
  let total = 0;
  for (const slot of EQUIP_SLOTS) {
    const stack = equipment[slot];
    if (!stack) continue;
    const def = ctx.data.items.get(stack.defId);
    const armor = def?.armor;
    if (!armor) continue;
    const coverage = armor.coverage[part];
    if (!coverage) continue;
    const protection = armor.protection[type] ?? 0;
    if (protection <= 0) continue;
    // Worn armour protects less.
    const condition =
      stack.durability !== undefined && def?.maxDurability
        ? 0.35 + 0.65 * Math.max(0, Math.min(1, stack.durability / def.maxDurability))
        : 1;
    total += protection * coverage * condition;
  }
  return total;
}

/** Wear the armour pieces that covered a hit. */
function wearArmor(
  ctx: SimContext,
  equipment: EquipmentState,
  part: BodyPartId,
  owner: { rev: number },
): void {
  for (const slot of EQUIP_SLOTS) {
    const stack = equipment[slot];
    if (!stack) continue;
    const def = ctx.data.items.get(stack.defId);
    const armor = def?.armor;
    if (!armor) continue;
    if (!armor.coverage[part]) continue;
    if (spendDurability(stack, armor.durabilityPerHit)) {
      equipment[slot] = null;
      owner.rev++;
      ctx.events.emit({
        type: 'weaponBroke',
        ownerId: (owner as { id?: string }).id ?? '',
        defId: stack.defId,
      });
    }
  }
}

/**
 * Apply damage to one body part of a body, handling bleeding, fractures and bites.
 * Shared by players and zombies, both of which carry a full {@link BodyState}.
 */
function damageBodyPart(
  ctx: SimContext,
  entityId: EntityId,
  body: BodyState,
  part: BodyPartId,
  amount: number,
  spec: DamageSpec,
): number {
  const target = body.parts[part];
  const before = target.health;
  target.health = Math.max(0, target.health - amount);
  const dealt = before - target.health;

  // Pain scales with the fraction of the part destroyed, so a graze on a healthy limb
  // hurts far less than the blow that finishes it off.
  const severity = target.maxHealth > 0 ? dealt / target.maxHealth : 0;
  target.pain = Math.min(100, target.pain + severity * 100 * 0.8);

  const rng = ctx.rng.fork(`wound:${entityId}:${ctx.state.tick}:${part}`);

  const bleedFactor = spec.bleedFactor ?? bleedFactorFor(spec.type);
  if (bleedFactor > 0 && dealt > 0) {
    const bleedChance = Math.min(0.95, severity * 2.2 * bleedFactor);
    if (rng.chance(bleedChance)) {
      const rate = Math.max(0.05, severity * 3 * bleedFactor);
      const wasBleeding = target.bleeding > 0;
      target.bleeding = Math.min(12, target.bleeding + rate);
      target.bandaged = false;
      if (!wasBleeding) {
        ctx.events.emit({
          type: 'bleedingStarted',
          entityId,
          bodyPart: part,
          rate: target.bleeding,
        });
      }
    }
  }

  const fractureChance = spec.fractureChance ?? fractureChanceFor(spec.type);
  if (!target.fractured && fractureChance > 0 && severity > 0.18) {
    if (rng.chance(Math.min(0.6, severity * fractureChance * 3))) {
      target.fractured = true;
      target.splinted = false;
      target.pain = Math.min(100, target.pain + 25);
      ctx.events.emit({ type: 'fractured', entityId, bodyPart: part });
    }
  }

  if (spec.type === 'fire' && dealt > 0) {
    target.burned = Math.min(100, target.burned + severity * 80);
  }

  if (spec.bite && dealt > 0) {
    target.bitten = true;
    ctx.events.emit({ type: 'bitten', entityId, bodyPart: part });
    const chance = spec.infectionChance ?? ctx.config.tuning.infectionChance;
    // A clean, protected wound is far less likely to go septic.
    const guarded = target.disinfectedTicks > 0 ? 0.35 : 1;
    if (rng.chance(chance * guarded)) {
      target.infection = Math.max(target.infection, 1);
      ctx.events.emit({
        type: 'infectionChanged',
        entityId,
        bodyPart: part,
        value: target.infection,
      });
    }
  }

  return dealt;
}

function bleedFactorFor(type: DamageType): number {
  switch (type) {
    case 'slash':
      return 1.4;
    case 'pierce':
      return 1.1;
    case 'bullet':
      return 1.3;
    case 'zombieBite':
      return 1;
    case 'explosive':
      return 1.2;
    case 'blunt':
      return 0.3;
    default:
      return 0;
  }
}

function fractureChanceFor(type: DamageType): number {
  switch (type) {
    case 'blunt':
      return 0.9;
    case 'explosive':
      return 0.7;
    case 'fall':
      return 1.2;
    case 'bullet':
      return 0.3;
    default:
      return 0.05;
  }
}

/** Recompute aggregate health from the body, and report whether it is fatal. */
export function syncHealthFromBody(entity: {
  health: number;
  maxHealth: number;
  body: BodyState;
}): boolean {
  entity.health = Math.round(bodyHealthFraction(entity.body) * entity.maxHealth);
  return isFatalBody(entity.body) || entity.health <= 0;
}

// ---------------------------------------------------------------------------
// Per-target entry points
// ---------------------------------------------------------------------------

export function damagePlayer(ctx: SimContext, player: PlayerState, spec: DamageSpec): DamageResult {
  if (!player.alive || spec.amount <= 0) return NO_DAMAGE;

  const part = spec.bodyPart ?? rollBodyPart(ctx, player.id);
  const rng = ctx.rng.fork(`crit:${player.id}:${ctx.state.tick}`);
  const critical = (spec.critChance ?? 0) > 0 && rng.chance(spec.critChance ?? 0);

  let amount = spec.amount * ctx.config.tuning.playerDamageTaken;
  amount *= BODY_PART_DAMAGE_MULTIPLIER[part];
  if (critical) amount *= spec.critMultiplier ?? 1.5;

  let blocked = 0;
  if (!spec.ignoreArmor && isPhysical(spec.type)) {
    const armor = armorAt(ctx, player.equipment, part, spec.type);
    const effective = armor * (1 - Math.min(1, spec.armorPen ?? 0));
    blocked = Math.min(amount * 0.9, effective);
    amount -= blocked;
    if (blocked > 0) wearArmor(ctx, player.equipment, part, player);
  }

  const applied = damageBodyPart(ctx, player.id, player.body, part, amount, spec);
  const fatal = syncHealthFromBody(player);

  if (spec.knockback && spec.knockback > 0) {
    const angle = spec.angle ?? 0;
    player.vx += Math.cos(angle) * spec.knockback;
    player.vy += Math.sin(angle) * spec.knockback;
    ctx.events.emit({ type: 'knockback', entityId: player.id, vx: player.vx, vy: player.vy });
  }

  // A hard hit interrupts whatever the player was doing.
  if (applied > 8) {
    player.actionLockedUntilTick = Math.max(player.actionLockedUntilTick, ctx.state.tick + 3);
    addEffect(ctx, player, 'bleeding', 1, 0);
  }

  bump(player);

  if (!spec.silent) {
    ctx.events.emit({
      type: 'damage',
      targetId: player.id,
      ...(spec.attackerId ? { attackerId: spec.attackerId } : {}),
      amount: applied,
      damageType: spec.type,
      bodyPart: part,
      critical,
      blocked,
      x: player.x,
      y: player.y,
      remainingHealth: player.health,
    });
  }

  return { applied, blocked, critical, bodyPart: part, killed: fatal };
}

export function damageZombie(ctx: SimContext, zombie: ZombieState, spec: DamageSpec): DamageResult {
  if (zombie.ai === 'dead' || spec.amount <= 0) return NO_DAMAGE;
  const def = ctx.data.zombies.get(zombie.defId);

  const part = spec.bodyPart ?? rollBodyPart(ctx, zombie.id);
  const rng = ctx.rng.fork(`crit:${zombie.id}:${ctx.state.tick}`);
  const critical = (spec.critChance ?? 0) > 0 && rng.chance(spec.critChance ?? 0);

  let amount = spec.amount;
  if (spec.attackerId && ctx.state.players[spec.attackerId]) {
    amount *= ctx.config.tuning.playerDamageDealt;
  }
  amount *= BODY_PART_DAMAGE_MULTIPLIER[part];
  if (critical) amount *= spec.critMultiplier ?? 1.5;

  let blocked = 0;
  const armor = def?.armor?.[spec.type] ?? 0;
  if (!spec.ignoreArmor && armor > 0) {
    const effective = armor * (1 - Math.min(1, spec.armorPen ?? 0));
    blocked = Math.min(amount * 0.9, effective);
    amount -= blocked;
  }

  const applied = damageBodyPart(ctx, zombie.id, zombie.body, part, amount, spec);
  const fatal = syncHealthFromBody(zombie);

  // Shoot the legs out and the zombie keeps coming, just on its elbows.
  if (!zombie.crawling) {
    const legs = zombie.body.parts;
    if (legs.leftLeg.health <= 0 && legs.rightLeg.health <= 0) {
      zombie.crawling = true;
    }
  }

  const staggerResist = def?.staggerResist ?? 0;
  if (applied > 0 && staggerResist < 1) {
    const severity = applied / Math.max(1, zombie.maxHealth);
    if (severity > 0.08 * (1 + staggerResist * 4)) {
      const staggerTicks = Math.round(4 + severity * 20 * (1 - staggerResist));
      zombie.staggerUntilTick = Math.max(zombie.staggerUntilTick, ctx.state.tick + staggerTicks);
      if (zombie.ai !== 'attack') zombie.ai = 'stagger';
    }
  }

  if (spec.knockback && spec.knockback > 0) {
    const angle = spec.angle ?? 0;
    const resist = 1 - staggerResist * 0.7;
    zombie.vx += Math.cos(angle) * spec.knockback * resist;
    zombie.vy += Math.sin(angle) * spec.knockback * resist;
  }

  // Being hit is the loudest possible aggro signal.
  if (spec.attackerId && zombie.ai !== 'pursue' && zombie.ai !== 'attack') {
    zombie.targetId = spec.attackerId;
    const attacker = ctx.state.players[spec.attackerId];
    if (attacker) {
      zombie.lastSeenX = attacker.x;
      zombie.lastSeenY = attacker.y;
    }
    zombie.ai = 'pursue';
    zombie.nextThinkTick = ctx.state.tick;
    zombie.loseInterestTick = ctx.state.tick + (def?.loseInterestTicks ?? 200);
  }

  bump(zombie);

  if (!spec.silent) {
    ctx.events.emit({
      type: 'damage',
      targetId: zombie.id,
      ...(spec.attackerId ? { attackerId: spec.attackerId } : {}),
      amount: applied,
      damageType: spec.type,
      bodyPart: part,
      critical,
      blocked,
      x: zombie.x,
      y: zombie.y,
      remainingHealth: zombie.health,
    });
  }

  return { applied, blocked, critical, bodyPart: part, killed: fatal };
}

export function damageAnimal(ctx: SimContext, animal: AnimalState, spec: DamageSpec): DamageResult {
  if (animal.ai === 'dead' || spec.amount <= 0) return NO_DAMAGE;
  const rng = ctx.rng.fork(`crit:${animal.id}:${ctx.state.tick}`);
  const critical = (spec.critChance ?? 0) > 0 && rng.chance(spec.critChance ?? 0);

  let amount = spec.amount;
  if (spec.attackerId && ctx.state.players[spec.attackerId]) {
    amount *= ctx.config.tuning.playerDamageDealt;
  }
  if (critical) amount *= spec.critMultiplier ?? 1.5;

  const before = animal.health;
  animal.health = Math.max(0, animal.health - amount);
  const applied = before - animal.health;

  if (spec.knockback && spec.knockback > 0) {
    const angle = spec.angle ?? 0;
    animal.vx += Math.cos(angle) * spec.knockback;
    animal.vy += Math.sin(angle) * spec.knockback;
  }

  const def = ctx.data.animals.get(animal.defId);
  if (animal.health > 0) {
    // Anything that gets hit either runs or fights, depending on temperament.
    if (def?.behavior === 'aggressive' || def?.behavior === 'territorial') {
      animal.ai = 'attack';
      if (spec.attackerId) animal.targetId = spec.attackerId;
    } else {
      animal.ai = 'flee';
      animal.fleeUntilTick = ctx.state.tick + 200;
    }
    animal.nextThinkTick = ctx.state.tick;
  }

  bump(animal);

  if (!spec.silent) {
    ctx.events.emit({
      type: 'damage',
      targetId: animal.id,
      ...(spec.attackerId ? { attackerId: spec.attackerId } : {}),
      amount: applied,
      damageType: spec.type,
      critical,
      blocked: 0,
      x: animal.x,
      y: animal.y,
      remainingHealth: animal.health,
    });
  }

  return { applied, blocked: 0, critical, killed: animal.health <= 0 };
}

export function damageStructure(
  ctx: SimContext,
  structure: StructureState,
  spec: DamageSpec,
): DamageResult {
  const def = ctx.data.structures.get(structure.defId);
  if (!def?.destructible || spec.amount <= 0) return NO_DAMAGE;

  let amount = spec.amount;
  // Zombies pounding on a door do the damage the definition says they do.
  if (spec.attackerId && ctx.state.zombies[spec.attackerId]) {
    amount *= def.zombieDamageMultiplier;
  }
  // Structures shrug off cuts and bullets but not sledgehammers and explosives.
  switch (spec.type) {
    case 'slash':
    case 'pierce':
      amount *= 0.35;
      break;
    case 'bullet':
      amount *= 0.5;
      break;
    case 'explosive':
      amount *= 2;
      break;
    default:
      break;
  }

  const before = structure.health;
  structure.health = Math.max(0, structure.health - amount);
  const applied = before - structure.health;
  bump(structure);
  markStructureDirty(ctx.state, structure);

  ctx.events.emit({
    type: 'structureDamaged',
    structureId: structure.id,
    amount: applied,
    remainingHealth: structure.health,
  });

  return { applied, blocked: 0, critical: false, killed: structure.health <= 0 };
}

export function damageNode(
  ctx: SimContext,
  node: ResourceNodeState,
  spec: DamageSpec,
): DamageResult {
  if (node.depleted || spec.amount <= 0) return NO_DAMAGE;
  const before = node.health;
  node.health = Math.max(0, node.health - spec.amount);
  const applied = before - node.health;
  bump(node);
  markDirtyAt(ctx.state, node.x, node.y);
  return { applied, blocked: 0, critical: false, killed: node.health <= 0 };
}

/**
 * Damage whatever the id refers to.
 *
 * Returns `killed: true` when the target reached zero health; the caller is expected
 * to follow up with {@link killEntity} from `./death`, which handles loot, XP and the
 * death event.
 */
export function applyDamage(ctx: SimContext, targetId: EntityId, spec: DamageSpec): DamageResult {
  const found = findEntity(ctx.state, targetId);
  if (!found) return NO_DAMAGE;
  switch (found.kind) {
    case 'player':
      return damagePlayer(ctx, found.entity, spec);
    case 'zombie':
      return damageZombie(ctx, found.entity, spec);
    case 'animal':
      return damageAnimal(ctx, found.entity, spec);
    case 'structure':
      return damageStructure(ctx, found.entity, spec);
    case 'node':
      return damageNode(ctx, found.entity, spec);
    default:
      return NO_DAMAGE;
  }
}
