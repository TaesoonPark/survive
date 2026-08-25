import {
  EQUIP_SLOTS,
  SIM_HZ,
  type AnimalState,
  type DamageType,
  type EntityId,
  type PlayerState,
  type ZombieState,
} from '@survive/protocol';
import type { SimContext } from './context';
import { dropLootTable, dropStack } from './loot';
import { grantXp } from './skills';
import { NoiseRadius, emitNoise } from './noise';
import { bump, markDirtyAt } from './queries';

/**
 * Death consequences.
 *
 * Kept apart from the damage pipeline so that "took a lethal hit" and "what happens
 * when something dies" stay separately testable, but funnelled through one function
 * per entity kind so loot, XP, stats and the death event can never diverge between
 * a sword blow and a starvation tick.
 */

/** How long a player must wait before respawning, in ticks. */
export const RESPAWN_DELAY_TICKS = SIM_HZ * 5;

/** Kill a zombie: drop loot, award XP to the killer, emit the event. */
export function killZombie(
  ctx: SimContext,
  zombie: ZombieState,
  cause: DamageType | string,
  killerId?: EntityId,
): void {
  if (zombie.ai === 'dead') return;
  zombie.ai = 'dead';
  zombie.deadTick = ctx.state.tick;
  zombie.health = 0;
  zombie.vx = 0;
  zombie.vy = 0;
  bump(zombie);

  const def = ctx.data.zombies.get(zombie.defId);
  if (def?.lootTableId) dropLootTable(ctx, def.lootTableId, zombie.x, zombie.y);

  if (killerId) {
    const killer = ctx.state.players[killerId];
    if (killer) {
      killer.stats.zombieKills++;
      const weapon = killer.equipment.mainHand;
      const weaponDef = weapon ? ctx.data.items.get(weapon.defId) : undefined;
      const skill = weaponDef?.weapon?.skill ?? 'melee';
      grantXp(ctx, killer, skill, def?.xp ?? 5);
      bump(killer);
    }
  }

  emitNoise(ctx, zombie.x, zombie.y, NoiseRadius.Hurt, 0.6, zombie.id);
  ctx.events.emit({
    type: 'death',
    entityId: zombie.id,
    ...(killerId ? { killerId } : {}),
    cause,
    x: zombie.x,
    y: zombie.y,
  });
  markDirtyAt(ctx.state, zombie.x, zombie.y);
}

/** Kill an animal: drop its butchering loot and award the hunting XP. */
export function killAnimal(
  ctx: SimContext,
  animal: AnimalState,
  cause: DamageType | string,
  killerId?: EntityId,
): void {
  if (animal.ai === 'dead') return;
  animal.ai = 'dead';
  animal.deadTick = ctx.state.tick;
  animal.health = 0;
  animal.vx = 0;
  animal.vy = 0;
  bump(animal);

  const def = ctx.data.animals.get(animal.defId);
  if (def) dropLootTable(ctx, def.lootTableId, animal.x, animal.y);

  if (killerId) {
    const killer = ctx.state.players[killerId];
    if (killer && def) {
      killer.stats.animalKills++;
      grantXp(ctx, killer, def.skill, def.xp);
      bump(killer);
    }
  }

  ctx.events.emit({
    type: 'death',
    entityId: animal.id,
    ...(killerId ? { killerId } : {}),
    cause,
    x: animal.x,
    y: animal.y,
  });
  markDirtyAt(ctx.state, animal.x, animal.y);
}

/**
 * Kill a player.
 *
 * Gear and inventory spill on the ground where they fell, which is the whole tension
 * of a survival death: the run back to your corpse. Skills and stats are kept, so
 * dying costs you your stuff and your position, not your progress.
 */
export function killPlayer(
  ctx: SimContext,
  player: PlayerState,
  cause: DamageType | string,
  killerId?: EntityId,
  dropInventory = true,
): void {
  if (!player.alive) return;
  player.alive = false;
  player.health = 0;
  player.deathTick = ctx.state.tick;
  player.respawnAtTick = ctx.state.tick + RESPAWN_DELAY_TICKS;
  player.deathCause = String(cause);
  player.vx = 0;
  player.vy = 0;
  player.stats.deaths++;
  player.craftQueue = [];
  delete player.openContainerId;

  if (dropInventory) {
    for (let i = 0; i < player.inventory.slots.length; i++) {
      const stack = player.inventory.slots[i];
      if (!stack) continue;
      dropStack(ctx, player.x, player.y, stack, player.id, 28);
      player.inventory.slots[i] = null;
    }
    for (const slot of EQUIP_SLOTS) {
      const stack = player.equipment[slot];
      if (!stack) continue;
      dropStack(ctx, player.x, player.y, stack, player.id, 28);
      player.equipment[slot] = null;
    }
    player.carryWeight = 0;
  }

  bump(player);

  if (killerId) {
    const killer = ctx.state.players[killerId];
    if (killer) {
      killer.stats.playerKills++;
      bump(killer);
    }
  }

  emitNoise(ctx, player.x, player.y, NoiseRadius.Scream * 0.5, 1, player.id);
  ctx.events.emit({
    type: 'death',
    entityId: player.id,
    ...(killerId ? { killerId } : {}),
    cause,
    x: player.x,
    y: player.y,
  });
  markDirtyAt(ctx.state, player.x, player.y);
}

/**
 * Dispatch death handling for any entity id.
 *
 * Call this right after a {@link import('./damage').DamageResult} comes back with
 * `killed: true`.
 */
export function killEntity(
  ctx: SimContext,
  entityId: EntityId,
  cause: DamageType | string,
  killerId?: EntityId,
): void {
  const zombie = ctx.state.zombies[entityId];
  if (zombie) {
    killZombie(ctx, zombie, cause, killerId);
    return;
  }
  const animal = ctx.state.animals[entityId];
  if (animal) {
    killAnimal(ctx, animal, cause, killerId);
    return;
  }
  const player = ctx.state.players[entityId];
  if (player) {
    killPlayer(ctx, player, cause, killerId);
  }
  // Structures and nodes are handled by their own systems, which have to update the
  // collision grid as well as the entity table.
}
