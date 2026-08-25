import {
  SIM_HZ,
  clamp01,
  lerp,
  pointToSegmentDistance,
  type DamageType,
  type EntityId,
  type ItemDefId,
  type ProjectileDefId,
  type ProjectileState,
} from '@survive/protocol';
import { CollisionFlag } from '@survive/world';
import type { WeaponProps } from '@survive/game-data';
import { SystemOrder, type SimContext, type System } from '../../core/context';
import { bump, destroyEntity, isDamageable, findEntity, structureAtTile } from '../../core/queries';
import { dropStack } from '../../core/loot';
import { grantXp } from '../../core/skills';
import { resolveIncomingAttack } from './blocking';
import { hitStructure } from './impact';

/**
 * Projectiles in flight.
 *
 * The one rule that matters here is *no tunnelling*. A .308 round covers 340 px in a
 * single 50 ms tick - ten tiles - so a hit test that only looks at where the bullet
 * ended up would miss every target and every wall in between. Every test in this file
 * therefore works on the swept segment `prev -> next`: terrain by raycast, entities by
 * distance-to-segment. A bullet that crosses a walker in one tick hits it.
 */

/** Nothing stays in the air longer than this, however the maths worked out. */
export const PROJECTILE_MAX_LIFETIME_TICKS = SIM_HZ * 8;

/**
 * Widest plausible target radius, used only to size the broadphase query. Too small
 * and a hit is missed; too large only costs a few extra candidates.
 */
const BROADPHASE_MARGIN = 32;

/** Kinds a projectile can hurt. */
const HITTABLE: readonly string[] = ['player', 'zombie', 'animal'];

export interface ProjectileSpawn {
  ownerId: EntityId;
  defId: ProjectileDefId;
  /** Muzzle position in world pixels. */
  x: number;
  y: number;
  /** Direction of travel, radians. */
  angle: number;
  damage: number;
  armorPen: number;
  /** Hard range cap in pixels; the projectile despawns past it. */
  maxRange: number;
  /** Weapon that fired it, for damage type, crit and XP attribution. */
  weaponDefId?: ItemDefId;
}

/**
 * Put one projectile in the air.
 *
 * It spawns at the shooter's exact position rather than at a muzzle offset: the
 * offset would let a player hugging a wall spawn the round on the far side of it. The
 * client draws the muzzle wherever it likes.
 */
export function spawnProjectile(ctx: SimContext, spawn: ProjectileSpawn): ProjectileState | null {
  const def = ctx.data.projectiles.get(spawn.defId);
  if (!def) {
    ctx.log.warn('spawnProjectile: unknown projectile definition', { defId: spawn.defId });
    return null;
  }
  const id = ctx.ids.projectile();
  const projectile: ProjectileState = {
    id,
    defId: def.id,
    x: spawn.x,
    y: spawn.y,
    prevX: spawn.x,
    prevY: spawn.y,
    vx: Math.cos(spawn.angle) * def.speed,
    vy: Math.sin(spawn.angle) * def.speed,
    ownerId: spawn.ownerId,
    ownerWasPlayer: ctx.state.players[spawn.ownerId] !== undefined,
    damage: spawn.damage,
    armorPen: spawn.armorPen,
    travelled: 0,
    maxRange: Math.max(1, Math.min(spawn.maxRange, def.maxRange)),
    pierceLeft: def.pierce,
    spawnTick: ctx.state.tick,
    rev: 1,
  };
  if (spawn.weaponDefId) projectile.weaponDefId = spawn.weaponDefId;
  ctx.state.projectiles[id] = projectile;
  ctx.events.emit({
    type: 'projectileFired',
    projectileId: id,
    ownerId: spawn.ownerId,
    x: spawn.x,
    y: spawn.y,
    angle: spawn.angle,
    defId: def.id,
  });
  return projectile;
}

/** Weapon behind a projectile, when it came from an item. */
function weaponOf(ctx: SimContext, projectile: ProjectileState): WeaponProps | null {
  if (!projectile.weaponDefId) return null;
  return ctx.data.items.get(projectile.weaponDefId)?.weapon ?? null;
}

/** Parameter along `a -> b` of the point closest to `p`, clamped to the segment. */
function segmentParam(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return 0;
  return clamp01(((px - ax) * dx + (py - ay) * dy) / lengthSq);
}

interface SweptTarget {
  id: EntityId;
  /** 0..1 along the swept segment, so nearer targets are hit first. */
  t: number;
  x: number;
  y: number;
}

