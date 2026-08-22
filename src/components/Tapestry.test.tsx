/**
 * Tapestry.test.tsx
 *
 * Tests for the Tapestry component — LOOM's history woven as a band:
 * - Renders warp threads from timeline commits and weft threads from organs
 * - Woven geometry: bowed warp paths and Catmull-Rom weft curves (never
 *   straight <line> grids), checkerboard interlacing overdraws, a two-axis
 *   gradient mask, and 12px invisible hit paths on interactive threads
 * - Hover shows a glass label naming the thread; unhover hides it
 * - Click on an organ thread dispatches organ-focus; commit threads open the
 *   timeline details panel
 * - Empty state: faint warp + the exact first-organ line
 * - Setting cockpit.tapestry off/on live-toggles via loom-settings-changed
 * - Re-gathers on organs-changed (no polling)
 * - Reduced motion: no shimmer class
 * - Listeners cleaned up on unmount
 */

import { render, screen, act, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom";

// ---------------------------------------------------------------------------
// matchMedia mock (jsdom lacks it) — toggleable reduced-motion
// ---------------------------------------------------------------------------

let _prefersReducedMotion = false;

Object.defineProperty(window, "matchMedia", {
  writable: true,
  configurable: true,
  value: (query: string) => ({
    matches: _prefersReducedMotion && query.includes("reduced-motion"),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }),
});

// ---------------------------------------------------------------------------
// Tauri invoke mock — mutable per-test returns for timeline + organs
// ---------------------------------------------------------------------------

let _commits: Array<{ sha: string; message: string }> = [];
let _organs: Array<{ id: string; manifest: string; granted: string | null }> = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "timeline_log") return _commits;
    if (cmd === "organ_list") return _organs;
    return [];
  }),
}));

// Tapestry calls core through safeInvoke, which requires the Tauri globals.
beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  localStorage.clear();
  _prefersReducedMotion = false;
  _commits = [
    { sha: "a0cee82ffff", message: "stage 6 ships — command" },
    { sha: "b1def930000", message: "older work" },
  ];
  _organs = [{ id: "water-tracker", manifest: "{}", granted: null }];
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.clearAllMocks();
  localStorage.clear();
});

import Tapestry from "./Tapestry";

describe("Tapestry — render from LOOM's life", () => {
  it("renders the band with a warp thread per commit", async () => {
    render(<Tapestry />);
    expect(await screen.findByTestId("tapestry")).toBeInTheDocument();
    expect(await screen.findByTestId("tapestry-thread-warp-a0cee82ffff")).toBeInTheDocument();
    expect(screen.getByTestId("tapestry-thread-warp-b1def930000")).toBeInTheDocument();
  });

  it("renders a weft thread per alive organ", async () => {
    render(<Tapestry />);
    expect(await screen.findByTestId("tapestry-thread-organ-water-tracker")).toBeInTheDocument();
  });

  it("renders faint scar threads for deleted organs (tombstones)", async () => {
    localStorage.setItem("loom.organs.deleted", JSON.stringify(["old-timer"]));
    render(<Tapestry />);
    expect(await screen.findByTestId("tapestry-thread-scar-old-timer")).toBeInTheDocument();
  });

  it("renders build-experience threads from the experience log", async () => {
    localStorage.setItem(
      "loom.exp.v1",
      JSON.stringify([
        { ts: 1000, kind: "build", request: "x", organId: "water-tracker", ok: true, repairRounds: 2 },
      ])
    );
    render(<Tapestry />);
    expect(await screen.findByTestId("tapestry-thread-build-water-tracker-1000")).toBeInTheDocument();
  });
});

