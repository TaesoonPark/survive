import {
  Button,
  SIM_HZ,
  angleBetween,
  armCapabilityMultiplier,
  distanceSq,
  hasButton,
  withinCone,
  type EntityId,
  type InputFrame,
  type ItemDefId,
  type ItemStack,
  type PlayerId,
  type PlayerState,
} from '@survive/protocol';
import type { WeaponProps } from '@survive/game-data';
import { SystemOrder, type SimContext, type System } from '../../core/context';
import {
  addToInventory,
  createStack,
  recomputeCarryWeight,
  removeFromInventory,
} from '../../core/items';
import { dropStack } from '../../core/loot';
import { emitNoise } from '../../core/noise';
import { bump, findEntity, isDamageable } from '../../core/queries';
import { grantXp, skillCostMultiplier } from '../../core/skills';
import { isGuarding, resolveIncomingAttack } from './blocking';
import { hitStructure } from './impact';
import { applyNodeHit, type MeleeSwing, type NodeHitResolver } from './nodes';
import { spawnProjectile } from './projectiles';
import {
  arcHalfAngle,
  attackCooldownTicks,
  countAmmo,
  effectiveCritChance,
  isAutoFire,
  resolveWeapon,
  staminaCostFor,
  swingDamage,
  wearEquipped,
  type ResolvedWeapon,
} from './weapons';

/**
 * The whole fight.
 *
 * Attacks are driven by the continuous input frame rather than by a command, because an
 * attack is a *held button at an aim angle* and the server has to consume it at exactly
 * the rate the client produced it or client-side prediction of the swing cooldown
 * drifts. Commands are used only for the discrete decisions - reloading - where the
 * client is asking for something rather than reporting a button state.
 *
 * Everything a client sends is treated as a claim: the aim angle is used, but the
 * target, the damage, the range, the cooldown, the stamina and the ammunition are all
 * decided here.
 */

/** Ticks of enforced pause after an attack refused for want of stamina. */
export const EXHAUSTED_RETRY_TICKS = 6;

/** Ticks of enforced pause after pulling the trigger on an empty weapon. */
export const DRY_FIRE_TICKS = 8;

/** Kinds a melee swing can wound. */
const LIVING_KINDS = ['player', 'zombie', 'animal'] as const;

/**
 * Squared distance below which attacker and target count as occupying the same point,
 * so no meaningful direction can be derived from the pair. One pixel.
 */
const COINCIDENT_EPSILON_SQ = 1;

/** Kinds a melee swing falls back to when nothing living is in the arc. */
const WORLD_KINDS = ['structure', 'node'] as const;

export interface CombatSystemOptions {
  /**
   * Resolves a melee hit that landed on a resource node.
   *
   * Chopping and mining are gathering's business, but the *swing* is combat's, so the
   * payout is injected: pass the gathering system's helper here and it owns yields,
   * leave it out and the built-in {@link applyNodeHit} keeps a hatchet working.
   */
  onNodeHit?: NodeHitResolver;
}

/** A reload in flight. Transient by design: a save mid-reload resumes unloaded. */
interface PendingReload {
  weaponDefId: ItemDefId;
  ammoDefId: ItemDefId;
  finishTick: number;
}

/** What one attack attempt actually did. */
interface AttackOutcome {
  /** True when the attack was spent - a whiff counts, a dry fire does not. */
  fired: boolean;
  /** True when it connected with something. */
  hit: boolean;
}

const NOT_FIRED: AttackOutcome = { fired: false, hit: false };

/** True on the tick a button goes down, false while it stays down. */
function pressed(frame: InputFrame, previous: InputFrame | undefined, button: number): boolean {
  return hasButton(frame.buttons, button) && !hasButton(previous?.buttons ?? 0, button);
}

// ---------------------------------------------------------------------------
// Target selection
// ---------------------------------------------------------------------------

interface Candidate {
  id: EntityId;
  x: number;
  y: number;
  distanceSq: number;
}

