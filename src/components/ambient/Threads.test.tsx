import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom";

// Use vi.hoisted so variables are available when vi.mock factory runs (hoisted to top of file)
const { mockSubscribe } = vi.hoisted(() => ({
  mockSubscribe: vi.fn(() => () => {}),
}));

// Mock the ambient loop
vi.mock("../../lib/ambient/ambientLoop", () => ({
  subscribe: mockSubscribe,
}));

// Mock windowRegistry
vi.mock("../../lib/ambient/windowRegistry", () => ({
  windowRegistry: {
    set: vi.fn(),
    delete: vi.fn(),
    getAll: vi.fn(() => new Map()),
  },
}));

function mockMatchMedia(prefersReducedMotion: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: prefersReducedMotion && query.includes("reduced-motion"),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}

// Mock ResizeObserver (jsdom doesn't have it)
class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

beforeEach(() => {
  mockMatchMedia(false);
  mockSubscribe.mockClear();
  // Restore implementation in case previous test cleared it
  mockSubscribe.mockImplementation(() => () => {});
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

import Threads, { threadPath, type ThreadPathOut } from "./Threads";

describe("Threads", () => {
  it("renders the canvas element", () => {
    render(<Threads />);
    const canvas = screen.getByTestId("ambient-threads");
    expect(canvas).toBeInTheDocument();
    expect(canvas.tagName).toBe("CANVAS");
  });

  it("canvas has pointer-events:none", () => {
    render(<Threads />);
    const canvas = screen.getByTestId("ambient-threads");
    expect(canvas.style.pointerEvents).toBe("none");
  });

  it("container has position:fixed (shell-level overlay) and pointer-events:none", () => {
    render(<Threads />);
    const canvas = screen.getByTestId("ambient-threads");
    const container = canvas.parentElement;
    expect(container).not.toBeNull();
    // Threads now lives at the shell root level as a fixed overlay so its
    // coordinate space matches the full-viewport desktop plane.
    expect(container!.style.position).toBe("fixed");
    expect(container!.style.pointerEvents).toBe("none");
  });

  it("under reduced motion: static lines (subscribe not called)", () => {
    mockMatchMedia(true);
    mockSubscribe.mockClear();
    render(<Threads />);
    // Under reduced motion, we draw static lines via setInterval, not the loop
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it("without reduced motion: subscribe is called for animation", () => {
    mockMatchMedia(false);
    mockSubscribe.mockClear();
    render(<Threads />);
    expect(mockSubscribe).toHaveBeenCalledTimes(1);
  });

  it("threadPath undulation is bounded to <=60px from midpoint", () => {
    // For a horizontal thread from (0,0) to (200,0):
    //   midpoint = (100, 0)
    //   perpendicular unit vector = (0, 1) (nx=-dy/len=0, ny=dx/len=1)
    //   cp1 sits at (midX*0.5 + fromX*0.5 + nx*amp1, midY*0.5 + fromY*0.5 + ny*amp1)
    //            = (50 + 0, 0 + amp1) => cp1y = amp1
    //   cp2 sits at (midX*0.5 + toX*0.5 + nx*amp2, midY*0.5 + toY*0.5 + ny*amp2)
    //            = (150 + 0, 0 + amp2) => cp2y = amp2
    // Since amp1 = sin(...) * 60 and amp2 = sin(...) * 60, |cp1y| <= 60 and |cp2y| <= 60.
    const out: ThreadPathOut = { cp1x: 0, cp1y: 0, cp2x: 0, cp2y: 0 };
    const fromX = 0, fromY = 0, toX = 200, toY = 0;
    let maxDeviation = 0;

    // Sample 501 time values (t = 0, 0.1, 0.2, ..., 50.0)
    for (let i = 0; i <= 500; i++) {
      const t = i * 0.1;
      threadPath(fromX, fromY, toX, toY, t, out);
      // For horizontal thread, perpendicular deviation is the y component of cp offsets
      maxDeviation = Math.max(maxDeviation, Math.abs(out.cp1y), Math.abs(out.cp2y));
    }

    expect(maxDeviation).toBeLessThanOrEqual(60);
  });
});
