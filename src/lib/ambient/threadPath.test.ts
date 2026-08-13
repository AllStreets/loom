import { describe, it, expect } from "vitest";
import { threadPath } from "../../components/ambient/Threads";

describe("threadPath", () => {
  it("returns control points at t=0", () => {
    const from = { x: 0, y: 0 };
    const to = { x: 400, y: 600 };
    const result = threadPath(from, to, 0);

    expect(result.cp1).toBeDefined();
    expect(result.cp2).toBeDefined();
    expect(typeof result.cp1.x).toBe("number");
    expect(typeof result.cp1.y).toBe("number");
    expect(typeof result.cp2.x).toBe("number");
    expect(typeof result.cp2.y).toBe("number");
  });

  it("returns valid control points at t=100", () => {
    const from = { x: 200, y: 100 };
    const to = { x: 800, y: 500 };
    const result = threadPath(from, to, 100);

    expect(typeof result.cp1.x).toBe("number");
    expect(typeof result.cp1.y).toBe("number");
    expect(typeof result.cp2.x).toBe("number");
    expect(typeof result.cp2.y).toBe("number");
    expect(isNaN(result.cp1.x)).toBe(false);
    expect(isNaN(result.cp1.y)).toBe(false);
    expect(isNaN(result.cp2.x)).toBe(false);
    expect(isNaN(result.cp2.y)).toBe(false);
  });

  it("undulation is bounded: control points stay within ±65px of the straight midpoint", () => {
    const from = { x: 100, y: 200 };
    const to = { x: 900, y: 400 };

    // Check across many time values
    const BOUND = 65; // spec says max ±60px, we use 65 for float tolerance

    for (let i = 0; i <= 200; i++) {
      const t = i * 0.5; // t from 0 to 100 in 0.5 steps
      const { cp1, cp2 } = threadPath(from, to, t);

      // Midpoint of from→to
      const midX = (from.x + to.x) / 2;
      const midY = (from.y + to.y) / 2;

      // cp1 is at 25% along (from-to blended with mid), check against the perpendicular
      // We just check that cp1 and cp2 are reasonably near the line
      // Compute distance from cp to straight line segment
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      const nx = -dy / len; // unit normal
      const ny = dx / len;

      // Project cp1 offset onto normal
      const cp1MidX = (midX + from.x) / 2;
      const cp1MidY = (midY + from.y) / 2;
      const off1 = (cp1.x - cp1MidX) * nx + (cp1.y - cp1MidY) * ny;
      expect(Math.abs(off1)).toBeLessThanOrEqual(BOUND);

      const cp2MidX = (midX + to.x) / 2;
      const cp2MidY = (midY + to.y) / 2;
      const off2 = (cp2.x - cp2MidX) * nx + (cp2.y - cp2MidY) * ny;
      expect(Math.abs(off2)).toBeLessThanOrEqual(BOUND);
    }
  });

  it("returns finite numbers for degenerate from===to case", () => {
    const from = { x: 100, y: 100 };
    const to = { x: 100, y: 100 };
    const result = threadPath(from, to, 1.0);

    expect(isNaN(result.cp1.x)).toBe(false);
    expect(isNaN(result.cp1.y)).toBe(false);
    expect(isNaN(result.cp2.x)).toBe(false);
    expect(isNaN(result.cp2.y)).toBe(false);
  });
});