describe("Tapestry — woven geometry (cloth, not grid)", () => {
  it("warp threads render as bowed quadratic paths, not straight lines", async () => {
    render(<Tapestry />);
    const hit = await screen.findByTestId("tapestry-thread-warp-a0cee82ffff");
    expect(hit.tagName.toLowerCase()).toBe("path");
    // `M x,top Q x+bow,mid x,bottom` — the bow is what keeps it off graph paper
    expect(hit.getAttribute("d")).toMatch(/^M [\d.]+ [\d.]+ Q /);
    const group = hit.parentElement!;
    const visible = group.querySelector('path[stroke^="var("]')!;
    expect(visible.getAttribute("d")).toMatch(/ Q /);
  });

  it("weft threads render as smooth Catmull-Rom cubic curves", async () => {
    render(<Tapestry />);
    const hit = await screen.findByTestId("tapestry-thread-organ-water-tracker");
    expect(hit.tagName.toLowerCase()).toBe("path");
    expect(hit.getAttribute("d")).toMatch(/ C /); // cubic segments, not L-runs
  });

  it("interactive threads carry an invisible 12px-stroke hit path with pointer-events: stroke", async () => {
    render(<Tapestry />);
    const warpHit = await screen.findByTestId("tapestry-thread-warp-a0cee82ffff");
    expect(warpHit.getAttribute("stroke")).toBe("transparent");
    expect(warpHit.getAttribute("stroke-width")).toBe("12");
    expect(warpHit.style.pointerEvents).toBe("stroke");
    const weftHit = screen.getByTestId("tapestry-thread-organ-water-tracker");
    expect(weftHit.getAttribute("stroke-width")).toBe("12");
    expect(weftHit.style.pointerEvents).toBe("stroke");
  });

  it("overdraws short warp segments at every warp-over crossing ((i+j)%2===1)", async () => {
    render(<Tapestry />);
    await screen.findByTestId("tapestry-thread-organ-water-tracker");
    const interlace = screen.getByTestId("tapestry-interlace");
    const segments = interlace.querySelectorAll("line");
    // 2 warps × 1 weft row → exactly one warp-over crossing (i=1, j=0)
    expect(segments).toHaveLength(1);
    const seg = segments[0]!;
    // A short vertical overdraw: 12px tall (y±6), warp-colored
    expect(Number(seg.getAttribute("y2")) - Number(seg.getAttribute("y1"))).toBe(12);
    expect(seg.getAttribute("stroke")).toMatch(/^var\(--/);
  });

  it("wraps the weave in the two-axis gradient mask — no hard band edges", async () => {
    render(<Tapestry />);
    await screen.findByTestId("tapestry");
    const weave = screen.getByTestId("tapestry-weave");
    expect(weave.getAttribute("mask")).toBe("url(#loom-tap-mask)");
    const mask = document.getElementById("loom-tap-mask")!;
    expect(mask.tagName.toLowerCase()).toBe("mask");
    // the mask's rect multiplies the vertical fade with the horizontal one
    const rect = mask.querySelector("rect")!;
    expect(rect.getAttribute("fill")).toBe("url(#loom-tap-fade-y)");
    expect(rect.getAttribute("mask")).toBe("url(#loom-tap-mask-x)");
  });

  it("ties a knot circle (r 2.5) at a crossing of a repaired build's thread", async () => {
    localStorage.setItem(
      "loom.exp.v1",
      JSON.stringify([
        { ts: 1000, kind: "build", request: "x", organId: "water-tracker", ok: true, repairRounds: 2 },
      ])
    );
    render(<Tapestry />);
    await screen.findByTestId("tapestry-thread-build-water-tracker-1000");
    const knot = screen.getByTestId("tapestry-knot-build-water-tracker-1000-0");
    expect(knot.tagName.toLowerCase()).toBe("circle");
    expect(knot.getAttribute("r")).toBe("2.5");
    expect(knot.getAttribute("fill")).toBe("none");
    expect(knot.getAttribute("stroke")).toBe("var(--accent)");
  });

  it("scar threads render dashed and stay ≤ 0.15 opacity", async () => {
    localStorage.setItem("loom.organs.deleted", JSON.stringify(["old-timer"]));
    render(<Tapestry />);
    const hit = await screen.findByTestId("tapestry-thread-scar-old-timer");
    const visible = hit.parentElement!.querySelector('path[stroke^="var("]')!;
    expect(visible.getAttribute("stroke-dasharray")).toBe("3 5");
    expect(Number(visible.getAttribute("opacity"))).toBeLessThanOrEqual(0.15);
  });

  it("warp opacity is capped at ~0.3 — structure, never the story", async () => {
    render(<Tapestry />);
    const hit = await screen.findByTestId("tapestry-thread-warp-a0cee82ffff");
    const visible = hit.parentElement!.querySelector('path[stroke^="var("]')!;
    expect(Number(visible.getAttribute("opacity"))).toBeLessThanOrEqual(0.3);
  });
});

describe("Tapestry — hover label", () => {
  it("shows a glass label naming the thread on hover, hides on leave", async () => {
    render(<Tapestry />);
    const organ = await screen.findByTestId("tapestry-thread-organ-water-tracker");

    expect(screen.queryByTestId("tapestry-hover-label")).not.toBeInTheDocument();
    fireEvent.mouseEnter(organ, { clientX: 100, clientY: 100 });
    const chip = screen.getByTestId("tapestry-hover-label");
    expect(chip).toHaveTextContent("organ · water-tracker");

    fireEvent.mouseLeave(organ);
    expect(screen.queryByTestId("tapestry-hover-label")).not.toBeInTheDocument();
  });

  it("commit hover label carries the short sha and message", async () => {
    render(<Tapestry />);
    const warp = await screen.findByTestId("tapestry-thread-warp-a0cee82ffff");
    fireEvent.mouseEnter(warp, { clientX: 50, clientY: 50 });
    expect(screen.getByTestId("tapestry-hover-label")).toHaveTextContent(
      "commit a0cee82 · stage 6 ships — command"
    );
  });
});

describe("Tapestry — click actions", () => {
  it("clicking an organ thread dispatches organ-focus with the organ id", async () => {
    const spy = vi.fn();
    window.addEventListener("organ-focus", spy);
    render(<Tapestry />);
    const organ = await screen.findByTestId("tapestry-thread-organ-water-tracker");
    fireEvent.click(organ);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((spy.mock.calls[0][0] as CustomEvent).detail).toEqual({ id: "water-tracker" });
    window.removeEventListener("organ-focus", spy);
  });

  it("clicking a commit thread opens the timeline details panel", async () => {
    const details = document.createElement("details");
    details.setAttribute("data-testid", "timeline-details");
    document.body.appendChild(details);

    render(<Tapestry />);
    const warp = await screen.findByTestId("tapestry-thread-warp-a0cee82ffff");
    expect(details.open).toBe(false);
    fireEvent.click(warp);
    expect(details.open).toBe(true);

    details.remove();
  });
});

describe("Tapestry — empty state", () => {
  it("shows faint warp and the exact first-organ line when nothing is woven", async () => {
    _commits = [];
    _organs = [];
    render(<Tapestry />);
    expect(await screen.findByTestId("tapestry-empty-warp")).toBeInTheDocument();
    expect(screen.getByTestId("tapestry-empty-copy")).toHaveTextContent(
      "your tapestry begins when LOOM weaves its first organ."
    );
  });

  it("empty warps use the bowed rendering inside the mask — even empty looks intentional", async () => {
    _commits = [];
    _organs = [];
    render(<Tapestry />);
    const emptyWarp = await screen.findByTestId("tapestry-empty-warp");
    const paths = emptyWarp.querySelectorAll("path");
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0].getAttribute("d")).toMatch(/ Q /); // bowed, not ruled
    // the faint warps sit inside the masked weave group
    expect(screen.getByTestId("tapestry-weave").contains(emptyWarp)).toBe(true);
  });

  it("does not show the empty copy when the life has threads", async () => {
    render(<Tapestry />);
    await screen.findByTestId("tapestry-thread-organ-water-tracker");
    expect(screen.queryByTestId("tapestry-empty-copy")).not.toBeInTheDocument();
  });
});

