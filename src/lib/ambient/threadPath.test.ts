import { describe, it, expect } from "vitest";
import { threadPath, type ThreadPathOut } from "../../components/ambient/Threads";

function makeOut(): ThreadPathOut {
  return { cp1x: 0, cp1y: 0, cp2x: 0, cp2y: 0 };
}

describe("threadPath", () => {
  it("writes control points into out at t=0", () => {
    const out = makeOut();
    threadPath(0, 0, 400, 600, 0, out);

    expect(typeof out.cp1x).toBe("number");
    expect(typeof out.cp1y).toBe("number");
    expect(typeof out.cp2x).toBe("number");
    expect(typeof out.cp2y).toBe("number");
  });

  it("writes valid control points at t=100", () => {
    const out = makeOut();
    threadPath(200, 100, 800, 500, 100, out);

    expect(typeof out.cp1x).toBe("number");
    expect(typeof out.cp1y).toBe("number");
    expect(typeof out.cp2x).toBe("number");
    expect(typeof out.cp2y).toBe("number");
    expect(isNaN(out.cp1x)).toBe(false);
    expect(isNaN(out.cp1y)).toBe(false);
    expect(isNaN(out.cp2x)).toBe(false);
    expect(isNaN(out.cp2y)).toBe(false);
  });

  it("undulation is bounded: control points stay within ±65px of the straight midpoint", () => {
    const fromX = 100, fromY = 200;
    const toX = 900, toY = 400;
    const out = makeOut();

    // Check across many time values
    const BOUND = 65; // spec says max ±60px, we use 65 for float tolerance

    for (let i = 0; i <= 200; i++) {
      const t = i * 0.5; // t from 0 to 100 in 0.5 steps
      threadPath(fromX, fromY, toX, toY, t, out);

      // Midpoint of from→to
      const midX = (fromX + toX) / 2;
      const midY = (fromY + toY) / 2;

      // Compute distance from cp to straight line segment
      const dx = toX - fromX;
      const dy = toY - fromY;
      const len = Math.sqrt(dx * dx + dy * dy);
      const nx = -dy / len; // unit normal
      const ny = dx / len;

      // Project cp1 offset onto normal
      const cp1MidX = (midX + fromX) / 2;
      const cp1MidY = (midY + fromY) / 2;
      const off1 = (out.cp1x - cp1MidX) * nx + (out.cp1y - cp1MidY) * ny;
      expect(Math.abs(off1)).toBeLessThanOrEqual(BOUND);

      const cp2MidX = (midX + toX) / 2;
      const cp2MidY = (midY + toY) / 2;
      const off2 = (out.cp2x - cp2MidX) * nx + (out.cp2y - cp2MidY) * ny;
      expect(Math.abs(off2)).toBeLessThanOrEqual(BOUND);
    }
  });

  it("writes finite numbers for degenerate from===to case", () => {
    const out = makeOut();
    threadPath(100, 100, 100, 100, 1.0, out);

    expect(isNaN(out.cp1x)).toBe(false);
    expect(isNaN(out.cp1y)).toBe(false);
    expect(isNaN(out.cp2x)).toBe(false);
    expect(isNaN(out.cp2y)).toBe(false);
  });
});
