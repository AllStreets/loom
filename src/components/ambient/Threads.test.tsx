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

import Threads from "./Threads";

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

  it("container has position:absolute and pointer-events:none", () => {
    render(<Threads />);
    const canvas = screen.getByTestId("ambient-threads");
    const container = canvas.parentElement;
    expect(container).not.toBeNull();
    expect(container!.style.position).toBe("absolute");
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
});
