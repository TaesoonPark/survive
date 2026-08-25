import { MAX_SKILL_LEVEL, type PlayerState, type SkillId } from '@survive/protocol';
import type { SimContext } from './context';

/**
 * Skill progression.
 *
 * XP per level grows superlinearly so the first level of a skill is quick and
 * mastery is a long-term goal. Levels feed multipliers back into the systems that
 * granted the XP, which is what makes practising a skill feel like it pays off.
 */

/** XP needed to go from `level` to `level + 1`. */
export function xpForLevel(level: number): number {
  return Math.round(60 * Math.pow(1.55, level));
}

/** Total XP needed to reach a level from scratch. Useful for UI progress bars. */
export function cumulativeXp(level: number): number {
  let total = 0;
  for (let i = 0; i < level; i++) total += xpForLevel(i);
  return total;
}

/**
 * Grant XP, levelling up as many times as the amount allows.
 * `xpRate` tuning scales the gain, so a server can run a faster progression curve.
 */
export function grantXp(
  ctx: SimContext,
  player: PlayerState,
  skill: SkillId,
  amount: number,
): void {
  if (amount <= 0) return;
  const scaled = amount * ctx.config.tuning.xpRate;
  const state = player.skills[skill];
  state.xp += scaled;
  ctx.events.emit({ type: 'skillXp', playerId: player.id, skill, amount: scaled });

  let levelled = false;
  while (state.level < MAX_SKILL_LEVEL) {
    const needed = xpForLevel(state.level);
    if (state.xp < needed) break;
    state.xp -= needed;
    state.level++;
    levelled = true;
    ctx.events.emit({ type: 'levelUp', playerId: player.id, skill, level: state.level });
  }
  if (state.level >= MAX_SKILL_LEVEL) state.xp = 0;
  player.rev++;
  if (levelled) {
    // A level in athletics raises the stamina ceiling; everything else is a multiplier
    // applied at the point of use.
    if (skill === 'athletics') {
      player.maxStamina = 100 + state.level * 8;
      player.stamina = Math.min(player.stamina, player.maxStamina);
    }
  }
}

export function skillLevel(player: PlayerState, skill: SkillId): number {
  return player.skills[skill].level;
}

/**
 * Generic effectiveness multiplier from a skill level.
 * Level 0 gives 1.0, level 10 gives 1 + 10 * `perLevel`.
 */
export function skillMultiplier(player: PlayerState, skill: SkillId, perLevel = 0.06): number {
  return 1 + skillLevel(player, skill) * perLevel;
}

/**
 * Multiplier that *reduces* a cost as skill rises, floored so it never reaches zero.
 * Used for crafting time, stamina cost and failure chance.
 */
export function skillCostMultiplier(
  player: PlayerState,
  skill: SkillId,
  perLevel = 0.05,
  floor = 0.5,
): number {
  return Math.max(floor, 1 - skillLevel(player, skill) * perLevel);
}
