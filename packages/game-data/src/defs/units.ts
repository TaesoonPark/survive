import {
  TICKS_PER_GAME_DAY,
  TICKS_PER_GAME_HOUR,
  TICKS_PER_GAME_MINUTE,
  SIM_HZ,
} from '@survive/protocol';

/**
 * Time helpers for the content tables.
 *
 * Every duration in the tables is in *simulation ticks*, because that is what the
 * simulation counts. Writing `days(4)` instead of `115200` is the difference between
 * a table a designer can retune and a table nobody dares touch.
 *
 * At the shipped clock (1 real second = 1 in-game minute) one in-game day is
 * 28 800 ticks = 24 real minutes.
 */

/** Ticks for `n` real seconds of wall time. Used for craft/attack timings. */
export function seconds(n: number): number {
  return Math.round(SIM_HZ * n);
}

/** Ticks for `n` in-game minutes. */
export function gameMinutes(n: number): number {
  return Math.round(TICKS_PER_GAME_MINUTE * n);
}

/** Ticks for `n` in-game hours. */
export function gameHours(n: number): number {
  return Math.round(TICKS_PER_GAME_HOUR * n);
}

/** Ticks for `n` in-game days. */
export function days(n: number): number {
  return Math.round(TICKS_PER_GAME_DAY * n);
}