/**
 * Sort nearest-first with an id tie-break.
 *
 * The tie-break is not cosmetic: two zombies at identical range must be picked in the
 * same order on every machine or a `maxTargets: 1` swing would hit different things in
 * a replay.
 */
function nearestFirst(a: Candidate, b: Candidate): number {
  return a.distanceSq - b.distanceSq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Living things inside the swing arc, nearest first, capped at `maxTargets`.
 *
 * Line of sight is required: you cannot reach through a window frame or around a
 * corner, and without the test a wide-arc weapon would happily hit whatever stood on
 * the far side of a wall it was touching.
 *
 * The arc test is skipped for anything whose own body already contains the attacker.
 * A cone is a statement about *direction*, and direction is meaningless at zero
 * distance: `angleBetween` of a point on top of the origin is 0, so without this a
 * walker that had shoved its way onto the player's exact position could only be hit by
 * a swing aimed at due east. You cannot miss something you are standing inside.
 */
function livingTargetsInArc(
  ctx: SimContext,
  player: PlayerState,
  weapon: WeaponProps,
  aimAngle: number,
): Candidate[] {
  const half = arcHalfAngle(weapon);
  const out: Candidate[] = [];
  for (const entry of ctx.spatial.queryKinds(player.x, player.y, weapon.range, LIVING_KINDS)) {
    if (entry.id === player.id) continue;
    if (entry.kind === 'player' && !ctx.config.mode.pvp) continue;
    const found = findEntity(ctx.state, entry.id);
    if (!found || !isDamageable(found)) continue;
    const distSq = distanceSq(player.x, player.y, entry.x, entry.y);
    const engulfing = distSq <= entry.radius * entry.radius;
    if (!engulfing && !withinCone(player.x, player.y, aimAngle, half, entry.x, entry.y)) continue;
    if (!ctx.world.hasLineOfSight(player.x, player.y, entry.x, entry.y)) continue;
    out.push({ id: entry.id, x: entry.x, y: entry.y, distanceSq: distSq });
  }
  out.sort(nearestFirst);
  return out.slice(0, Math.max(1, weapon.maxTargets));
}

/**
 * Nearest structure or resource node in the arc.
 *
 * Only one, however wide the weapon: a sledgehammer hits the wall in front of it, not
 * three walls at once. No line-of-sight test here - the thing being hit *is* the
 * obstruction, so a ray to its centre would always report itself as cover.
 */
function worldTargetInArc(
  ctx: SimContext,
  player: PlayerState,
  weapon: WeaponProps,
  aimAngle: number,
): Candidate | null {
  const half = arcHalfAngle(weapon);
  let best: Candidate | null = null;
  for (const entry of ctx.spatial.queryKinds(player.x, player.y, weapon.range, WORLD_KINDS)) {
    const found = findEntity(ctx.state, entry.id);
    if (!found || !isDamageable(found)) continue;
    if (!withinCone(player.x, player.y, aimAngle, half, entry.x, entry.y)) continue;
    const candidate: Candidate = {
      id: entry.id,
      x: entry.x,
      y: entry.y,
      distanceSq: distanceSq(player.x, player.y, entry.x, entry.y),
    };
    if (!best || nearestFirst(candidate, best) < 0) best = candidate;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Melee
// ---------------------------------------------------------------------------

function resolveMelee(
  ctx: SimContext,
  player: PlayerState,
  resolved: ResolvedWeapon,
  aimAngle: number,
  resolveNodeHit: NodeHitResolver,
): AttackOutcome {
  const { weapon, stack, def, slot } = resolved;
  const damage = swingDamage(player, weapon, stack, ctx.data);
  const targets = livingTargetsInArc(ctx, player, weapon, aimAngle);

  if (targets.length > 0) {
    let applied = 0;
    for (const target of targets) {
      // Attacker -> target, which is the direction the knockback shoves and the
      // direction the defender's guard is tested against. For a target standing on the
      // attacker's exact position that vector has no direction at all, so the swing's
      // own aim stands in: a shove has to go *somewhere*, and forwards is the honest
      // answer.
      const angle =
        target.distanceSq > COINCIDENT_EPSILON_SQ
          ? angleBetween(player.x, player.y, target.x, target.y)
          : aimAngle;
      const result = resolveIncomingAttack(ctx, target.id, {
        amount: damage,
        type: weapon.damageType,
        attackerId: player.id,
        armorPen: weapon.armorPen,
        critChance: effectiveCritChance(player, weapon),
        critMultiplier: weapon.critMultiplier,
        knockback: weapon.knockback,
        angle,
        cause: resolved.defId ?? 'unarmed',
      });
      applied += result.applied;
    }
    wearEquipped(ctx, player, slot, stack, weapon.durabilityPerHit);
    // XP tracks damage dealt, so a glancing blow on a brute is worth less than a
    // clean hit on a walker. Kills add the creature's own XP on top, in `killEntity`.
    if (applied > 0) grantXp(ctx, player, weapon.skill, 1 + applied * 0.06);
    return { fired: true, hit: true };
  }

  // Nothing alive in the arc: this is the swing that chops a tree or breaks a door.
  const worldTarget = worldTargetInArc(ctx, player, weapon, aimAngle);
  if (!worldTarget) return { fired: true, hit: false };

  const structure = ctx.state.structures[worldTarget.id];
  if (structure) {
    const result = hitStructure(ctx, structure, {
      amount: damage,
      type: weapon.damageType,
      attackerId: player.id,
      armorPen: weapon.armorPen,
    });
    if (result.applied <= 0) return { fired: true, hit: false };
    wearEquipped(ctx, player, slot, stack, weapon.durabilityPerHit);
    return { fired: true, hit: true };
  }

  const node = ctx.state.nodes[worldTarget.id];
  if (!node) return { fired: true, hit: false };
  const swing: MeleeSwing = { weapon, stack, def, slot, damage, angle: aimAngle };
  return { fired: true, hit: resolveNodeHit(ctx, player, node, swing) };
}

// ---------------------------------------------------------------------------
// Ranged
// ---------------------------------------------------------------------------

/**
 * Cone of inaccuracy for one shot, in radians.
 *
 * Skill is the big lever - level 10 shooting is a quarter of the novice's cone, which
 * is what makes the ranged skill worth training. Stance and arm injuries move it too:
 * crouching steadies the shot, sprinting ruins it, and a fractured forearm widens the
 * cone rather than reducing the damage, because a bullet does not care who fired it.
 */
export function spreadRadians(player: PlayerState, weapon: WeaponProps): number {
  const base = weapon.spreadDegrees ?? 0;
  if (base <= 0) return 0;
  const skill = skillCostMultiplier(player, weapon.skill, 0.075, 0.25);
  const stance = player.moveMode === 'crouch' ? 0.7 : player.moveMode === 'run' ? 1.6 : 1;
  const arm = armCapabilityMultiplier(player.body);
  return (((base * skill * stance) / arm) * Math.PI) / 180;
}

function resolveRanged(
  ctx: SimContext,
  player: PlayerState,
  resolved: ResolvedWeapon,
  aimAngle: number,
): AttackOutcome {
  const { weapon, stack, defId, slot } = resolved;
  // A ranged weapon is always an item; there is no unarmed ranged attack.
  if (!stack || !defId) return NOT_FIRED;

  const loaded = stack.ammo ?? 0;
  if (loaded <= 0) {
    ctx.events.emit({ type: 'outOfAmmo', ownerId: player.id, weaponDefId: defId });
    player.attackReadyTick = ctx.state.tick + DRY_FIRE_TICKS;
    bump(player);
    return NOT_FIRED;
  }

  // The loaded round's own projectile wins over the weapon's default, which is how
  // iron arrows out-perform wooden ones from the same bow.
  const ammoDef = stack.ammoDefId ? ctx.data.items.get(stack.ammoDefId) : undefined;
  const projectileDefId = ammoDef?.projectileDefId ?? weapon.projectileDefId;
  if (!projectileDefId) {
    ctx.log.warn('ranged weapon has no projectile', { defId });
    return NOT_FIRED;
  }

  const pellets = Math.max(1, weapon.pellets ?? 1);
  const spread = spreadRadians(player, weapon);
  const rng = ctx.rng.fork(`shot:${player.id}:${ctx.state.tick}`);
  const damage = swingDamage(player, weapon, stack, ctx.data);

  for (let i = 0; i < pellets; i++) {
    const angle = spread > 0 ? aimAngle + rng.float(-spread / 2, spread / 2) : aimAngle;
    spawnProjectile(ctx, {
      ownerId: player.id,
      defId: projectileDefId,
      x: player.x,
      y: player.y,
      angle,
      damage,
      armorPen: weapon.armorPen,
      maxRange: weapon.range,
      weaponDefId: defId,
    });
  }

  // One round per trigger pull, however many pellets came out of it.
  stack.ammo = loaded - 1;
  bump(player);
  wearEquipped(ctx, player, slot, stack, weapon.durabilityPerHit);
  return { fired: true, hit: false };
}

/**
 * Throw the held item.
 *
 * A thrown weapon *is* its own ammunition, so the stack is consumed and the hand ends
 * up empty - which is the trade for a molotov: one doorway sealed, and now you are
 * holding nothing.
 */
function resolveThrown(
  ctx: SimContext,
  player: PlayerState,
  resolved: ResolvedWeapon,
  aimAngle: number,
): AttackOutcome {
  const { weapon, stack, defId, slot } = resolved;
  if (!stack || !defId || !weapon.projectileDefId || !slot) return NOT_FIRED;

  spawnProjectile(ctx, {
    ownerId: player.id,
    defId: weapon.projectileDefId,
    x: player.x,
    y: player.y,
    angle: aimAngle,
    damage: swingDamage(player, weapon, stack, ctx.data),
    armorPen: weapon.armorPen,
    maxRange: weapon.range,
    weaponDefId: defId,
  });

  stack.count -= 1;
  if (stack.count <= 0) player.equipment[slot] = null;
  recomputeCarryWeight(player, ctx.data);
  bump(player);
  return { fired: true, hit: false };
}

// ---------------------------------------------------------------------------
// Reloading
// ---------------------------------------------------------------------------

/** Return loaded rounds of the wrong type to the pack before loading new ones. */
function ejectLoaded(ctx: SimContext, player: PlayerState, stack: ItemStack): void {
  const loaded = stack.ammo ?? 0;
  if (loaded <= 0 || !stack.ammoDefId) return;
  if (ctx.data.items.has(stack.ammoDefId)) {
    const ejected = createStack(ctx.data, stack.ammoDefId, loaded);
    const leftover = addToInventory(player.inventory, ejected, ctx.data);
    if (leftover > 0) {
      dropStack(ctx, player.x, player.y, { defId: stack.ammoDefId, count: leftover }, player.id);
    }
  }
  stack.ammo = 0;
  delete stack.ammoDefId;
}

/**
 * Start a reload.
 *
 * Validated hard: the weapon must be a loaded-magazine weapon the player is actually
 * holding, the requested round must be one it accepts, and the player must be carrying
 * some. Nothing moves until the reload finishes, so interrupting it (by dying, or by
 * swapping weapons) costs the attempt rather than duplicating rounds.
 */
function beginReload(
  ctx: SimContext,
  player: PlayerState,
  requested: ItemDefId | undefined,
  reloads: Map<PlayerId, PendingReload>,
): void {
  const reject = (reason: string) =>
    ctx.events.emit({ type: 'commandRejected', playerId: player.id, command: 'reload', reason });

  if (!player.alive) {
    reject('dead');
    return;
  }
  if (reloads.has(player.id)) {
    reject('already reloading');
    return;
  }

  const resolved = resolveWeapon(player, ctx.data);
  const { weapon, stack, defId } = resolved;
  if (weapon.kind !== 'ranged' || !stack || !defId) {
    reject('no reloadable weapon equipped');
    return;
  }

  const allowed = weapon.ammoDefIds ?? [];
  if (allowed.length === 0) {
    reject('weapon takes no ammunition');
    return;
  }
  if (requested !== undefined && !allowed.includes(requested)) {
    reject('wrong ammunition for this weapon');
    return;
  }

  const magazineSize = Math.max(1, weapon.magazineSize ?? 1);
  const loaded = stack.ammo ?? 0;
  const sameType = requested === undefined || requested === stack.ammoDefId;
  if (loaded >= magazineSize && sameType) {
    reject('magazine full');
    return;
  }

  // Prefer what is already loaded, then the weapon's preference order.
  const preference = requested !== undefined ? [requested] : allowed;
  const ordered =
    requested === undefined && stack.ammoDefId && allowed.includes(stack.ammoDefId)
      ? [stack.ammoDefId, ...preference.filter((id) => id !== stack.ammoDefId)]
      : preference;

  const chosen = ordered.find((id) => countAmmo(player, id) > 0);
  if (!chosen) {
    ctx.events.emit({ type: 'outOfAmmo', ownerId: player.id, weaponDefId: defId });
    reject('no ammunition');
    return;
  }

  if (stack.ammoDefId && stack.ammoDefId !== chosen) ejectLoaded(ctx, player, stack);

  const baseTicks = weapon.reloadTicks ?? SIM_HZ * 2;
  const ticks = Math.max(
    1,
    Math.round(baseTicks * skillCostMultiplier(player, weapon.skill, 0.03, 0.7)),
  );
  const finishTick = ctx.state.tick + ticks;
  reloads.set(player.id, { weaponDefId: defId, ammoDefId: chosen, finishTick });

  // No firing mid-reload.
  player.attackReadyTick = Math.max(player.attackReadyTick, finishTick);
  bump(player);
}

/** Finish any reload whose timer has run out. */
function completeReloads(ctx: SimContext, reloads: Map<PlayerId, PendingReload>): void {
  if (reloads.size === 0) return;
  for (const playerId of [...reloads.keys()].sort()) {
    const pending = reloads.get(playerId);
    if (!pending || pending.finishTick > ctx.state.tick) continue;
    reloads.delete(playerId);

    const player = ctx.state.players[playerId];
    if (!player?.alive) continue;

    const resolved = resolveWeapon(player, ctx.data);
    const { weapon, stack, defId } = resolved;
    // Swapped weapons mid-reload: the attempt is simply lost.
    if (!stack || defId !== pending.weaponDefId || weapon.kind !== 'ranged') continue;

    const magazineSize = Math.max(1, weapon.magazineSize ?? 1);
    const keep = stack.ammoDefId === pending.ammoDefId ? (stack.ammo ?? 0) : 0;
    const space = magazineSize - keep;
    const rounds = Math.min(space, countAmmo(player, pending.ammoDefId));
    if (rounds <= 0) {
      ctx.events.emit({ type: 'outOfAmmo', ownerId: player.id, weaponDefId: pending.weaponDefId });
      continue;
    }

    removeFromInventory(player.inventory, pending.ammoDefId, rounds);
    stack.ammo = keep + rounds;
    stack.ammoDefId = pending.ammoDefId;
    recomputeCarryWeight(player, ctx.data);
    bump(player);
    ctx.events.emit({
      type: 'reloaded',
      ownerId: player.id,
      weaponDefId: pending.weaponDefId,
      rounds,
    });
  }
}

// ---------------------------------------------------------------------------
// The system
// ---------------------------------------------------------------------------

function tryAttack(
  ctx: SimContext,
  player: PlayerState,
  frame: InputFrame,
  resolved: ResolvedWeapon,
  resolveNodeHit: NodeHitResolver,
): void {
  const tick = ctx.state.tick;
  if (tick < player.attackReadyTick) return;
  // Staggered by a hit, or locked into another animation.
  if (tick < player.actionLockedUntilTick) return;
  // A raised guard is a stance, not a free action: you cannot swing from behind it.
  if (isGuarding(ctx, player)) return;

  const { weapon } = resolved;
  const cost = staminaCostFor(player, weapon);
  if (player.stamina < cost) {
    ctx.events.emit({
      type: 'notification',
      playerId: player.id,
      severity: 'warn',
      message: { code: 'notify.tooExhausted' },
    });
    player.attackReadyTick = tick + EXHAUSTED_RETRY_TICKS;
    bump(player);
    return;
  }

  const aimAngle = frame.aimAngle;
  let outcome: AttackOutcome;
  switch (weapon.kind) {
    case 'ranged':
      outcome = resolveRanged(ctx, player, resolved, aimAngle);
      break;
    case 'thrown':
      outcome = resolveThrown(ctx, player, resolved, aimAngle);
      break;
    default:
      outcome = resolveMelee(ctx, player, resolved, aimAngle, resolveNodeHit);
      break;
  }
  if (!outcome.fired) return;

  player.stamina = Math.max(0, player.stamina - cost);
  player.attackReadyTick = tick + attackCooldownTicks(player, weapon);
  bump(player);

  if (weapon.kind === 'melee') {
    ctx.events.emit({
      type: 'attackSwing',
      attackerId: player.id,
      ...(resolved.defId ? { weaponDefId: resolved.defId } : {}),
      angle: aimAngle,
      x: player.x,
      y: player.y,
      hit: outcome.hit,
    });
  }

  // Noise is the game's aggro currency. Connecting is louder than whiffing, crouching
  // is quieter than standing, and a gunshot's 4 000-plus px radius is why firing one is
  // a strategic act rather than a free win.
  const loudness =
    weapon.loudness * (outcome.hit ? 1.35 : 1) * (player.moveMode === 'crouch' ? 0.7 : 1);
  emitNoise(ctx, player.x, player.y, loudness, outcome.hit ? 1 : 0.7, player.id);
}

/**
 * Melee, ranged, thrown, blocking and reloading.
 *
 * Runs at {@link SystemOrder.Combat}: after movement, so a swing uses the position the
 * player actually ended the tick at, and before AI, so a zombie reacts to the noise in
 * the same tick it was made.
 */
export function createCombatSystem(options: CombatSystemOptions = {}): System {
  const resolveNodeHit = options.onNodeHit ?? applyNodeHit;
  const reloads = new Map<PlayerId, PendingReload>();

  return {
    id: 'combat',
    order: SystemOrder.Combat,

    init(_ctx, router) {
      router.on('reload', (ctx, player, command) => {
        beginReload(ctx, player, command.ammoDefId, reloads);
      });
    },

    onPlayerLeave(_ctx, player) {
      reloads.delete(player.id);
    },

    update(ctx) {
      completeReloads(ctx, reloads);

      // Sorted so two players attacking on the same tick always resolve in the same
      // order, which matters as soon as they are shooting at each other.
      for (const playerId of Object.keys(ctx.state.players).sort()) {
        const player = ctx.state.players[playerId];
        if (!player) continue;
        if (!player.alive) {
          reloads.delete(playerId);
          continue;
        }

        const frame = ctx.inputs.get(playerId);
        // A starved input buffer means the client went quiet; the player coasts rather
        // than repeating last tick's button state.
        if (!frame) continue;
        const previous = ctx.inputs.previous(playerId);

        if (pressed(frame, previous, Button.Reload)) {
          beginReload(ctx, player, undefined, reloads);
        }

        if (!hasButton(frame.buttons, Button.Primary)) continue;
        const resolved = resolveWeapon(player, ctx.data);
        // Holding the button only repeats for a weapon that cycles fast enough to
        // count as automatic; everything else needs a fresh press per swing.
        if (hasButton(previous?.buttons ?? 0, Button.Primary) && !isAutoFire(resolved.weapon)) {
          continue;
        }
        tryAttack(ctx, player, frame, resolved, resolveNodeHit);
      }
    },
  };
}
