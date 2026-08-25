/** A 2D point in world space (pixels). Plain data: JSON-serializable. */
export interface Vec2 {
  x: number;
  y: number;
}

export function vec2(x = 0, y = 0): Vec2 {
  return { x, y };
}

export function cloneVec2(v: Vec2): Vec2 {
  return { x: v.x, y: v.y };
}

export function addVec2(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function subVec2(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scaleVec2(v: Vec2, s: number): Vec2 {
  return { x: v.x * s, y: v.y * s };
}

export function lengthVec2(v: Vec2): number {
  return Math.hypot(v.x, v.y);
}

export function normalizeVec2(v: Vec2): Vec2 {
  const len = Math.hypot(v.x, v.y);
  if (len === 0) return { x: 0, y: 0 };
  return { x: v.x / len, y: v.y / len };
}

export function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(bx - ax, by - ay);
}

export function distanceSq(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function inverseLerp(a: number, b: number, value: number): number {
  if (a === b) return 0;
  return (value - a) / (b - a);
}

/** Smooth 0..1 ramp; the classic smoothstep. */
export function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01(inverseLerp(edge0, edge1, value));
  return t * t * (3 - 2 * t);
}

export const TAU = Math.PI * 2;

/** Wrap an angle into (-PI, PI]. */
export function wrapAngle(angle: number): number {
  let a = angle % TAU;
  if (a > Math.PI) a -= TAU;
  if (a <= -Math.PI) a += TAU;
  return a;
}

/** Smallest signed rotation that takes `from` to `to`. */
export function angleDelta(from: number, to: number): number {
  return wrapAngle(to - from);
}

/** Rotate `from` towards `to` by at most `maxStep` radians. */
export function rotateTowards(from: number, to: number, maxStep: number): number {
  const delta = angleDelta(from, to);
  if (Math.abs(delta) <= maxStep) return wrapAngle(to);
  return wrapAngle(from + Math.sign(delta) * maxStep);
}

export function angleBetween(ax: number, ay: number, bx: number, by: number): number {
  return Math.atan2(by - ay, bx - ax);
}

/** True when `point` lies inside the cone of half-width `halfAngle` around `facing`. */
export function withinCone(
  originX: number,
  originY: number,
  facing: number,
  halfAngle: number,
  pointX: number,
  pointY: number,
): boolean {
  const to = angleBetween(originX, originY, pointX, pointY);
  return Math.abs(angleDelta(facing, to)) <= halfAngle;
}

/** Axis-aligned bounding box, top-left origin. */
export interface Aabb {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function aabbOverlaps(a: Aabb, b: Aabb): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function aabbContainsPoint(a: Aabb, x: number, y: number): boolean {
  return x >= a.x && x < a.x + a.w && y >= a.y && y < a.y + a.h;
}

export function circleOverlapsAabb(cx: number, cy: number, r: number, box: Aabb): boolean {
  const nearestX = clamp(cx, box.x, box.x + box.w);
  const nearestY = clamp(cy, box.y, box.y + box.h);
  return distanceSq(cx, cy, nearestX, nearestY) <= r * r;
}

export function circlesOverlap(
  ax: number,
  ay: number,
  ar: number,
  bx: number,
  by: number,
  br: number,
): boolean {
  const r = ar + br;
  return distanceSq(ax, ay, bx, by) <= r * r;
}

/**
 * Shortest distance from point (px,py) to the segment (ax,ay)-(bx,by).
 * Used by melee arc and projectile sweep tests.
 */
export function pointToSegmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  const t = clamp01(((px - ax) * dx + (py - ay) * dy) / lenSq);
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

/** Four cardinal directions, in the order used by rotation indices. */
export const CARDINALS: readonly Vec2[] = [
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 0, y: -1 },
];

/** Eight-way neighbour offsets. */
export const NEIGHBORS_8: readonly Vec2[] = [
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
  { x: -1, y: 1 },
  { x: -1, y: 0 },
  { x: -1, y: -1 },
  { x: 0, y: -1 },
  { x: 1, y: -1 },
];
