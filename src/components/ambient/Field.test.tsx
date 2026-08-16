import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom";

// Use vi.hoisted so the variable is available when vi.mock factory runs
const { mockSubscribe } = vi.hoisted(() => {
  return { mockSubscribe: vi.fn(() => () => {}) };
});

// Mock the ambient loop so no rAF is needed
vi.mock("../../lib/ambient/ambientLoop", () => ({
  subscribe: mockSubscribe,
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

beforeEach(() => {
  mockMatchMedia(false);
  mockSubscribe.mockClear();
  // Restore implementation in case a previous test's afterEach wiped it
  mockSubscribe.mockImplementation(() => () => {});
});

import Field from "./Field";

describe("Field", () => {
  it("renders the canvas element", () => {
    render(<Field />);
    const canvas = screen.getByTestId("ambient-field");
    expect(canvas).toBeInTheDocument();
    expect(canvas.tagName).toBe("CANVAS");
  });

  it("renders the aurora layer element", () => {
    render(<Field />);
    const aurora = screen.getByTestId("aurora-layer");
    expect(aurora).toBeInTheDocument();
  });

  it("canvas has fixed position and pointer-events:none", () => {
    render(<Field />);
    const canvas = screen.getByTestId("ambient-field");
    expect(canvas.style.position).toBe("fixed");
    expect(canvas.style.pointerEvents).toBe("none");
  });

  it("under reduced motion: canvas is still present (static render)", () => {
    mockMatchMedia(true);
    render(<Field />);
    const canvas = screen.getByTestId("ambient-field");
    expect(canvas).toBeInTheDocument();
  });

  it("under reduced motion: subscribe (animation) is not called", () => {
    mockMatchMedia(true);
    mockSubscribe.mockClear();
    render(<Field />);
    // Under reduced motion, we do a static draw and do NOT call subscribe
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it("without reduced motion: subscribe is called to animate", () => {
    mockMatchMedia(false);
    mockSubscribe.mockClear();
    render(<Field />);
    expect(mockSubscribe).toHaveBeenCalledTimes(1);
  });

  it("aurora layer has two child divs with radial-gradient backgrounds", () => {
    render(<Field />);
    const aurora = screen.getByTestId("aurora-layer");
    const children = aurora.querySelectorAll("div");
    expect(children.length).toBeGreaterThanOrEqual(2);
    // Both should have background styles set (radial-gradient)
    const bg1 = (children[0] as HTMLElement).style.background;
    const bg2 = (children[1] as HTMLElement).style.background;
    expect(bg1).toMatch(/radial-gradient/);
    expect(bg2).toMatch(/radial-gradient/);
  });

  it("aurora initial background uses opacity 0.12 and 0.08 (not 0.07/0.05)", () => {
    render(<Field />);
    const aurora = screen.getByTestId("aurora-layer");
    const children = aurora.querySelectorAll("div");
    const bg1 = (children[0] as HTMLElement).style.background;
    const bg2 = (children[1] as HTMLElement).style.background;
    expect(bg1).toContain("0.12");
    expect(bg2).toContain("0.08");
  });

  it("loom-mood event updates aurora background colors", async () => {
    const { act } = await import("@testing-library/react");
    render(<Field />);
    const aurora = screen.getByTestId("aurora-layer");
    const child1 = aurora.querySelectorAll("div")[0] as HTMLElement;

    // Record initial background
    const initialBg = child1.style.background;

    // Fire a mood event with a different mood (thinking = #a78bfa)
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("loom-mood", { detail: { mood: "thinking" } })
      );
    });

    // Background should have changed to reflect thinking color
    const newBg = child1.style.background;
    // The thinking mood color #a78bfa = rgb(167,139,250)
    expect(newBg).toContain("167");
  });
});
