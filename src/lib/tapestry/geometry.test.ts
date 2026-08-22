/**
 * geometry.test.ts — the cloth geometry, proven pure.
 *
 * Everything here is deterministic: same threads → same drape. The tests pin
 * the properties that make the band read as cloth — bowed warps, seeded row
 * spacing, per-crossing parity that alternates per warp AND per row, and the
 * over-crossing checkerboard the renderer overdraws.
 */

import { describe, it, expect } from "vitest";
import {
  BAND_H,
  WEFT_OVERHANG,
  catmullRomToBezier,
  warpGeometry,
  thinWarpForDensity,
  sampleXs,
  weftRows,
  overCrossings,
  knotPoint,
  type Point,
} from "./geometry";

// Parse "M x y C c1x c1y c2x c2y x y ..." into segment-end points.
function segmentEnds(d: string): Point[] {
  const nums = d
    .replace(/[MC]/g, " ")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const ends: Point[] = [{ x: nums[0], y: nums[1] }];
  for (let i = 2; i + 5 < nums.length; i += 6) {
    ends.push({ x: nums[i + 4], y: nums[i + 5] });
  }
  return ends;
}

describe("catmullRomToBezier", () => {
  const points: Point[] = [
    { x: -40, y: 50 },
    { x: 100, y: 45 },
    { x: 200, y: 55 },
    { x: 300, y: 45 },
    { x: 440, y: 50 },
  ];

  it("emits exactly points.length − 1 cubic segments", () => {
    const d = catmullRomToBezier(points);
    expect(d.startsWith("M ")).toBe(true);
    expect((d.match(/C/g) ?? []).length).toBe(points.length - 1);
  });

  it("passes through every sample point", () => {
    const d = catmullRomToBezier(points);
    const ends = segmentEnds(d);
    expect(ends).toHaveLength(points.length);
    for (let i = 0; i < points.length; i++) {
      expect(ends[i].x).toBeCloseTo(points[i].x, 1);
      expect(ends[i].y).toBeCloseTo(points[i].y, 1);
    }
  });

  it("degenerate inputs: empty → empty, single point → bare move", () => {
    expect(catmullRomToBezier([])).toBe("");
    expect(catmullRomToBezier([{ x: 5, y: 7 }])).toBe("M 5 7");
    const two = catmullRomToBezier([{ x: 0, y: 0 }, { x: 10, y: 10 }]);
    expect((two.match(/C/g) ?? []).length).toBe(1);
  });

  it("is deterministic", () => {
    expect(catmullRomToBezier(points)).toBe(catmullRomToBezier(points));
  });
});

describe("warpGeometry — bowed verticals", () => {
  const threads = [
    { seed: "warp-a0cee82", x: 200 },
    { seed: "warp-b1def93", x: 400 },
  ];

  it("seeds insets in 8..20 and bow in −3..+3", () => {
    for (const g of warpGeometry(threads)) {
      expect(g.topInset).toBeGreaterThanOrEqual(8);
      expect(g.topInset).toBeLessThanOrEqual(20);
      expect(g.bottomInset).toBeGreaterThanOrEqual(8);
      expect(g.bottomInset).toBeLessThanOrEqual(20);
      expect(g.bow).toBeGreaterThanOrEqual(-3);
      expect(g.bow).toBeLessThanOrEqual(3);
    }
  });

  it("path is a quadratic bow, not a straight line: M x,top Q x+bow,mid x,bottom", () => {
    const [g] = warpGeometry(threads, BAND_H);
    expect(g.d).toMatch(/^M [\d.]+ [\d.]+ Q [\d.-]+ [\d.]+ [\d.]+ [\d.]+$/);
    const nums = g.d.replace(/[MQ]/g, " ").trim().split(/\s+/).map(Number);
    expect(nums[0]).toBeCloseTo(200, 1); // start x
    expect(nums[2]).toBeCloseTo(200 + g.bow, 1); // control x carries the bow
    expect(nums[3]).toBeCloseTo(BAND_H / 2, 1); // control at mid-height
    expect(nums[4]).toBeCloseTo(200, 1); // end x back on the thread
    expect(nums[5]).toBeCloseTo(BAND_H - g.bottomInset, 1);
  });

  it("different seeds drape differently; same seed always the same", () => {
    const [a, b] = warpGeometry(threads);
    expect(a.d).not.toBe(b.d.replace(/400/g, "200"));
    const again = warpGeometry(threads);
    expect(again[0].d).toBe(a.d);
  });
});