/**
 * Everything the swept segment passes close enough to hit, nearest first.
 *
 * Ordering by segment parameter rather than by distance from the shooter is what makes
 * `pierce` behave: a rifle round has to hit the walker in front before the one behind.
 */
function sweptTargets(
  ctx: SimContext,
  projectile: ProjectileState,
  radius: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  already: ReadonlySet<EntityId> | undefined,
): SweptTarget[] {
  const midX = (ax + bx) / 2;
  const midY = (ay + by) / 2;
  const reach = Math.hypot(bx - ax, by - ay) / 2 + radius + BROADPHASE_MARGIN;
  // Stamped at spawn, not looked up now: a disconnect deletes the owner from
  // `state.players` while their round is still in the air, and an owner-less round used to
  // count as a zombie's - enabling friendly fire on a no-PvP server at a moment the client
  // chose. Falls back to the lookup for rounds restored from a save predating the field.
  const ownerIsPlayer =
    projectile.ownerWasPlayer ?? ctx.state.players[projectile.ownerId] !== undefined;

  const out: SweptTarget[] = [];
  for (const entry of ctx.spatial.query(midX, midY, reach)) {
    if (entry.id === projectile.ownerId) continue;
    if (!HITTABLE.includes(entry.kind)) continue;
    // Friendly fire between players is a server setting, not a client's choice.
    if (entry.kind === 'player' && ownerIsPlayer && !ctx.config.mode.pvp) continue;
    // A piercing round must never wound the same body twice. Without this a slow
    // bolt whose tick ended just past a walker would find it again next tick, sitting
    // a few pixels behind the new segment's start and still inside the hit radius.
    if (already?.has(entry.id)) continue;
    const found = findEntity(ctx.state, entry.id);
    if (!found || !isDamageable(found)) continue;
    if (pointToSegmentDistance(entry.x, entry.y, ax, ay, bx, by) > radius + entry.radius) continue;
    out.push({
      id: entry.id,
      t: segmentParam(entry.x, entry.y, ax, ay, bx, by),
      x: entry.x,
      y: entry.y,
    });
  }
  // Ids break ties so two targets at the same depth resolve in a fixed order.
  out.sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/**
 * Damage at a given travelled distance, after range falloff.
 *
 * Linear from full damage at the muzzle to `falloff` of it at the weapon's maximum
 * range, which is what separates a shotgun (0.3 - lethal in a doorway, a nuisance
 * across a street) from a rifle round (0.92 - it barely notices the distance).
 */
export function damageAtRange(
  projectile: ProjectileState,
  falloff: number,
  travelled: number,
): number {
  return projectile.damage * lerp(1, falloff, clamp01(travelled / projectile.maxRange));
}

/**
 * Roll to leave the round on the ground.
 *
 * Arrows and bolts are recoverable, bullets never are. This is what makes archery
 * sustainable: craft a batch, walk the field, craft a smaller batch.
 */
function tryRecover(ctx: SimContext, projectile: ProjectileState, x: number, y: number): void {
  const def = ctx.data.projectiles.get(projectile.defId);
  if (!def?.recoverDefId) return;
  const chance = def.recoverChance ?? 0;
  if (chance <= 0) return;
  const rng = ctx.rng.fork(`recover:${projectile.id}`);
  if (!rng.chance(chance)) return;
  const item = ctx.data.items.get(def.recoverDefId);
  if (!item) return;
  dropStack(ctx, x, y, { defId: def.recoverDefId, count: 1 });
}

/** Remove a projectile from the world. */
function despawn(ctx: SimContext, projectile: ProjectileState): void {
  destroyEntity(ctx.state, projectile.id);
}

/**
 * Advance and resolve every projectile.
 *
 * Runs at {@link SystemOrder.Projectile}, immediately after combat, so a round fired
 * this tick travels this tick - which is what makes a point-blank shotgun blast feel
 * instant instead of arriving a frame late.
 */
export function createProjectileSystem(): System {
  /**
   * Who each piercing projectile has already wounded.
   *
   * Transient on purpose: it exists only to stop a double hit across a tick boundary,
   * and a round still in flight when the world is saved is not worth a field in the
   * replicated {@link ProjectileState}. A reloaded save simply forgets, and the round
   * is gone within a tick anyway.
   */
  const wounded = new Map<EntityId, Set<EntityId>>();

  return {
    id: 'projectile',
    order: SystemOrder.Projectile,

    update(ctx) {
      const dt = ctx.clock.dt;
      // Sorted so the order two projectiles resolve in never depends on insertion
      // order, which is what keeps a replay identical.
      for (const id of Object.keys(ctx.state.projectiles).sort()) {
        const projectile = ctx.state.projectiles[id];
        if (!projectile) continue;

        const def = ctx.data.projectiles.get(projectile.defId);
        if (!def) {
          despawn(ctx, projectile);
          continue;
        }

        if (ctx.state.tick - projectile.spawnTick > PROJECTILE_MAX_LIFETIME_TICKS) {
          despawn(ctx, projectile);
          continue;
        }

        projectile.prevX = projectile.x;
        projectile.prevY = projectile.y;
        const ax = projectile.prevX;
        const ay = projectile.prevY;
        let bx = projectile.x + projectile.vx * dt;
        let by = projectile.y + projectile.vy * dt;

        // Clip the sweep at the first wall so nothing is hit through cover.
        const terrain = ctx.world.raycast(ax, ay, bx, by);
        if (terrain) {
          bx = terrain.x;
          by = terrain.y;
        }

        const weapon = weaponOf(ctx, projectile);
        const damageType: DamageType = weapon?.damageType ?? 'pierce';
        const angle = Math.atan2(projectile.vy, projectile.vx);
        let consumed = false;

        for (const target of sweptTargets(
          ctx,
          projectile,
          def.radius,
          ax,
          ay,
          bx,
          by,
          wounded.get(projectile.id),
        )) {
          const travelled = projectile.travelled + Math.hypot(bx - ax, by - ay) * target.t;
          const amount = damageAtRange(projectile, def.damageFalloff, travelled);
          const impactX = ax + (bx - ax) * target.t;
          const impactY = ay + (by - ay) * target.t;

          ctx.events.emit({
            type: 'projectileHit',
            projectileId: projectile.id,
            targetId: target.id,
            x: impactX,
            y: impactY,
          });

          const result = resolveIncomingAttack(ctx, target.id, {
            amount,
            type: damageType,
            attackerId: projectile.ownerId,
            armorPen: projectile.armorPen,
            critChance: weapon?.critChance ?? 0,
            critMultiplier: weapon?.critMultiplier ?? 1.5,
            knockback: (weapon?.knockback ?? 0) * clamp01(amount / Math.max(1, projectile.damage)),
            angle,
            ...(projectile.weaponDefId ? { cause: projectile.weaponDefId } : {}),
          });

          const shooter = ctx.state.players[projectile.ownerId];
          if (shooter && result.applied > 0) {
            grantXp(ctx, shooter, weapon?.skill ?? 'ranged', 1 + result.applied * 0.06);
          }

          if (projectile.pierceLeft > 0) {
            projectile.pierceLeft--;
            let seen = wounded.get(projectile.id);
            if (!seen) {
              seen = new Set<EntityId>();
              wounded.set(projectile.id, seen);
            }
            seen.add(target.id);
            continue;
          }
          consumed = true;
          break;
        }

        if (consumed) {
          despawn(ctx, projectile);
          continue;
        }

        if (terrain) {
          // A round that stops on a wall damages what it stopped on.
          if ((terrain.flags & (CollisionFlag.StructureSolid | CollisionFlag.Door)) !== 0) {
            const structure = structureAtTile(ctx.state, terrain.tileX, terrain.tileY);
            if (structure) {
              hitStructure(ctx, structure, {
                amount: damageAtRange(
                  projectile,
                  def.damageFalloff,
                  projectile.travelled + terrain.distance,
                ),
                type: damageType,
                attackerId: projectile.ownerId,
              });
            }
          }
          ctx.events.emit({
            type: 'projectileHit',
            projectileId: projectile.id,
            x: terrain.x,
            y: terrain.y,
          });
          tryRecover(ctx, projectile, terrain.x, terrain.y);
          despawn(ctx, projectile);
          continue;
        }

        projectile.travelled += Math.hypot(bx - ax, by - ay);
        projectile.x = bx;
        projectile.y = by;
        bump(projectile);

        if (projectile.travelled >= projectile.maxRange) despawn(ctx, projectile);
      }

      // Forget the wound lists of rounds that are no longer in the air. Done as a
      // sweep rather than inside `despawn` so a projectile removed by anything else -
      // a chunk unload, a debug command - cannot leak an entry either.
      if (wounded.size > 0) {
        for (const id of [...wounded.keys()]) {
          if (!ctx.state.projectiles[id]) wounded.delete(id);
        }
      }
    },
  };
}
