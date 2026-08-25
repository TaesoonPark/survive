/** Trainable skills. Levelling is driven by using the corresponding system. */
export type SkillId =
  | 'melee'
  | 'ranged'
  | 'woodcutting'
  | 'mining'
  | 'foraging'
  | 'farming'
  | 'crafting'
  | 'building'
  | 'cooking'
  | 'medicine'
  | 'athletics'
  | 'stealth';

export const SKILL_IDS: readonly SkillId[] = [
  'melee',
  'ranged',
  'woodcutting',
  'mining',
  'foraging',
  'farming',
  'crafting',
  'building',
  'cooking',
  'medicine',
  'athletics',
  'stealth',
];

/** Highest attainable skill level. */
export const MAX_SKILL_LEVEL = 10;

export interface SkillState {
  level: number;
  /** Experience accumulated towards the next level. */
  xp: number;
}

export type SkillsState = Record<SkillId, SkillState>;

export function createSkills(): SkillsState {
  const skills = {} as SkillsState;
  for (const id of SKILL_IDS) skills[id] = { level: 0, xp: 0 };
  return skills;
}