describe("thinWarpForDensity", () => {
  it("leaves comfortably spaced warps alone", () => {
    const threads = [{ x: 100 }, { x: 200 }, { x: 300 }];
    expect(thinWarpForDensity(threads)).toHaveLength(3);
  });

  it("thins warps tighter than the minimum crossing spacing, keeping the first", () => {
    // 24 warps over 240px → 10px gaps, far below 28px
    const threads = Array.from({ length: 24 }, (_, i) => ({ x: 100 + i * 10 }));
    const thinned = thinWarpForDensity(threads);
    expect(thinned.length).toBeLessThan(24);
    expect(thinned[0]).toBe(threads[0]); // newest survives
    for (let i = 1; i < thinned.length; i++) {
      expect(thinned[i].x - thinned[i - 1].x).toBeGreaterThanOrEqual(28);
    }
  });

  it("handles degenerate spans without dividing by zero", () => {
    expect(thinWarpForDensity([{ x: 5 }])).toHaveLength(1);
    expect(thinWarpForDensity([{ x: 5 }, { x: 5 }, { x: 5 }])).toHaveLength(1);
  });
});

describe("weftRows — rows that drape through the warp", () => {
  const warpXs = [100, 200, 300, 400];
  const threads = Array.from({ length: 5 }, (_, i) => ({ seed: `organ-${i}` }));

  it("spaces rows 14–22px apart with seeded jitter, inside the band", () => {
    const rows = weftRows(threads, warpXs, 500);
    expect(rows.length).toBeGreaterThan(1);
    let prev = 12; // ROW_PAD
    for (const row of rows) {
      const gap = row.rowY - prev;
      expect(gap).toBeGreaterThanOrEqual(14);
      expect(gap).toBeLessThanOrEqual(22);
      expect(row.rowY).toBeLessThanOrEqual(BAND_H - 12);
      prev = row.rowY;
    }
  });

  it("seeds amplitude in 3..7", () => {
    for (const row of weftRows(threads, warpXs, 500)) {
      expect(row.amplitude).toBeGreaterThanOrEqual(3);
      expect(row.amplitude).toBeLessThanOrEqual(7);
    }
  });

  it("samples a point at EVERY warp x plus run-in/run-out at ±overhang", () => {
    const [row] = weftRows(threads, warpXs, 500);
    expect(row.points).toHaveLength(warpXs.length + 2);
    expect(row.points[0]).toEqual({ x: -WEFT_OVERHANG, y: row.rowY });
    expect(row.points[row.points.length - 1]).toEqual({ x: 500 + WEFT_OVERHANG, y: row.rowY });
    for (let i = 0; i < warpXs.length; i++) {
      expect(row.points[i + 1].x).toBe(warpXs[i]);
    }
  });

  it("crossing parity alternates per warp AND per row: over when (i+j)%2===0", () => {
    const rows = weftRows(threads, warpXs, 500);
    for (const row of rows) {
      for (let i = 0; i < warpXs.length; i++) {
        const y = row.points[i + 1].y;
        if ((i + row.rowIndex) % 2 === 0) {
          expect(y).toBeCloseTo(row.rowY - row.amplitude, 5); // weft over — lifts
        } else {
          expect(y).toBeCloseTo(row.rowY + row.amplitude, 5); // weft under — dips
        }
      }
    }
  });

  it("path is Catmull-Rom smooth — passes through every sample", () => {
    const [row] = weftRows(threads, warpXs, 500);
    const ends = segmentEnds(row.d);
    expect(ends).toHaveLength(row.points.length);
    for (let i = 0; i < row.points.length; i++) {
      expect(ends[i].x).toBeCloseTo(row.points[i].x, 1);
      expect(ends[i].y).toBeCloseTo(row.points[i].y, 1);
    }
  });

  it("drops rows the band cannot hold — never overflows the bottom edge", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ seed: `t-${i}` }));
    const rows = weftRows(many, warpXs, 500);
    expect(rows.length).toBeLessThan(40);
    expect(rows[rows.length - 1].rowY).toBeLessThanOrEqual(BAND_H - 12);
  });

  it("with no warp, samples a phantom grid so the cloth still undulates", () => {
    const rows = weftRows(threads.slice(0, 1), [], 500);
    expect(rows[0].points.length).toBeGreaterThan(3);
    const ys = new Set(rows[0].points.map((p) => p.y));
    expect(ys.size).toBeGreaterThan(1); // not a straight line
  });
});

