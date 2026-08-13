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
});
