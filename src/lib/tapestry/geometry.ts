/**
 * geometry.ts — the Tapestry's cloth geometry, pure.
 *
 * weave.ts decides WHAT threads exist (data model, labels, actions). This
 * module decides how those threads DRAPE: bowed warps, undulating wefts that
 * dip under and lift over every warp they cross, and the over-crossing
 * checkerboard that makes the band read as woven cloth instead of graph paper.
 * The technique is the glyph's (public/brand/loom-glyph.svg): the weft rises
 * and falls through the warp, and at every "over" crossing a short warp
 * segment is overdrawn so the threads visibly interlace.
 *
 * PURE + DETERMINISTIC: no Math.random, no Date.now, no DOM. All jitter is
 * fnv-1a-seeded from thread ids (weave.hash01). All coordinates are band-local
 * pixels — the renderer owns where the band sits on screen.
 */

import { hash01 } from "./weave";

export interface Point {
  x: number;
  y: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Band height in px — the renderer's <svg> matches this. */
export const BAND_H = 180;

/** Wefts run past the visible band so the mask can fade them into darkness. */
export const WEFT_OVERHANG = 40;

/** Crossings tighter than this read as a grid, not cloth — thin the warp. */
export const MIN_CROSSING_SPACING = 28;

/** Vertical half-length of the over-crossing warp overdraw (M x,y−6 L x,y+6). */
export const CROSSING_OVERDRAW = 6;

/** Radius of a knot — the tight loop marking a repaired/failed build. */
export const KNOT_R = 2.5;

/** Top/bottom breathing room before the first weft row / after the last. */
const ROW_PAD = 12;

const fmt = (v: number) => Number(v.toFixed(2));

// ── Catmull-Rom → cubic Bézier ────────────────────────────────────────────────

/**
 * Convert a point list to a smooth SVG path via uniform Catmull-Rom splines
 * (endpoint-clamped). The path passes through every sample point and emits
 * exactly points.length − 1 cubic segments.
 */
export function catmullRomToBezier(points: Point[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${fmt(points[0].x)} ${fmt(points[0].y)}`;
  let d = `M ${fmt(points[0].x)} ${fmt(points[0].y)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? points[i + 1];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${fmt(c1x)} ${fmt(c1y)} ${fmt(c2x)} ${fmt(c2y)} ${fmt(p2.x)} ${fmt(p2.y)}`;
  }
  return d;
}

// ── Warp — bowed verticals, never rulered lines ───────────────────────────────

export interface WarpGeomInput {
  /** Seed for this thread's jitter — the thread id (fnv-1a hashed). */
  seed: string;
  /** x in band-local px. */
  x: number;
}

export interface WarpGeom {
  seed: string;
  x: number;
  /** 8..20px seeded — the warp emerges below the band's top edge. */
  topInset: number;
  /** 8..20px seeded. */
  bottomInset: number;
  /** −3..+3px seeded — the gentle bow that keeps the thread hand-strung. */
  bow: number;
  /** `M x,topInset Q x+bow,midY x,height−bottomInset` */
  d: string;
}

export function warpGeometry(threads: WarpGeomInput[], height: number = BAND_H): WarpGeom[] {
  return threads.map((t) => {
    const topInset = 8 + hash01(`${t.seed}#top`) * 12;
    const bottomInset = 8 + hash01(`${t.seed}#bot`) * 12;
    const bow = (hash01(`${t.seed}#bow`) - 0.5) * 6;
    const midY = height / 2;
    const d =
      `M ${fmt(t.x)} ${fmt(topInset)}` +
      ` Q ${fmt(t.x + bow)} ${fmt(midY)} ${fmt(t.x)} ${fmt(height - bottomInset)}`;
    return { seed: t.seed, x: t.x, topInset, bottomInset, bow, d };
  });
}

/**
 * Density sanity: if warps sit tighter than minSpacing px, thin the RENDERED
 * set (stride over the list, always keeping the first = newest commit). The
 * data model's WARP_CAP is untouched — this only decides how many threads the
 * cloth can honestly hold at this width; the rest exist unrendered.
 */
export function thinWarpForDensity<T extends { x: number }>(
  threads: T[],
  minSpacing: number = MIN_CROSSING_SPACING
): T[] {
  if (threads.length < 2) return threads;
  const xs = threads.map((t) => t.x);
  const span = Math.max(...xs) - Math.min(...xs);
  const avgGap = span / (threads.length - 1);
  if (avgGap >= minSpacing) return threads;
  if (avgGap <= 0) return [threads[0]];
  const stride = Math.ceil(minSpacing / avgGap);
  return threads.filter((_, i) => i % stride === 0);
}

// ── Weft — rows that dip under and lift over every warp ───────────────────────

export interface WeftRowInput {
  /** Seed for spacing + amplitude jitter — the thread id. */
  seed: string;
}

export interface WeftRow {
  seed: string;
  /** Parity row index j — over when (i + j) % 2 === 0. */
  rowIndex: number;
  /** Baseline y of the row in band-local px. */
  rowY: number;
  /** 3..7px seeded — how far the thread lifts/dips at each crossing. */
  amplitude: number;
  points: Point[];
  d: string;
}

/**
 * When there is no warp to cross (browser mode, empty history), the weft still
 * needs to drape — sample a phantom warp grid so the cloth undulates. No
 * interlacing is drawn for phantom xs (there is nothing to cross).
 */
export function sampleXs(warpXs: number[], width: number): number[] {
  if (warpXs.length > 0) return warpXs;
  const xs: number[] = [];
  for (let x = 24; x <= width - 24; x += 48) xs.push(x);
  return xs;
}

/**
 * Lay weft rows top-down with seeded 14–22px spacing. Rows that would fall off
 * the band's bottom edge are NOT laid — the band renders as many threads as
 * the cloth can hold; the data model (WEFT_CAP) is unchanged and the dropped
 * tail is the lowest-priority candidates (oldest builds), same philosophy as
 * the weave's own cap. Callers zip rows against weft.slice(0, rows.length).
 */
export function weftRows(
  threads: WeftRowInput[],
  warpXs: number[],
  width: number,
  height: number = BAND_H
): WeftRow[] {
  const xs = sampleXs(warpXs, width);
  const rows: WeftRow[] = [];
  let y = ROW_PAD;
  for (const t of threads) {
    const gap = 14 + hash01(`${t.seed}#gap`) * 8;
    y += gap;
    if (y > height - ROW_PAD) break;
    const j = rows.length;
    const amplitude = 3 + hash01(`${t.seed}#amp`) * 4;
    const points: Point[] = [{ x: -WEFT_OVERHANG, y }];
    for (let i = 0; i < xs.length; i++) {
      points.push({ x: xs[i], y: y + ((i + j) % 2 === 0 ? -amplitude : +amplitude) });
    }
    points.push({ x: width + WEFT_OVERHANG, y });
    rows.push({ seed: t.seed, rowIndex: j, rowY: y, amplitude, points, d: catmullRomToBezier(points) });
  }
  return rows;
}

// ── Interlacing — the checkerboard of over-crossings ──────────────────────────

export interface Crossing {
  x: number;
  y: number;
  warpIndex: number;
  rowIndex: number;
}

/**
 * Every crossing where the WARP is over — `(i + j) % 2 === 1` — so the
 * renderer can overdraw a short warp segment on top of the weft there. The
 * complement of the weft's own "over" parity: real cloth, checkerboarded.
 */
export function overCrossings(warpXs: number[], rows: WeftRow[]): Crossing[] {
  const crossings: Crossing[] = [];
  for (const row of rows) {
    for (let i = 0; i < warpXs.length; i++) {
      if ((i + row.rowIndex) % 2 === 1) {
        // Warp over ⇒ weft dips: +amplitude side of the row baseline.
        crossings.push({
          x: warpXs[i],
          y: row.rowY + row.amplitude,
          warpIndex: i,
          rowIndex: row.rowIndex,
        });
      }
    }
  }
  return crossings;
}

// ── Knots — repaired/failed builds tied at a real crossing ────────────────────

/**
 * Map a knot's seeded 0..1 position onto the nearest actual crossing of its
 * row, returning the point ON the weft curve there (the knot is tied where
 * the threads meet). With no warp, the knot sits on the row baseline.
 */
export function knotPoint(
  knot01: number,
  row: WeftRow,
  warpXs: number[],
  width: number
): Point {
  const targetX = knot01 * width;
  if (warpXs.length === 0) return { x: targetX, y: row.rowY };
  let best = 0;
  for (let i = 1; i < warpXs.length; i++) {
    if (Math.abs(warpXs[i] - targetX) < Math.abs(warpXs[best] - targetX)) best = i;
  }
  const over = (best + row.rowIndex) % 2 === 0;
  return { x: warpXs[best], y: row.rowY + (over ? -row.amplitude : +row.amplitude) };
}
