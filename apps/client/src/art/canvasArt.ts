import { hashNoise, hashString } from '@survive/protocol';
import {
  CATEGORY_COLOR,
  cssColor,
  DEFAULT_ANIMAL_COLOR,
  DEFAULT_NODE_COLOR,
  DEFAULT_STRUCTURE_COLOR,
  DEFAULT_ZOMBIE_COLOR,
  ANIMAL_COLOR,
  NODE_COLOR,
  STRUCTURE_COLOR,
  ZOMBIE_COLOR,
  shade,
  tilePaint,
} from './palette';

/**
 * Procedural art.
 *
 * Every texture in the game is drawn here, into an offscreen canvas, at boot. Pure
 * canvas work with no Phaser types, so it can be reasoned about (and swapped out) on its
 * own. The drawing is deterministic - all variation comes from `hashNoise` seeded by the
 * texture key - so a tile looks the same every session and across machines.
 */

export const TILE_PX = 32;

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  ctx.imageSmoothingEnabled = false;
  return ctx;
}

/** Deterministic speckle pass: the thing that stops flat colour looking like a bug. */
function speckle(
  ctx: CanvasRenderingContext2D,
  seed: number,
  width: number,
  height: number,
  color: number,
  amount: number,
): void {
  if (amount <= 0) return;
  const count = Math.round(width * height * amount * 0.25);
  ctx.fillStyle = cssColor(color, 0.55);
  for (let i = 0; i < count; i++) {
    const x = Math.floor(hashNoise(seed, i, 1) * width);
    const y = Math.floor(hashNoise(seed, i, 2) * height);
    const size = hashNoise(seed, i, 3) < 0.22 ? 2 : 1;
    ctx.fillRect(x, y, size, size);
  }
}

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

/**
 * One tile, in one of four deterministic variants.
 *
 * Variants are picked per world position by the renderer, which breaks up the grid
 * without needing a bigger palette.
 */
export function drawTile(tileId: number, variant: number): HTMLCanvasElement {
  const canvas = makeCanvas(TILE_PX, TILE_PX);
  const ctx = context2d(canvas);
  const paint = tilePaint(tileId);
  const seed = hashString(`tile:${tileId}:${variant}`);

  ctx.fillStyle = cssColor(paint.base);
  ctx.fillRect(0, 0, TILE_PX, TILE_PX);
  speckle(ctx, seed, TILE_PX, TILE_PX, paint.speckle, paint.grain);

  if (paint.edge !== undefined) {
    // Solid tiles get an inset border so walls read as walls at a glance.
    ctx.strokeStyle = cssColor(paint.edge, 0.9);
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, TILE_PX - 2, TILE_PX - 2);
    ctx.fillStyle = cssColor(shade(paint.base, 0.12), 0.5);
    ctx.fillRect(2, 2, TILE_PX - 4, 3);
  }
  return canvas;
}

// ---------------------------------------------------------------------------
// Creatures
// ---------------------------------------------------------------------------

export interface CreatureSpec {
  /** Diameter in pixels. */
  size: number;
  body: number;
  trim: number;
  /** Draw the elongated silhouette used for four-legged animals. */
  quadruped?: boolean;
  /** Draw the low, sprawled silhouette used for crawlers. */
  prone?: boolean;
}

/**
 * A top-down creature.
 *
 * Sprites are drawn facing +X (0 radians) and rotated by the renderer, which is why
 * the shoulders and the facing wedge sit on the right-hand side here.
 */
