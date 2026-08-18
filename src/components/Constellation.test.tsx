/**
 * Constellation.test.tsx
 *
 * Tests for the Constellation component:
 * - 5 nodes (builder, companion, rewriter, auspex, quakes)
 * - Activity event flips data-active attr on the matching role node
 * - Null activity clears data-active on all role nodes
 * - Salience event adds loom-sensor-pulsing class on sensor nodes
 * - Event listeners are cleaned up on unmount
 */

import { render, screen, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom";

// matchMedia mock
Object.defineProperty(window, "matchMedia", {
  writable: true,
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }),
});

// ResizeObserver mock
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

beforeEach(() => {
  localStorage.clear();
  // Constellation defaults to "off"; enable it for all tests
  localStorage.setItem("cockpit.constellation", "on");
});

afterEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

import Constellation from "./Constellation";

const NODE_IDS = ["builder", "companion", "rewriter", "auspex", "quakes"] as const;

describe("Constellation — node set", () => {
  it("renders exactly 5 nodes", () => {
    render(<Constellation />);
    const nodes = screen.getAllByTestId(/^constellation-node-/);
    expect(nodes).toHaveLength(5);
  });

  it("renders a node for each expected id", () => {
    render(<Constellation />);
    for (const id of NODE_IDS) {
      expect(screen.getByTestId(`constellation-node-${id}`)).toBeInTheDocument();
    }
  });

  it("renders wire paths for each node", () => {
    render(<Constellation />);
    for (const id of NODE_IDS) {
      expect(screen.getByTestId(`wire-${id}`)).toBeInTheDocument();
    }
  });

  it("core wires use a per-node gradient stroke (brighter toward the orb)", () => {
    render(<Constellation />);
    for (const id of NODE_IDS) {
      const wire = screen.getByTestId(`wire-${id}`);
      expect(wire.getAttribute("stroke")).toBe(`url(#loom-wire-grad-${id})`);
    }
  });

  it("role nodes have data-node-kind='role'", () => {
    render(<Constellation />);
    const roleIds = ["builder", "companion", "rewriter"];
    for (const id of roleIds) {
      const node = screen.getByTestId(`constellation-node-${id}`);
      expect(node.getAttribute("data-node-kind")).toBe("role");
    }
  });

  it("sensor nodes have data-node-kind='sensor'", () => {
    render(<Constellation />);
    const sensorIds = ["auspex", "quakes"];
    for (const id of sensorIds) {
      const node = screen.getByTestId(`constellation-node-${id}`);
      expect(node.getAttribute("data-node-kind")).toBe("sensor");
    }
  });
});

describe("Constellation — fleet activity attribute flip", () => {
  it("sets data-active='true' on the builder node when builder activity fires", async () => {
    render(<Constellation />);
    const node = screen.getByTestId("constellation-node-builder");

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("loom-fleet-activity", { detail: { role: "builder", phase: "coding" } })
      );
    });

    expect(node.getAttribute("data-active")).toBe("true");
  });

  it("sets data-active='true' on the companion node when companion activity fires", async () => {
    render(<Constellation />);
    const node = screen.getByTestId("constellation-node-companion");

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("loom-fleet-activity", { detail: { role: "companion", phase: "answering" } })
      );
    });

    expect(node.getAttribute("data-active")).toBe("true");
  });

  it("sets data-active='true' on the rewriter node when rewriter activity fires", async () => {
    render(<Constellation />);
    const node = screen.getByTestId("constellation-node-rewriter");

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("loom-fleet-activity", { detail: { role: "rewriter", phase: "refactoring" } })
      );
    });

    expect(node.getAttribute("data-active")).toBe("true");
  });

  it("clears data-active on all role nodes when role:null fires", async () => {
    render(<Constellation />);

    // First light one up
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("loom-fleet-activity", { detail: { role: "builder", phase: "coding" } })
      );
    });

    const builderNode = screen.getByTestId("constellation-node-builder");
    expect(builderNode.getAttribute("data-active")).toBe("true");

    // Now clear
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("loom-fleet-activity", { detail: { role: null } })
      );
    });

    expect(builderNode.getAttribute("data-active")).toBeNull();
  });

  it("switching roles clears the previous role's active state", async () => {
    render(<Constellation />);

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("loom-fleet-activity", { detail: { role: "builder" } })
      );
    });

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("loom-fleet-activity", { detail: { role: "rewriter" } })
      );
    });

    const builderNode = screen.getByTestId("constellation-node-builder");
    const rewriterNode = screen.getByTestId("constellation-node-rewriter");

    expect(builderNode.getAttribute("data-active")).toBeNull();
    expect(rewriterNode.getAttribute("data-active")).toBe("true");
  });
});

describe("Constellation — salience pulse", () => {
  it("adds loom-sensor-pulsing class to auspex node on loom-salience event", async () => {
    render(<Constellation />);
    const node = screen.getByTestId("constellation-node-auspex");

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("loom-salience", { detail: { items: [] } })
      );
    });

    expect(node.classList.contains("loom-sensor-pulsing")).toBe(true);
  });

  it("adds loom-sensor-pulsing class to quakes node on loom-salience event", async () => {
    render(<Constellation />);
    const node = screen.getByTestId("constellation-node-quakes");

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("loom-salience", { detail: { items: [] } })
      );
    });

    expect(node.classList.contains("loom-sensor-pulsing")).toBe(true);
  });

  it("does NOT add pulse class to role nodes on salience", async () => {
    render(<Constellation />);
    const roleNode = screen.getByTestId("constellation-node-builder");

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("loom-salience", { detail: { items: [] } })
      );
    });

    expect(roleNode.classList.contains("loom-sensor-pulsing")).toBe(false);
  });
});

describe("Constellation — cleanup", () => {
  it("removes loom-fleet-activity listener on unmount", async () => {
    const { unmount } = render(<Constellation />);
    const spy = vi.spyOn(window, "removeEventListener");
    unmount();
    expect(spy).toHaveBeenCalledWith("loom-fleet-activity", expect.any(Function));
  });

  it("removes loom-salience listener on unmount", async () => {
    const { unmount } = render(<Constellation />);
    const spy = vi.spyOn(window, "removeEventListener");
    unmount();
    expect(spy).toHaveBeenCalledWith("loom-salience", expect.any(Function));
  });
});