describe("Tapestry — cockpit.tapestry setting", () => {
  it("renders nothing when cockpit.tapestry is off", () => {
    localStorage.setItem("cockpit.tapestry", "off");
    render(<Tapestry />);
    expect(screen.queryByTestId("tapestry")).not.toBeInTheDocument();
  });

  it("live-toggles via loom-settings-changed", async () => {
    render(<Tapestry />);
    expect(await screen.findByTestId("tapestry")).toBeInTheDocument();

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("loom-settings-changed", {
          detail: { key: "cockpit.tapestry", value: "off" },
        })
      );
    });
    expect(screen.queryByTestId("tapestry")).not.toBeInTheDocument();

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("loom-settings-changed", {
          detail: { key: "cockpit.tapestry", value: "on" },
        })
      );
    });
    expect(await screen.findByTestId("tapestry")).toBeInTheDocument();
  });
});

describe("Tapestry — event-driven refresh (no polling)", () => {
  it("re-gathers when organs-changed fires", async () => {
    render(<Tapestry />);
    await screen.findByTestId("tapestry-thread-organ-water-tracker");

    _organs = [
      { id: "water-tracker", manifest: "{}", granted: null },
      { id: "run-log", manifest: "{}", granted: null },
    ];
    await act(async () => {
      window.dispatchEvent(new CustomEvent("organs-changed"));
    });
    expect(await screen.findByTestId("tapestry-thread-organ-run-log")).toBeInTheDocument();
  });

  it("re-gathers when loom-fleet-activity fires", async () => {
    render(<Tapestry />);
    await screen.findByTestId("tapestry-thread-warp-a0cee82ffff");

    _commits = [
      { sha: "c2fed940000", message: "a fresh weave" },
      ..._commits,
    ];
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("loom-fleet-activity", { detail: { role: "builder" } })
      );
    });
    expect(await screen.findByTestId("tapestry-thread-warp-c2fed940000")).toBeInTheDocument();
  });
});

describe("Tapestry — motion discipline", () => {
  it("applies the slow shimmer class to weft threads by default", async () => {
    render(<Tapestry />);
    const organ = await screen.findByTestId("tapestry-thread-organ-water-tracker");
    const visible = organ.parentElement!.querySelector(".loom-weft-shimmer");
    expect(visible).not.toBeNull();
  });

  it("prefers-reduced-motion: fully static — no shimmer class anywhere", async () => {
    _prefersReducedMotion = true;
    render(<Tapestry />);
    await screen.findByTestId("tapestry-thread-organ-water-tracker");
    expect(document.querySelector(".loom-weft-shimmer")).toBeNull();
  });
});

describe("Tapestry — cleanup", () => {
  it("removes its refresh listeners on unmount", async () => {
    const { unmount } = render(<Tapestry />);
    await screen.findByTestId("tapestry");
    const spy = vi.spyOn(window, "removeEventListener");
    unmount();
    expect(spy).toHaveBeenCalledWith("loom-fleet-activity", expect.any(Function));
    expect(spy).toHaveBeenCalledWith("organs-changed", expect.any(Function));
    expect(spy).toHaveBeenCalledWith("loom-settings-changed", expect.any(Function));
  });
});

describe("Tapestry — data honesty in the browser (no shell)", () => {
  it("falls back to empty timeline/organs when the shell is unavailable", async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    render(<Tapestry />);
    // No crash; empty state renders (browser mode degrades honestly)
    expect(await screen.findByTestId("tapestry-empty-copy")).toBeInTheDocument();
  });
});