export function drawCreature(key: string, spec: CreatureSpec): HTMLCanvasElement {
  const size = spec.size;
  const canvas = makeCanvas(size, size);
  const ctx = context2d(canvas);
  const seed = hashString(`creature:${key}`);
  const cx = size / 2;
  const cy = size / 2;
  const radius = size * (spec.prone ? 0.3 : 0.36);

  ctx.save();
  // Soft ground shadow: cheap, and it stops sprites floating over the terrain.
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.beginPath();
  ctx.ellipse(cx, cy + size * 0.06, radius * 1.05, radius * 0.72, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = cssColor(spec.body);
  ctx.beginPath();
  if (spec.quadruped) {
    ctx.ellipse(cx, cy, radius * 1.25, radius * 0.72, 0, 0, Math.PI * 2);
  } else if (spec.prone) {
    ctx.ellipse(cx, cy, radius * 1.35, radius * 0.6, 0, 0, Math.PI * 2);
  } else {
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  }
  ctx.fill();

  // Shoulders / haunches, giving the silhouette a front.
  ctx.fillStyle = cssColor(spec.trim);
  ctx.beginPath();
  ctx.ellipse(cx + radius * 0.42, cy, radius * 0.5, radius * 0.66, 0, 0, Math.PI * 2);
  ctx.fill();

  // Head.
  ctx.fillStyle = cssColor(shade(spec.body, 0.18));
  ctx.beginPath();
  ctx.arc(cx + radius * 0.82, cy, radius * 0.34, 0, Math.PI * 2);
  ctx.fill();

  // Facing notch, so a stationary creature still shows which way it is looking.
  ctx.fillStyle = cssColor(shade(spec.trim, -0.35));
  ctx.beginPath();
  ctx.moveTo(cx + radius * 1.18, cy);
  ctx.lineTo(cx + radius * 0.7, cy - radius * 0.24);
  ctx.lineTo(cx + radius * 0.7, cy + radius * 0.24);
  ctx.closePath();
  ctx.fill();

  speckle(ctx, seed, size, size, shade(spec.body, -0.3), 0.06);
  ctx.restore();
  return canvas;
}

export function zombieSpec(defId: string, radius: number, crawling = false): CreatureSpec {
  const colors = ZOMBIE_COLOR[defId] ?? DEFAULT_ZOMBIE_COLOR;
  return {
    size: Math.max(16, Math.round(radius * 2.6)),
    body: colors.body,
    trim: colors.trim,
    ...(crawling ? { prone: true } : {}),
  };
}

export function animalSpec(defId: string, radius: number): CreatureSpec {
  const colors = ANIMAL_COLOR[defId] ?? DEFAULT_ANIMAL_COLOR;
  return {
    size: Math.max(14, Math.round(radius * 3)),
    body: colors.body,
    trim: colors.trim,
    quadruped: true,
  };
}

/** The player: distinct from every zombie by being the only blue-grey silhouette. */
export function drawPlayer(variant: 'self' | 'remote'): HTMLCanvasElement {
  const body = variant === 'self' ? 0x9fb4c4 : 0x8a9aa8;
  const trim = variant === 'self' ? 0x51697a : 0x4a5a66;
  return drawCreature(`player:${variant}`, { size: 30, body, trim });
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export const ICON_PX = 28;

/**
 * An item icon.
 *
 * With 180-odd items, hand-authoring is out; the shape comes from the category (so a
 * weapon never looks like a vegetable) and the details are hashed from the id (so two
 * weapons do not look identical).
 */
export function drawItemIcon(
  defId: string,
  category: string,
  tags: readonly string[],
): HTMLCanvasElement {
  const canvas = makeCanvas(ICON_PX, ICON_PX);
  const ctx = context2d(canvas);
  const seed = hashString(`item:${defId}`);
  const base = CATEGORY_COLOR[category] ?? CATEGORY_COLOR.misc ?? 0x8e8e8e;
  const hueShift = (hashNoise(seed, 1, 1) - 0.5) * 0.34;
  const color = shade(base, hueShift);
  const dark = shade(color, -0.42);
  const light = shade(color, 0.28);
  const mid = ICON_PX / 2;

  ctx.save();
  switch (category) {
    case 'weapon': {
      const twoHanded = tags.includes('twoHanded') || hashNoise(seed, 2, 1) > 0.5;
      // A haft with a head: reads as "weapon" at 28px in a way an outline does not.
      ctx.strokeStyle = cssColor(0x6b5335);
      ctx.lineWidth = twoHanded ? 4 : 3;
      ctx.beginPath();
      ctx.moveTo(6, ICON_PX - 5);
      ctx.lineTo(ICON_PX - 8, 7);
      ctx.stroke();
      ctx.fillStyle = cssColor(color);
      ctx.beginPath();
      ctx.moveTo(ICON_PX - 12, 4);
      ctx.lineTo(ICON_PX - 3, 9);
      ctx.lineTo(ICON_PX - 9, 14);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'tool': {
      ctx.strokeStyle = cssColor(0x6b5335);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(8, ICON_PX - 5);
      ctx.lineTo(ICON_PX - 10, 8);
      ctx.stroke();
      ctx.fillStyle = cssColor(color);
      ctx.fillRect(ICON_PX - 14, 3, 11, 8);
      ctx.fillStyle = cssColor(light, 0.7);
      ctx.fillRect(ICON_PX - 14, 3, 11, 3);
      break;
    }
    case 'armor': {
      ctx.fillStyle = cssColor(color);
      ctx.beginPath();
      ctx.moveTo(mid, 4);
      ctx.lineTo(ICON_PX - 5, 9);
      ctx.lineTo(ICON_PX - 7, ICON_PX - 5);
      ctx.lineTo(7, ICON_PX - 5);
      ctx.lineTo(5, 9);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = cssColor(dark);
      ctx.lineWidth = 2;
      ctx.stroke();
      break;
    }
    case 'food':
    case 'produce': {
      ctx.fillStyle = cssColor(color);
      ctx.beginPath();
      ctx.ellipse(mid, mid + 2, 9, 8, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = cssColor(0x4a6a3c);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(mid, mid - 6);
      ctx.lineTo(mid + 4, mid - 11);
      ctx.stroke();
      break;
    }
    case 'drink': {
      ctx.fillStyle = cssColor(dark);
      ctx.fillRect(mid - 6, 5, 12, ICON_PX - 10);
      ctx.fillStyle = cssColor(color);
      ctx.fillRect(mid - 4, 11, 8, ICON_PX - 17);
      ctx.fillStyle = cssColor(light);
      ctx.fillRect(mid - 3, 3, 6, 4);
      break;
    }
    case 'medical': {
      ctx.fillStyle = cssColor(0xe4e0d8);
      ctx.fillRect(4, 8, ICON_PX - 8, ICON_PX - 16);
      ctx.fillStyle = cssColor(color);
      ctx.fillRect(mid - 2, 10, 4, ICON_PX - 20);
      ctx.fillRect(7, mid - 2, ICON_PX - 14, 4);
      break;
    }
    case 'seed': {
      ctx.fillStyle = cssColor(color);
      for (let i = 0; i < 4; i++) {
        const x = 7 + (i % 2) * 10 + hashNoise(seed, i, 4) * 3;
        const y = 8 + Math.floor(i / 2) * 9 + hashNoise(seed, i, 5) * 3;
        ctx.beginPath();
        ctx.ellipse(x, y, 3.2, 4.4, 0.5, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case 'ammo': {
      ctx.fillStyle = cssColor(color);
      for (let i = 0; i < 3; i++) {
        const x = 6 + i * 7;
        ctx.fillRect(x, 9, 5, 12);
        ctx.beginPath();
        ctx.moveTo(x, 9);
        ctx.lineTo(x + 2.5, 4);
        ctx.lineTo(x + 5, 9);
        ctx.closePath();
        ctx.fill();
      }
      break;
    }
    case 'placeable':
    case 'container': {
      ctx.fillStyle = cssColor(color);
      ctx.fillRect(4, 8, ICON_PX - 8, ICON_PX - 13);
      ctx.strokeStyle = cssColor(dark);
      ctx.lineWidth = 2;
      ctx.strokeRect(5, 9, ICON_PX - 10, ICON_PX - 15);
      ctx.fillStyle = cssColor(dark);
      ctx.fillRect(4, mid, ICON_PX - 8, 3);
      break;
    }
    case 'fuel': {
      ctx.fillStyle = cssColor(color);
      for (let i = 0; i < 3; i++) {
        ctx.save();
        ctx.translate(mid, mid);
        ctx.rotate((i / 3) * Math.PI);
        ctx.fillRect(-10, -2.5, 20, 5);
        ctx.restore();
      }
      break;
    }
    default: {
      // Resources and components: a chunky nugget with a highlight.
      ctx.fillStyle = cssColor(color);
      ctx.beginPath();
      ctx.moveTo(mid, 5);
      ctx.lineTo(ICON_PX - 6, mid - 3);
      ctx.lineTo(ICON_PX - 9, ICON_PX - 6);
      ctx.lineTo(9, ICON_PX - 6);
      ctx.lineTo(6, mid - 3);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = cssColor(light, 0.65);
      ctx.beginPath();
      ctx.moveTo(mid, 5);
      ctx.lineTo(ICON_PX - 6, mid - 3);
      ctx.lineTo(mid, mid);
      ctx.closePath();
      ctx.fill();
      break;
    }
  }
  ctx.restore();
  return canvas;
}

// ---------------------------------------------------------------------------
// Structures
// ---------------------------------------------------------------------------

export interface StructureArtSpec {
  category: string;
  widthTiles: number;
  heightTiles: number;
  /** Draw the open state of a door. */
  open?: boolean;
}

export function drawStructure(defId: string, spec: StructureArtSpec): HTMLCanvasElement {
  const width = Math.max(1, spec.widthTiles) * TILE_PX;
  const height = Math.max(1, spec.heightTiles) * TILE_PX;
  const canvas = makeCanvas(width, height);
  const ctx = context2d(canvas);
  const colors = STRUCTURE_COLOR[spec.category] ?? DEFAULT_STRUCTURE_COLOR;
  const seed = hashString(`structure:${defId}`);

  ctx.fillStyle = cssColor(colors.fill);
  ctx.fillRect(0, 0, width, height);
  speckle(ctx, seed, width, height, shade(colors.fill, -0.25), 0.12);

  ctx.strokeStyle = cssColor(colors.edge);
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, width - 2, height - 2);

  switch (spec.category) {
    case 'wall':
      // Course lines, so a wall reads as masonry rather than a flat block.
      ctx.strokeStyle = cssColor(colors.edge, 0.55);
      ctx.lineWidth = 1;
      for (let y = 8; y < height; y += 8) {
        ctx.beginPath();
        ctx.moveTo(2, y);
        ctx.lineTo(width - 2, y);
        ctx.stroke();
      }
      break;
    case 'door':
      if (spec.open) {
        ctx.clearRect(3, 3, width - 6, height - 6);
        ctx.fillStyle = cssColor(colors.fill, 0.9);
        ctx.fillRect(width - 8, 2, 6, height - 4);
      } else {
        ctx.fillStyle = cssColor(shade(colors.fill, 0.14));
        ctx.fillRect(4, 4, width - 8, height - 8);
        ctx.fillStyle = cssColor(0xd8c274);
        ctx.beginPath();
        ctx.arc(width - 8, height / 2, 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    case 'window':
      ctx.fillStyle = cssColor(0x84a7b1, 0.75);
      ctx.fillRect(4, 4, width - 8, height - 8);
      ctx.strokeStyle = cssColor(colors.edge);
      ctx.beginPath();
      ctx.moveTo(width / 2, 3);
      ctx.lineTo(width / 2, height - 3);
      ctx.stroke();
      break;
    case 'storage':
      ctx.strokeStyle = cssColor(shade(colors.edge, 0.2));
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(3, height * 0.38);
      ctx.lineTo(width - 3, height * 0.38);
      ctx.stroke();
      ctx.fillStyle = cssColor(0xb8a25e);
      ctx.fillRect(width / 2 - 3, height * 0.34, 6, 7);
      break;
    case 'station':
      ctx.fillStyle = cssColor(shade(colors.fill, -0.28));
      ctx.fillRect(width * 0.18, height * 0.2, width * 0.64, height * 0.5);
      ctx.fillStyle = cssColor(0xc06a3a, 0.85);
      ctx.beginPath();
      ctx.arc(width / 2, height * 0.68, Math.min(width, height) * 0.14, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'farm':
      ctx.strokeStyle = cssColor(shade(colors.fill, -0.3));
      ctx.lineWidth = 2;
      for (let x = 6; x < width; x += 7) {
        ctx.beginPath();
        ctx.moveTo(x, 3);
        ctx.lineTo(x, height - 3);
        ctx.stroke();
      }
      break;
    case 'light':
      ctx.fillStyle = cssColor(0xf0d284, 0.9);
      ctx.beginPath();
      ctx.arc(width / 2, height / 2, Math.min(width, height) * 0.2, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'bed':
      ctx.fillStyle = cssColor(0xc9bfae);
      ctx.fillRect(4, 4, width - 8, height * 0.32);
      break;
    case 'defense':
      ctx.strokeStyle = cssColor(0x9aa0a4);
      ctx.lineWidth = 2;
      for (let i = 0; i < 5; i++) {
        const x = 5 + i * ((width - 10) / 4);
        ctx.beginPath();
        ctx.moveTo(x, height - 4);
        ctx.lineTo(x, 5);
        ctx.stroke();
      }
      break;
    default:
      break;
  }
  return canvas;
}

// ---------------------------------------------------------------------------
// Resource nodes
// ---------------------------------------------------------------------------

export interface NodeArtSpec {
  category: string;
  /** Collision radius in pixels; the art is drawn a little larger. */
  radius: number;
  variant: number;
}

export function drawNode(defId: string, spec: NodeArtSpec): HTMLCanvasElement {
  const colors = NODE_COLOR[spec.category] ?? DEFAULT_NODE_COLOR;
  const seed = hashString(`node:${defId}:${spec.variant}`);
  const isTree = spec.category === 'tree';
  const size = Math.max(20, Math.round(spec.radius * (isTree ? 4.4 : 2.9)));
  const canvas = makeCanvas(size, size);
  const ctx = context2d(canvas);
  const cx = size / 2;
  const cy = size / 2;

  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath();
  ctx.ellipse(cx, cy + size * 0.08, size * 0.3, size * 0.2, 0, 0, Math.PI * 2);
  ctx.fill();

  switch (spec.category) {
    case 'tree': {
      ctx.fillStyle = cssColor(colors.secondary);
      ctx.fillRect(cx - size * 0.06, cy, size * 0.12, size * 0.34);
      // Three offset blobs read as a canopy from directly above.
      for (let i = 0; i < 3; i++) {
        const angle = (i / 3) * Math.PI * 2 + hashNoise(seed, i, 1) * 1.4;
        const distance = size * 0.11 * (0.6 + hashNoise(seed, i, 2));
        ctx.fillStyle = cssColor(shade(colors.primary, (hashNoise(seed, i, 3) - 0.5) * 0.3));
        ctx.beginPath();
        ctx.arc(
          cx + Math.cos(angle) * distance,
          cy + Math.sin(angle) * distance - size * 0.04,
          size * 0.26,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
      break;
    }
    case 'rock':
    case 'ore': {
      ctx.fillStyle = cssColor(colors.primary);
      ctx.beginPath();
      const points = 6;
      for (let i = 0; i < points; i++) {
        const angle = (i / points) * Math.PI * 2;
        const r = size * (0.28 + hashNoise(seed, i, 1) * 0.1);
        const x = cx + Math.cos(angle) * r;
        const y = cy + Math.sin(angle) * r * 0.85;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
      if (spec.category === 'ore') {
        // Veins, so a copper node is distinguishable from a plain boulder.
        ctx.fillStyle = cssColor(colors.secondary);
        for (let i = 0; i < 4; i++) {
          const x = cx + (hashNoise(seed, i, 5) - 0.5) * size * 0.4;
          const y = cy + (hashNoise(seed, i, 6) - 0.5) * size * 0.4;
          ctx.beginPath();
          ctx.arc(x, y, size * 0.05, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      break;
    }
    case 'bush':
    case 'plant': {
      ctx.fillStyle = cssColor(colors.primary);
      for (let i = 0; i < 4; i++) {
        const angle = (i / 4) * Math.PI * 2;
        ctx.beginPath();
        ctx.ellipse(
          cx + Math.cos(angle) * size * 0.12,
          cy + Math.sin(angle) * size * 0.12,
          size * 0.19,
          size * 0.16,
          angle,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
      ctx.fillStyle = cssColor(colors.secondary);
      for (let i = 0; i < 5; i++) {
        const x = cx + (hashNoise(seed, i, 7) - 0.5) * size * 0.44;
        const y = cy + (hashNoise(seed, i, 8) - 0.5) * size * 0.44;
        ctx.beginPath();
        ctx.arc(x, y, size * 0.045, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case 'water': {
      ctx.fillStyle = cssColor(colors.primary, 0.9);
      ctx.beginPath();
      ctx.ellipse(cx, cy, size * 0.34, size * 0.28, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = cssColor(colors.secondary, 0.8);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, size * 0.2, size * 0.15, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    default: {
      ctx.fillStyle = cssColor(colors.primary);
      ctx.fillRect(cx - size * 0.26, cy - size * 0.2, size * 0.52, size * 0.42);
      ctx.fillStyle = cssColor(colors.secondary);
      ctx.fillRect(cx - size * 0.16, cy - size * 0.28, size * 0.32, size * 0.16);
      break;
    }
  }
  return canvas;
}

// ---------------------------------------------------------------------------
// Crops
// ---------------------------------------------------------------------------

/** A crop at a growth stage: a sprout, a bush, then a ripe plant. */
export function drawCrop(cropId: string, stage: number, stages: number): HTMLCanvasElement {
  const canvas = makeCanvas(TILE_PX, TILE_PX);
  const ctx = context2d(canvas);
  const seed = hashString(`crop:${cropId}`);
  const progress = stages <= 1 ? 1 : Math.min(1, stage / (stages - 1));
  const green = shade(0x4f7a35, (hashNoise(seed, 1, 1) - 0.5) * 0.3);
  const ripe = shade(0xc9903c, (hashNoise(seed, 2, 1) - 0.5) * 0.4);
  const cx = TILE_PX / 2;
  const base = TILE_PX - 6;
  const height = 5 + progress * 17;

  ctx.strokeStyle = cssColor(green);
  ctx.lineWidth = 2;
  for (let i = 0; i < 3; i++) {
    const offset = (i - 1) * 5;
    ctx.beginPath();
    ctx.moveTo(cx + offset, base);
    ctx.lineTo(cx + offset * 1.5, base - height * (0.7 + hashNoise(seed, i, 3) * 0.4));
    ctx.stroke();
  }

  if (progress >= 0.99) {
    ctx.fillStyle = cssColor(ripe);
    for (let i = 0; i < 3; i++) {
      const x = cx + (i - 1) * 6;
      const y = base - height * 0.85;
      ctx.beginPath();
      ctx.arc(x, y, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return canvas;
}

/** A dead or blighted crop: the same silhouette, drained of colour. */
export function drawDeadCrop(): HTMLCanvasElement {
  const canvas = makeCanvas(TILE_PX, TILE_PX);
  const ctx = context2d(canvas);
  ctx.strokeStyle = cssColor(0x6b6152);
  ctx.lineWidth = 2;
  for (let i = 0; i < 3; i++) {
    const offset = (i - 1) * 5;
    ctx.beginPath();
    ctx.moveTo(TILE_PX / 2 + offset, TILE_PX - 6);
    ctx.lineTo(TILE_PX / 2 + offset * 2.2, TILE_PX - 16);
    ctx.stroke();
  }
  return canvas;
}

// ---------------------------------------------------------------------------
// Effects and UI bits
// ---------------------------------------------------------------------------

/** A soft radial blob, used for light pools, muzzle flashes and blood puffs. */
export function drawSoftCircle(size: number, color: number, innerAlpha = 0.85): HTMLCanvasElement {
  const canvas = makeCanvas(size, size);
  const ctx = context2d(canvas);
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, cssColor(color, innerAlpha));
  gradient.addColorStop(0.55, cssColor(color, innerAlpha * 0.4));
  gradient.addColorStop(1, cssColor(color, 0));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

/** A 1x1 white pixel. Tinted and stretched for bars, overlays and flashes. */
export function drawPixel(): HTMLCanvasElement {
  const canvas = makeCanvas(1, 1);
  const ctx = context2d(canvas);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 1, 1);
  return canvas;
}

/** A small square particle. */
export function drawParticle(size: number, color: number): HTMLCanvasElement {
  const canvas = makeCanvas(size, size);
  const ctx = context2d(canvas);
  ctx.fillStyle = cssColor(color);
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

/** A thin projectile streak, drawn pointing +X. */
export function drawProjectile(length: number, color: number): HTMLCanvasElement {
  const canvas = makeCanvas(length, 4);
  const ctx = context2d(canvas);
  ctx.fillStyle = cssColor(color);
  ctx.fillRect(0, 1, length, 2);
  ctx.fillStyle = cssColor(shade(color, 0.5));
  ctx.fillRect(length - 3, 0, 3, 4);
  return canvas;
}

/** A hollow ring, used for selection and placement highlights. */
export function drawRing(size: number, color: number, thickness = 2): HTMLCanvasElement {
  const canvas = makeCanvas(size, size);
  const ctx = context2d(canvas);
  ctx.strokeStyle = cssColor(color);
  ctx.lineWidth = thickness;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - thickness, 0, Math.PI * 2);
  ctx.stroke();
  return canvas;
}

/** A tile-sized outlined square, for the build ghost and tile cursor. */
export function drawTileOutline(color: number, filled: boolean): HTMLCanvasElement {
  const canvas = makeCanvas(TILE_PX, TILE_PX);
  const ctx = context2d(canvas);
  if (filled) {
    ctx.fillStyle = cssColor(color, 0.22);
    ctx.fillRect(0, 0, TILE_PX, TILE_PX);
  }
  ctx.strokeStyle = cssColor(color, 0.9);
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, TILE_PX - 2, TILE_PX - 2);
  return canvas;
}
