import {
  CHUNK_TILES,
  MAX_SKILL_LEVEL,
  SKILL_IDS,
  TILE_SIZE,
  Tile,
  WORLD_TILES,
  biomeProps,
  chunkKey,
  type ChunkPayload,
  type PlayerState,
  type PlayerStats,
  type SkillId,
} from '@survive/protocol';
import { cumulativeXp, xpForLevel } from '@survive/simulation/core/skills';
import {
  DEFAULT_STRUCTURE_COLOR,
  STRUCTURE_COLOR,
  UI,
  cssColor,
  shade,
  tilePaint,
} from '../../art/palette';
import { button, el, humanize, panelFrame } from '../kit';
import type { Panel, UiContext } from '../panel';

/**
 * The map and the skills sheet.
 *
 * They share a file because they share nothing with anything else: both are read-only
 * views of state the client already has, neither sends a mutating command, and both are
 * small enough that splitting them would cost two style blocks and two sets of imports
 * for no gain.
 *
 * The rule both obey: **the client decides nothing**. The map draws the terrain the
 * server has actually sent (`session.store`'s chunk cache) and the entities inside the
 * area of interest — it cannot draw what the client was never told, and it does not
 * guess. The skills sheet renders `player.skills` and `player.stats` verbatim and
 * imports the *real* XP curve from the simulation rather than restating it, so the bar
 * can never disagree with the server about when the next level lands.
 */

// ---------------------------------------------------------------------------
// Shared styles
// ---------------------------------------------------------------------------

const STYLE_ID = 'survive-map-skills-styles';

/**
 * Panel-local styles, injected once from here.
 *
 * A canvas map and a skill sheet are layouts nothing else in the interface needs, so
 * they stay out of `kit.ts`'s shared stylesheet. Everything that *is* shared — `.panel`,
 * `.panel-body`, `.btn`, `.row`, `.col`, `.muted`, `.section-title`, `.bar` and its
 * parts, `.effect-chip` — is reused as-is rather than restyled.
 */
function injectMapSkillsStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .panel--map { width: min(472px, 94vw); }
    .map-body { display: flex; flex-direction: column; gap: 9px; }
    .map-canvas {
      /* The world layer sets pointer-events: none on .ui-root; the canvas needs it back
         to receive its own drag-to-pan and wheel-to-zoom. */
      pointer-events: auto;
      display: block; max-width: 100%; border-radius: 4px;
      border: 1px solid ${cssColor(UI.panelEdge)};
      background: ${cssColor(UI.panel)};
      cursor: grab; touch-action: none;
      image-rendering: pixelated;
    }
    .map-canvas:active { cursor: grabbing; }
    .map-controls { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .map-zoom { min-width: 30px; padding: 6px 8px; font-family: monospace; }
    .map-zoom-value {
      font-family: monospace; font-size: 11px; min-width: 62px; text-align: center;
      color: ${cssColor(UI.textMuted)};
    }
    .map-readout {
      display: grid; grid-template-columns: auto 1fr; gap: 2px 10px;
      font-size: 11px; align-items: baseline;
    }
    .map-readout dt {
      font-size: 10px; text-transform: uppercase; letter-spacing: 0.07em;
      color: ${cssColor(UI.textMuted)};
    }
    .map-readout dd { margin: 0; font-family: monospace; }
    .map-legend { display: flex; flex-wrap: wrap; gap: 4px 9px; font-size: 10px; }
    .map-legend span { display: inline-flex; align-items: center; gap: 4px; }
    .map-legend i {
      width: 8px; height: 8px; border-radius: 2px; display: inline-block;
      border: 1px solid rgba(0,0,0,0.5);
    }

    .panel--skills { width: min(560px, 94vw); }
    .skills-body { display: flex; flex-direction: column; gap: 6px; }
    .skills-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
    .skill-row {
      padding: 6px 8px; border-radius: 4px;
      background: ${cssColor(UI.slot, 0.6)};
      border: 1px solid ${cssColor(UI.slotEdge)};
      display: flex; flex-direction: column; gap: 3px;
    }
    .skill-row--max { border-color: ${cssColor(UI.accent, 0.55)}; }
    .skill-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
    .skill-name { font-weight: 600; }
    .skill-level { font-family: monospace; font-size: 11px; color: ${cssColor(UI.textMuted)}; }
    .skill-effect { margin: 0; font-size: 11px; line-height: 1.35; }
    .skill-xp { font-family: monospace; font-size: 10px; }
    .skills-stats {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(132px, 1fr));
      gap: 4px 12px; margin: 0;
    }
    .skills-stats div {
      display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
      padding: 2px 0; border-bottom: 1px solid ${cssColor(UI.panelEdge, 0.7)};
    }
    .skills-stats dt { font-size: 11px; color: ${cssColor(UI.textMuted)}; }
    .skills-stats dd { margin: 0; font-family: monospace; font-size: 12px; }
  `;
  document.head.append(style);
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** Thousands separators without `Intl`, so the same state renders the same text in a test. */
function formatInt(value: number): string {
  const rounded = Math.round(value);
  const sign = rounded < 0 ? '-' : '';
  const digits = String(Math.abs(rounded));
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i] ?? '';
  }
  return `${sign}${out}`;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

// ===========================================================================
// Map
// ===========================================================================

/** Pixels per tile the zoom control steps through. */
const ZOOM_STEPS: readonly number[] = [1, 2, 3, 4, 6, 8];

/**
 * Default zoom.
 *
 * `CHUNK_LOAD_RADIUS` is 2, so the client is normally holding a 5x5 block of chunks —
 * 160 tiles across. At 3 px/tile the canvas below shows ~140 tiles, which is very nearly
 * "everything you have been sent" without wasting half the panel on unexplored black.
 */
const DEFAULT_ZOOM_INDEX = 2;

const MAP_CSS_WIDTH = 424;
const MAP_CSS_HEIGHT = 344;

/**
 * Slowest useful redraw interval.
 *
 * `update` runs every rendered frame, and one redraw walks every loaded chunk and writes
 * tens of thousands of pixels. Five or six blits a second is indistinguishable from
 * smooth for a map and costs a twelfth of the work.
 */
const REDRAW_INTERVAL_MS = 180;

/** Colour for terrain the server has not sent. Distinct from any real tile paint. */
const UNEXPLORED_COLOR = 0x0a0e0f;

/** Legend entries. The colours are literally the ones the terrain pass writes. */
const LEGEND: readonly { label: string; tile: number }[] = [
  { label: 'Grass', tile: Tile.Grass },
  { label: 'Water', tile: Tile.WaterDeep },
  { label: 'Road', tile: Tile.RoadAsphalt },
  { label: 'Building', tile: Tile.WallConcrete },
  { label: 'Sand', tile: Tile.Sand },
  { label: 'Snow', tile: Tile.Snow },
];

interface MapParts {
  body: HTMLDivElement;
  canvas: HTMLCanvasElement;
  zoomValue: HTMLSpanElement;
  coords: HTMLElement;
  chunkLabel: HTMLElement;
  biome: HTMLElement;
  view: HTMLElement;
  biomesInView: HTMLElement;
}

/** Result of one terrain pass, fed back into the readout. */
interface TerrainPass {
  /** Tiles actually drawn, i.e. terrain the client has. */
  drawn: number;
  /** Biome id -> tile count, for the "biomes in view" line. */
  biomes: Map<number, number>;
}

/**
 * The local map.
 *
 * Drawn from `session.store`: `chunkKeys()` / `chunk(key)` for terrain, and
 * `entitiesOfKind()` for the markers. Terrain is rasterised one pixel per tile into an
 * offscreen canvas at *tile* resolution and then blitted up with smoothing off, so the
 * cost of a redraw is proportional to the tiles in view rather than to the pixels on
 * screen, and zooming in costs nothing extra.
 *
 * Colour comes from `tilePaint` rather than from a biome palette. Both were on the
 * table; tile paint wins because it is the colour the world is actually drawn in, so the
 * map matches what the player just walked over, and because the things you navigate by —
 * water, asphalt, building walls, snow — are tile distinctions that a biome-level palette
 * flattens away. `BIOME_PROPS` still earns its place in the text: the biome under your
 * feet and the biomes on screen are named in the readout, which is what you say out loud
 * to someone else ("I'm in the deep forest north of town").
 */
export function createMapPanel(): Panel {
  let zoomIndex = DEFAULT_ZOOM_INDEX;
  /** Viewport centre, in fractional tiles. Only meaningful while `follow` is false. */
  let centerTileX = 0;
  let centerTileY = 0;
  /** True while the map tracks the player. Any pan turns it off; the button turns it on. */
  let follow = true;

  let parts: MapParts | null = null;
  let canvas2d: CanvasRenderingContext2D | null = null;
  /** Tile-resolution scratch buffer, resized when the visible tile count changes. */
  const offscreen = document.createElement('canvas');
  let offscreen2d: CanvasRenderingContext2D | null = null;

  let lastDrawMs = 0;
  let drawSignature = '';
  let readoutSignature = '';
  let dragPointerId: number | null = null;
  let dragLastX = 0;
  let dragLastY = 0;

  function zoom(): number {
    return ZOOM_STEPS[zoomIndex] ?? 3;
  }

  function stepZoom(delta: number): void {
    zoomIndex = clamp(zoomIndex + delta, 0, ZOOM_STEPS.length - 1);
    // Force the next update through the interval gate: a zoom change must feel instant.
    drawSignature = '';
    lastDrawMs = 0;
  }

  function ensureParts(): MapParts {
    if (parts) return parts;

    const canvas = el('canvas', {
      className: 'map-canvas',
      attrs: {
        role: 'img',
        'aria-label': 'Local map of explored terrain',
        'data-testid': 'map-canvas',
      },
    });
    canvas.style.width = `${MAP_CSS_WIDTH}px`;
    canvas.style.height = `${MAP_CSS_HEIGHT}px`;

    // Drag to pan. Pointer capture keeps the gesture alive when the cursor leaves the
    // canvas, which matters because the canvas is only 424 px wide.
    canvas.addEventListener('pointerdown', (event: PointerEvent) => {
      dragPointerId = event.pointerId;
      dragLastX = event.clientX;
      dragLastY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointermove', (event: PointerEvent) => {
      if (dragPointerId !== event.pointerId) return;
      const dx = event.clientX - dragLastX;
      const dy = event.clientY - dragLastY;
      if (dx === 0 && dy === 0) return;
      dragLastX = event.clientX;
      dragLastY = event.clientY;
      // On a viewport narrower than the panel, CSS scales the canvas down, so a pointer
      // moves fewer document pixels than map pixels. Measure the rendered width and
      // divide it out, or panning would lag the cursor exactly on small screens.
      const rendered = canvas.getBoundingClientRect().width;
      const display = rendered > 0 ? rendered / MAP_CSS_WIDTH : 1;
      const perTile = zoom() * display;
      // Dragging the map moves the terrain with the cursor, so the centre moves against
      // it. Fractional tiles are kept, otherwise a slow drag at 8 px/tile never moves.
      centerTileX = clamp(centerTileX - dx / perTile, 0, WORLD_TILES - 1);
      centerTileY = clamp(centerTileY - dy / perTile, 0, WORLD_TILES - 1);
      follow = false;
      drawSignature = '';
    });
    const endDrag = (event: PointerEvent): void => {
      if (dragPointerId !== event.pointerId) return;
      dragPointerId = null;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('wheel', (event: WheelEvent) => {
      // The buttons are the accessible control; the wheel is the one everybody reaches
      // for. `preventDefault` stops the gesture scrolling the panel body underneath.
      event.preventDefault();
      stepZoom(event.deltaY < 0 ? 1 : -1);
    });

    const zoomValue = el('span', {
      className: 'map-zoom-value',
      attrs: { 'data-testid': 'map-zoom-value', 'aria-live': 'polite' },
      // Seeded so the control reads correctly before the first snapshot arrives; every
      // redraw rewrites it.
      text: `${zoom()} px/tile`,
    });

    const zoomOut = button('−', () => stepZoom(-1));
    zoomOut.classList.add('map-zoom');
    zoomOut.setAttribute('aria-label', 'Zoom out');
    zoomOut.setAttribute('data-testid', 'map-zoom-out');

    const zoomIn = button('+', () => stepZoom(1));
    zoomIn.classList.add('map-zoom');
    zoomIn.setAttribute('aria-label', 'Zoom in');
    zoomIn.setAttribute('data-testid', 'map-zoom-in');

    const recentre = button(
      'Centre on me',
      () => {
        follow = true;
        drawSignature = '';
      },
      'primary',
    );
    recentre.setAttribute('data-testid', 'map-center');

    const makeRow = (label: string, testId: string): { dd: HTMLElement; nodes: HTMLElement[] } => {
      const dd = el('dd', { attrs: { 'data-testid': testId }, text: '—' });
      return { dd, nodes: [el('dt', { text: label }), dd] };
    };
    const coordsRow = makeRow('Tile', 'map-coords');
    const chunkRow = makeRow('Chunk', 'map-chunk');
    const biomeRow = makeRow('Biome', 'map-biome');
    const viewRow = makeRow('View', 'map-view');
    const biomesRow = makeRow('In view', 'map-biomes');

    const readout = el('dl', {
      className: 'map-readout',
      attrs: { 'data-testid': 'map-readout' },
      children: [
        ...coordsRow.nodes,
        ...chunkRow.nodes,
        ...biomeRow.nodes,
        ...viewRow.nodes,
        ...biomesRow.nodes,
      ],
    });

    const legend = el('div', {
      className: 'map-legend muted',
      attrs: { 'data-testid': 'map-legend' },
      children: LEGEND.map((entry) => {
        const swatch = el('i');
        swatch.style.background = cssColor(tilePaint(entry.tile).base);
        return el('span', { children: [swatch, el('span', { text: entry.label })] });
      }),
    });

    const body = el('div', {
      className: 'panel-body map-body',
      children: [
        canvas,
        el('div', {
          className: 'map-controls',
          children: [zoomOut, zoomValue, zoomIn, recentre],
        }),
        readout,
        legend,
      ],
    });

    parts = {
      body,
      canvas,
      zoomValue,
      coords: coordsRow.dd,
      chunkLabel: chunkRow.dd,
      biome: biomeRow.dd,
      view: viewRow.dd,
      biomesInView: biomesRow.dd,
    };
    return parts;
  }

  /**
   * Rasterise terrain into the offscreen buffer, one pixel per tile.
   *
   * Iterates loaded *chunks* and indexes straight into their tile arrays rather than
   * calling `store.tileAt` per pixel: same result, one map lookup per chunk instead of
   * one per tile, and chunks the server has not sent simply contribute nothing, which is
   * exactly the "unexplored" semantics we want.
   */
  function drawTerrain(
    chunks: ChunkPayload[],
    originTileX: number,
    originTileY: number,
    viewTilesX: number,
    viewTilesY: number,
  ): TerrainPass {
    const pass: TerrainPass = { drawn: 0, biomes: new Map<number, number>() };
    if (!offscreen2d) return pass;

    const image = offscreen2d.createImageData(viewTilesX, viewTilesY);
    const data = image.data;

    for (const chunk of chunks) {
      const baseX = chunk.cx * CHUNK_TILES;
      const baseY = chunk.cy * CHUNK_TILES;
      const fromX = Math.max(originTileX, baseX);
      const toX = Math.min(originTileX + viewTilesX, baseX + CHUNK_TILES);
      const fromY = Math.max(originTileY, baseY);
      const toY = Math.min(originTileY + viewTilesY, baseY + CHUNK_TILES);
      if (fromX >= toX || fromY >= toY) continue;

      for (let tileY = fromY; tileY < toY; tileY++) {
        const rowInChunk = (tileY - baseY) * CHUNK_TILES;
        const rowInImage = (tileY - originTileY) * viewTilesX;
        for (let tileX = fromX; tileX < toX; tileX++) {
          const index = rowInChunk + (tileX - baseX);
          const tile = chunk.tiles[index];
          if (tile === undefined) continue;
          const base = tilePaint(tile).base;
          const offset = (rowInImage + (tileX - originTileX)) * 4;
          data[offset] = (base >> 16) & 0xff;
          data[offset + 1] = (base >> 8) & 0xff;
          data[offset + 2] = base & 0xff;
          data[offset + 3] = 255;
          pass.drawn++;
          const biome = chunk.biomes[index];
          if (biome !== undefined) pass.biomes.set(biome, (pass.biomes.get(biome) ?? 0) + 1);
        }
      }
    }

    offscreen2d.putImageData(image, 0, 0);
    return pass;
  }

  /** Faint chunk boundaries. Only worth drawing once a chunk is bigger than a thumbnail. */
  function drawChunkGrid(
    target: CanvasRenderingContext2D,
    originTileX: number,
    originTileY: number,
    scale: number,
  ): void {
    target.strokeStyle = 'rgba(255,255,255,0.055)';
    target.lineWidth = 1;
    target.beginPath();
    const firstX = Math.ceil(originTileX / CHUNK_TILES) * CHUNK_TILES;
    for (let tileX = firstX; tileX < originTileX + MAP_CSS_WIDTH / scale; tileX += CHUNK_TILES) {
      const x = Math.round((tileX - originTileX) * scale) + 0.5;
      target.moveTo(x, 0);
      target.lineTo(x, MAP_CSS_HEIGHT);
    }
    const firstY = Math.ceil(originTileY / CHUNK_TILES) * CHUNK_TILES;
    for (let tileY = firstY; tileY < originTileY + MAP_CSS_HEIGHT / scale; tileY += CHUNK_TILES) {
      const y = Math.round((tileY - originTileY) * scale) + 0.5;
      target.moveTo(0, y);
      target.lineTo(MAP_CSS_WIDTH, y);
    }
    target.stroke();
  }

  /** One redraw: terrain blit, chunk grid, structure markers, players, then the arrow. */
  function redraw(ctx: UiContext, player: PlayerState, view: MapParts): void {
    const target = canvas2d;
    if (!target) return;

    const scale = zoom();
    const viewTilesX = Math.ceil(MAP_CSS_WIDTH / scale);
    const viewTilesY = Math.ceil(MAP_CSS_HEIGHT / scale);
    if (offscreen.width !== viewTilesX || offscreen.height !== viewTilesY) {
      offscreen.width = viewTilesX;
      offscreen.height = viewTilesY;
    }
    if (!offscreen2d) offscreen2d = offscreen.getContext('2d');

    const originTileX = Math.floor(centerTileX - viewTilesX / 2);
    const originTileY = Math.floor(centerTileY - viewTilesY / 2);
    const toCanvasX = (worldX: number): number => (worldX / TILE_SIZE - originTileX) * scale;
    const toCanvasY = (worldY: number): number => (worldY / TILE_SIZE - originTileY) * scale;

    const store = ctx.session.store;
    const chunks: ChunkPayload[] = [];
    for (const key of store.chunkKeys()) {
      const chunk = store.chunk(key);
      if (chunk) chunks.push(chunk);
    }

    target.setTransform(1, 0, 0, 1, 0, 0);
    target.imageSmoothingEnabled = false;
    target.fillStyle = cssColor(UNEXPLORED_COLOR);
    target.fillRect(0, 0, target.canvas.width, target.canvas.height);
    // Everything below is authored in CSS pixels; the device-pixel ratio is a transform.
    const ratio = target.canvas.width / MAP_CSS_WIDTH;
    target.setTransform(ratio, 0, 0, ratio, 0, 0);

    const pass = drawTerrain(chunks, originTileX, originTileY, viewTilesX, viewTilesY);
    if (offscreen2d && pass.drawn > 0) {
      target.drawImage(
        offscreen,
        0,
        0,
        viewTilesX,
        viewTilesY,
        0,
        0,
        viewTilesX * scale,
        viewTilesY * scale,
      );
    }
    if (scale >= 2) drawChunkGrid(target, originTileX, originTileY, scale);

    // --- structures -------------------------------------------------------
    // Only structures with an `ownerId` are drawn: those are the player-built ones. A
    // generated town has hundreds of walls and doors, and showing them would bury the
    // one thing a base map is for. Somebody else's base is drawn dimmer than your own,
    // which is the difference between "my stash" and "the neighbours" on a shared map.
    for (const entity of store.entitiesOfKind('structure')) {
      if (entity.k !== 'structure') continue;
      if (entity.ownerId === undefined) continue;
      const def = ctx.data.structures.get(entity.defId);
      const swapped = entity.rotation % 2 === 1;
      const tilesWide = swapped ? (def?.height ?? 1) : (def?.width ?? 1);
      const tilesHigh = swapped ? (def?.width ?? 1) : (def?.height ?? 1);
      const x = (entity.tileX - originTileX) * scale;
      const y = (entity.tileY - originTileY) * scale;
      const w = Math.max(2, tilesWide * scale);
      const h = Math.max(2, tilesHigh * scale);
      if (x + w < -4 || y + h < -4 || x > MAP_CSS_WIDTH + 4 || y > MAP_CSS_HEIGHT + 4) continue;

      const palette = STRUCTURE_COLOR[def?.category ?? 'misc'] ?? DEFAULT_STRUCTURE_COLOR;
      const mine = entity.ownerId === player.id;
      const fill = mine ? palette.fill : shade(palette.fill, -0.45);
      if (entity.progress < 1) {
        // A blueprint is an outline: it is not there yet, and the map should say so.
        target.strokeStyle = cssColor(fill, 0.9);
        target.lineWidth = 1;
        target.strokeRect(
          Math.round(x) + 0.5,
          Math.round(y) + 0.5,
          Math.max(1, w - 1),
          Math.max(1, h - 1),
        );
      } else {
        target.fillStyle = cssColor(fill);
        target.fillRect(Math.round(x), Math.round(y), w, h);
        target.strokeStyle = cssColor(palette.edge, mine ? 0.9 : 0.5);
        target.lineWidth = 1;
        target.strokeRect(
          Math.round(x) + 0.5,
          Math.round(y) + 0.5,
          Math.max(1, w - 1),
          Math.max(1, h - 1),
        );
      }
    }

    // --- other players ----------------------------------------------------
    target.font = '9px monospace';
    target.textBaseline = 'middle';
    for (const entity of store.entitiesOfKind('player')) {
      if (entity.k !== 'player') continue;
      if (entity.id === player.id) continue;
      const x = toCanvasX(entity.x);
      const y = toCanvasY(entity.y);
      if (x < -20 || y < -20 || x > MAP_CSS_WIDTH + 20 || y > MAP_CSS_HEIGHT + 20) continue;
      const radius = Math.max(2.5, scale * 0.55);
      target.beginPath();
      target.arc(x, y, radius, 0, Math.PI * 2);
      target.fillStyle = cssColor(entity.alive ? UI.stamina : UI.danger);
      target.fill();
      target.strokeStyle = 'rgba(0,0,0,0.7)';
      target.lineWidth = 1;
      target.stroke();
      target.fillStyle = cssColor(UI.text, 0.85);
      target.fillText(entity.name.slice(0, 12), x + radius + 3, y);
    }

    // --- the player -------------------------------------------------------
    // Drawn from the *predicted* body and facing, because that is where the player sees
    // themselves standing; it tracks the authoritative position within a few pixels.
    const arrowX = toCanvasX(ctx.session.predicted.x);
    const arrowY = toCanvasY(ctx.session.predicted.y);
    const size = Math.max(5, scale * 1.6);
    target.save();
    target.translate(arrowX, arrowY);
    // Angles are radians, 0 = +X, growing clockwise with +Y down — which is exactly what
    // a positive canvas rotation does, so `facing` needs no conversion.
    target.rotate(ctx.session.facing);
    target.beginPath();
    target.moveTo(size, 0);
    target.lineTo(-size * 0.62, size * 0.66);
    target.lineTo(-size * 0.28, 0);
    target.lineTo(-size * 0.62, -size * 0.66);
    target.closePath();
    target.fillStyle = cssColor(UI.accent);
    target.fill();
    target.strokeStyle = 'rgba(0,0,0,0.8)';
    target.lineWidth = 1;
    target.stroke();
    target.restore();

    // --- readout that depends on the pass ---------------------------------
    const named = [...pass.biomes.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([id]) => biomeProps(id).name);
    view.biomesInView.textContent = named.length > 0 ? named.join(', ') : 'nothing explored';
    view.view.textContent = `${scale} px/tile · ${chunks.length} chunk${
      chunks.length === 1 ? '' : 's'
    } · ${follow ? 'following you' : 'free look'}`;
    view.zoomValue.textContent = `${scale} px/tile`;
  }

  return {
    id: 'map',
    title: 'Map',
    captures: true,

    mount(ctx: UiContext): HTMLElement {
      injectMapSkillsStyles();
      const view = ensureParts();

      // The backing store is sized in device pixels so the one-pixel-per-tile map stays
      // crisp on a HiDPI display; the ratio is clamped because beyond 2x it buys nothing
      // and quadruples the fill cost.
      const ratio = clamp(window.devicePixelRatio || 1, 1, 2);
      view.canvas.width = Math.round(MAP_CSS_WIDTH * ratio);
      view.canvas.height = Math.round(MAP_CSS_HEIGHT * ratio);
      canvas2d = view.canvas.getContext('2d');

      // Every open starts centred on the player and forgets the cached signatures, so
      // the first update draws from scratch.
      follow = true;
      drawSignature = '';
      readoutSignature = '';
      lastDrawMs = 0;

      const root = panelFrame('Map', () => ctx.close('map'), view.body, 'panel--map');
      root.setAttribute('data-testid', 'map-panel');
      return root;
    },

    update(ctx: UiContext): void {
      const view = ensureParts();
      const player = ctx.session.self;
      if (!player) {
        if (readoutSignature !== 'none') {
          readoutSignature = 'none';
          view.coords.textContent = '—';
          view.chunkLabel.textContent = '—';
          view.biome.textContent = 'waiting for the world…';
        }
        return;
      }

      const playerTileX = Math.floor(ctx.session.predicted.x / TILE_SIZE);
      const playerTileY = Math.floor(ctx.session.predicted.y / TILE_SIZE);
      if (follow) {
        centerTileX = ctx.session.predicted.x / TILE_SIZE;
        centerTileY = ctx.session.predicted.y / TILE_SIZE;
      }

      // The text readout is three string writes, so it is diffed on its own and updated
      // as soon as the player crosses a tile — coordinates that lag the canvas by a
      // fifth of a second are the one thing on this panel worth keeping live.
      const chunkCx = Math.floor(playerTileX / CHUNK_TILES);
      const chunkCy = Math.floor(playerTileY / CHUNK_TILES);
      const biomeId = ctx.session.store.biomeAt(playerTileX, playerTileY);
      const nextReadout = `${playerTileX},${playerTileY}|${biomeId ?? '-'}`;
      if (nextReadout !== readoutSignature) {
        readoutSignature = nextReadout;
        view.coords.textContent = `${playerTileX}, ${playerTileY}`;
        view.chunkLabel.textContent = chunkKey(chunkCx, chunkCy);
        view.biome.textContent = biomeId === undefined ? 'unknown' : biomeProps(biomeId).name;
      }

      const now = performance.now();
      if (now - lastDrawMs < REDRAW_INTERVAL_MS) return;

      // Cheap signature of everything the canvas draws. Chunk membership is folded into
      // a rolling hash rather than a joined string: it is checked five times a second
      // and there is no reason to allocate for it.
      const store = ctx.session.store;
      let chunkHash = store.chunkCount * 31;
      for (const key of store.chunkKeys()) {
        for (let i = 0; i < key.length; i++) chunkHash = (chunkHash * 33 + key.charCodeAt(i)) | 0;
      }
      let markerHash = 0;
      const fold = (text: string): void => {
        for (let i = 0; i < text.length; i++)
          markerHash = (markerHash * 33 + text.charCodeAt(i)) | 0;
      };
      for (const entity of store.entitiesOfKind('structure')) {
        if (entity.k !== 'structure' || entity.ownerId === undefined) continue;
        fold(`${entity.id}:${entity.tileX}:${entity.tileY}:${Math.round(entity.progress * 4)}`);
      }
      for (const entity of store.entitiesOfKind('player')) {
        if (entity.k !== 'player') continue;
        fold(
          `${entity.id}:${Math.round(entity.x / TILE_SIZE)}:${Math.round(entity.y / TILE_SIZE)}:${
            entity.alive ? 1 : 0
          }`,
        );
      }
      const nextDraw = [
        zoomIndex,
        follow ? 1 : 0,
        Math.round(centerTileX * 2),
        Math.round(centerTileY * 2),
        Math.round(ctx.session.facing * 8),
        chunkHash,
        markerHash,
      ].join('|');
      if (nextDraw === drawSignature) return;
      drawSignature = nextDraw;
      lastDrawMs = now;
      redraw(ctx, player, view);
    },

    unmount(): void {
      drawSignature = '';
      readoutSignature = '';
      dragPointerId = null;
    },
  };
}

// ===========================================================================
// Skills
// ===========================================================================

/**
 * What a level in each skill actually buys.
 *
 * Every line is read off the system that consumes the level, not invented for the UI:
 * combat's `weaponSkillMultiplier` / `spreadRadians`, gathering's node damage,
 * `harvestYieldMultiplier`, `craftTicksPerUnit` / `craftQuality`, the building system's
 * progress rate, the treatment fumble roll, `grantXp`'s stamina bump, and
 * `playerVisibility`. If the simulation retunes a number, this table is wrong and should
 * be corrected here rather than softened into vagueness.
 */
const SKILL_EFFECTS: Readonly<Record<SkillId, string>> = {
  melee:
    '+6% melee damage and +1% crit chance per level. Swings cost less stamina, land slightly faster, and blocking absorbs a little more.',
  ranged:
    '+6% weapon damage per level and a much tighter aim cone — level 10 shoots a quarter of a novice’s spread. Reloads are faster too.',
  woodcutting: '+6% chopping force per level, so a tree comes down in fewer swings.',
  mining: '+6% mining force per level against rock, ore and scrap.',
  foraging: '+6% harvesting force per level on bushes, plants and water sources.',
  farming:
    '+5% harvest yield per level, multiplied with plant health and soil fertility rather than replacing them.',
  crafting:
    'Craft time −5% per level, halved at level 10, and better quality on items that carry it. Some recipes need a level to unlock.',
  building:
    '+4% build progress and +5% repair per level. The sturdier structures require a level before they can be placed.',
  cooking:
    'Cooked recipes finish faster and come out better made; the more involved dishes need a level before you can attempt them.',
  medicine:
    'Using a treatment that asks for more skill than you have risks fumbling it. Each level closes that gap, and treating harder wounds pays more XP.',
  athletics: '+8 maximum stamina per level, on top of the base 100.',
  stealth:
    '−4.5% detection range per level, floored at half: zombies and animals notice you later, never not at all.',
};

/** Lifetime counters, in the order the sheet lists them. */
const STAT_ROWS: readonly { key: keyof PlayerStats; label: string; kind: 'count' | 'tiles' }[] = [
  { key: 'daysSurvived', label: 'Days survived', kind: 'count' },
  { key: 'deaths', label: 'Deaths', kind: 'count' },
  { key: 'zombieKills', label: 'Zombies killed', kind: 'count' },
  { key: 'animalKills', label: 'Animals killed', kind: 'count' },
  { key: 'playerKills', label: 'Players killed', kind: 'count' },
  { key: 'distanceTravelled', label: 'Tiles travelled', kind: 'tiles' },
  { key: 'resourcesGathered', label: 'Resources gathered', kind: 'count' },
  { key: 'itemsCrafted', label: 'Items crafted', kind: 'count' },
  { key: 'structuresBuilt', label: 'Structures built', kind: 'count' },
  { key: 'cropsHarvested', label: 'Crops harvested', kind: 'count' },
];

/**
 * The XP bar for one skill.
 *
 * Composed from the shared `.bar` classes rather than by calling `statBar`, for one
 * reason: `statBar`'s trailing figure is the raw value, and what a skill row needs there
 * is the *remaining* requirement (and the word MAX at the ceiling). Same markup, same
 * stylesheet, different number.
 */
function xpBar(xp: number, needed: number, maxed: boolean): HTMLDivElement {
  const fraction = maxed ? 1 : needed > 0 ? clamp(xp / needed, 0, 1) : 0;
  const track = el('div', { className: 'bar-track' });
  const fill = el('div', { className: 'bar-fill' });
  fill.style.width = `${fraction * 100}%`;
  fill.style.background = cssColor(maxed ? UI.accent : UI.stamina);
  track.append(fill);
  return el('div', {
    className: 'bar bar--compact',
    children: [
      el('span', { className: 'bar-label', text: 'XP' }),
      track,
      el('span', {
        className: 'bar-value',
        text: maxed ? 'MAX' : `${Math.round(fraction * 100)}%`,
      }),
    ],
  });
}

/** One skill row: name, level, progress, what the level does, and the XP figures. */
function skillRow(skill: SkillId, level: number, xp: number): HTMLLIElement {
  const maxed = level >= MAX_SKILL_LEVEL;
  const needed = maxed ? 0 : xpForLevel(level);
  // Lifetime XP is the curve's cumulative total plus what is banked towards the next
  // level, so the figure survives a level-up instead of resetting with the bar.
  const lifetime = cumulativeXp(level) + xp;

  const row = el('li', {
    className: `skill-row${maxed ? ' skill-row--max' : ''}`,
    attrs: { 'data-testid': `skill-row-${skill}` },
    children: [
      el('div', {
        className: 'skill-head',
        children: [
          el('span', { className: 'skill-name', text: humanize(skill) }),
          el('span', {
            className: 'skill-level',
            attrs: { 'data-testid': `skill-level-${skill}` },
            text: `Level ${level} / ${MAX_SKILL_LEVEL}`,
          }),
        ],
      }),
      xpBar(xp, needed, maxed),
      el('span', {
        className: 'skill-xp muted',
        attrs: { 'data-testid': `skill-xp-${skill}` },
        text: maxed
          ? `Mastered · ${formatInt(lifetime)} XP earned`
          : `${formatInt(xp)} / ${formatInt(needed)} XP to level ${level + 1} · ${formatInt(
              lifetime,
            )} lifetime`,
      }),
      el('p', { className: 'skill-effect muted', text: SKILL_EFFECTS[skill] }),
    ],
  });
  return row;
}

/**
 * The skills sheet.
 *
 * Read-only: there is nothing to spend and no button to press, because progression in
 * this game is driven by doing the thing, not by allocating points. So the panel's whole
 * job is to answer two questions honestly — how far off is the next level, and what will
 * it change — and to keep the lifetime counters somewhere a player can find them without
 * dying first.
 *
 * `xpForLevel` and `cumulativeXp` are imported from `@survive/simulation/core/skills`
 * rather than restated here. Duplicating a progression curve in the UI is how a bar ends
 * up at 99% when the server has already levelled you.
 */
export function createSkillsPanel(): Panel {
  let list: HTMLUListElement | null = null;
  let stats: HTMLElement | null = null;
  let body: HTMLDivElement | null = null;
  let signature = '';

  function ensureBody(): HTMLDivElement {
    if (body) return body;
    list = el('ul', {
      className: 'skills-list',
      attrs: { 'data-testid': 'skills-list', 'aria-label': 'Skills' },
    });
    stats = el('dl', {
      className: 'skills-stats',
      attrs: { 'data-testid': 'skills-stats' },
    });
    body = el('div', {
      className: 'panel-body skills-body',
      children: [list, el('div', { className: 'section-title', text: 'Lifetime' }), stats],
    });
    return body;
  }

  function renderStats(target: HTMLElement, values: PlayerStats): void {
    target.replaceChildren(
      ...STAT_ROWS.map((row) => {
        const raw = values[row.key];
        // `distanceTravelled` is stored in world pixels (TILE_SIZE px to a tile). Tiles
        // are the unit players actually talk in, so convert and keep the raw figure in
        // the tooltip rather than inventing a metric distance the world never defined.
        const text = row.kind === 'tiles' ? formatInt(raw / TILE_SIZE) : formatInt(raw);
        const dd = el('dd', { attrs: { 'data-testid': `skills-stat-${row.key}` }, text });
        if (row.kind === 'tiles') dd.title = `${formatInt(raw)} px`;
        return el('div', { children: [el('dt', { text: row.label }), dd] });
      }),
    );
  }

  return {
    id: 'skills',
    title: 'Skills',
    captures: true,

    mount(ctx: UiContext): HTMLElement {
      injectMapSkillsStyles();
      const view = ensureBody();
      signature = '';
      const root = panelFrame('Skills', () => ctx.close('skills'), view, 'panel--skills');
      root.setAttribute('data-testid', 'skills-panel');
      return root;
    },

    update(ctx: UiContext): void {
      ensureBody();
      if (!list || !stats) return;
      const player = ctx.session.self;
      if (!player) {
        if (signature !== 'none') {
          signature = 'none';
          list.replaceChildren(el('li', { className: 'muted', text: 'Waiting for the world…' }));
          stats.replaceChildren();
        }
        return;
      }

      // Twelve rows of text and a bar each. XP only moves when the server grants it, so
      // rounding it into the signature costs nothing and the rebuild happens on the
      // handful of frames where something actually changed.
      const skillPart = SKILL_IDS.map((id) => {
        const state = player.skills[id];
        return `${state.level}:${Math.round(state.xp)}`;
      }).join(',');
      const statPart = STAT_ROWS.map((row) => Math.round(player.stats[row.key])).join(',');
      const next = `${player.id}|${skillPart}|${statPart}`;
      if (next === signature) return;
      signature = next;

      list.replaceChildren(
        ...SKILL_IDS.map((id) => {
          const state = player.skills[id];
          return skillRow(id, state.level, state.xp);
        }),
      );
      renderStats(stats, player.stats);
    },

    unmount(): void {
      signature = '';
    },
  };
}