describe("sampleXs", () => {
  it("returns the warp xs verbatim when there is a warp", () => {
    expect(sampleXs([10, 20], 500)).toEqual([10, 20]);
  });

  it("synthesizes a phantom grid inside the width when there is none", () => {
    const xs = sampleXs([], 500);
    expect(xs.length).toBeGreaterThan(3);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThanOrEqual(500);
  });
});

describe("overCrossings — the checkerboard that makes it cloth", () => {
  const warpXs = [100, 200, 300, 400];
  const threads = Array.from({ length: 4 }, (_, i) => ({ seed: `organ-${i}` }));

  it("returns exactly the crossings where the warp is over: (i+j)%2===1", () => {
    const rows = weftRows(threads, warpXs, 500);
    const crossings = overCrossings(warpXs, rows);
    const expected = rows.length * Math.floor(warpXs.length / 2);
    expect(crossings).toHaveLength(expected);
    for (const c of crossings) {
      expect((c.warpIndex + c.rowIndex) % 2).toBe(1);
    }
  });

  it("checkerboard parity: adjacent warps on a row alternate, adjacent rows on a warp alternate", () => {
    const rows = weftRows(threads, warpXs, 500);
    const crossings = overCrossings(warpXs, rows);
    const has = (i: number, j: number) =>
      crossings.some((c) => c.warpIndex === i && c.rowIndex === j);
    for (let j = 0; j < rows.length; j++) {
      for (let i = 0; i < warpXs.length - 1; i++) {
        expect(has(i, j)).not.toBe(has(i + 1, j)); // per-warp alternation
      }
    }
    for (let i = 0; i < warpXs.length; i++) {
      for (let j = 0; j < rows.length - 1; j++) {
        expect(has(i, j)).not.toBe(has(i, j + 1)); // per-row alternation
      }
    }
  });

  it("crossing y sits on the weft's dipped side (+amplitude)", () => {
    const rows = weftRows(threads, warpXs, 500);
    for (const c of overCrossings(warpXs, rows)) {
      const row = rows[c.rowIndex];
      expect(c.y).toBeCloseTo(row.rowY + row.amplitude, 5);
    }
  });

  it("no warp → no crossings", () => {
    const rows = weftRows(threads, [], 500);
    expect(overCrossings([], rows)).toEqual([]);
  });
});

describe("knotPoint — knots tied at real crossings", () => {
  const warpXs = [100, 200, 300, 400];
  const threads = [{ seed: "build-runs-1000" }];

  it("snaps the seeded 0..1 position to the nearest warp crossing, on the curve", () => {
    const [row] = weftRows(threads, warpXs, 500);
    const p = knotPoint(0.45, row, warpXs, 500); // 225 → nearest warp 200 (i=1)
    expect(p.x).toBe(200);
    const over = (1 + row.rowIndex) % 2 === 0;
    expect(p.y).toBeCloseTo(row.rowY + (over ? -row.amplitude : +row.amplitude), 5);
  });

  it("with no warp, sits on the row baseline at its seeded x", () => {
    const [row] = weftRows(threads, [], 500);
    expect(knotPoint(0.5, row, [], 500)).toEqual({ x: 250, y: row.rowY });
  });
});
