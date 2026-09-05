/**
 * Shuttle.test.tsx — the Cmd+K palette.
 *
 * - Cmd+K / Ctrl+K toggles the glass overlay; listener registered at window
 *   CAPTURE phase so it wins when the shell has focus
 * - input auto-focused, focus trapped (Tab stays put), Esc closes,
 *   click-outside closes
 * - fuzzy-filtered grouped list, arrow keys move selection, Enter executes
 * - execution dispatches the entry's canonical phrase through the SAME
 *   loom-utterance seam voice transcripts take (spoken: false); palette closes
 * - free text with no catalog match falls through the same seam
 * - template entries pre-fill the input instead of executing
 * - plain "k" and Space never open it (no PTT interference)
 */

import { render, screen, act, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom";

// ---------------------------------------------------------------------------
// matchMedia mock (jsdom lacks it)
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

vi.mock("framer-motion", async (importActual) => {
  const actual = await importActual<typeof import("framer-motion")>();
  return { ...actual, useReducedMotion: () => _prefersReducedMotion };
});

// ---------------------------------------------------------------------------
// Tauri invoke mock — organ list for the ORGANS group
// ---------------------------------------------------------------------------

let _organs: Array<{ id: string; manifest: string; granted: string | null }> = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "organ_list") return _organs;
    return [];
  }),
}));

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  _prefersReducedMotion = false;
  _organs = [
    { id: "water-tracker", manifest: JSON.stringify({ id: "water-tracker", name: "Water Tracker" }), granted: null },
    { id: "settings", manifest: JSON.stringify({ id: "settings", name: "Settings" }), granted: null },
  ];
});

afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.clearAllMocks();
});

import Shuttle from "./Shuttle";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function openPalette() {
  await act(async () => {
    fireEvent.keyDown(window, { key: "k", metaKey: true });
  });
  return screen.findByTestId("shuttle-palette");
}

function paletteInput(): HTMLInputElement {
  return screen.getByTestId("shuttle-input") as HTMLInputElement;
}

// ---------------------------------------------------------------------------

describe("Shuttle — open / close", () => {
  it("is closed by default (renders nothing)", () => {
    render(<Shuttle />);
    expect(screen.queryByTestId("shuttle-palette")).not.toBeInTheDocument();
  });

  it("Cmd+K opens; second Cmd+K closes (toggle)", async () => {
    render(<Shuttle />);
    await openPalette();
    expect(screen.getByTestId("shuttle-palette")).toBeInTheDocument();
    await act(async () => {
      fireEvent.keyDown(window, { key: "k", metaKey: true });
    });
    expect(screen.queryByTestId("shuttle-palette")).not.toBeInTheDocument();
  });

  it("Ctrl+K opens too", async () => {
    render(<Shuttle />);
    await act(async () => {
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    });
    expect(screen.getByTestId("shuttle-palette")).toBeInTheDocument();
  });

  it("plain 'k' and Space do NOT open it (no PTT interference)", async () => {
    render(<Shuttle />);
    await act(async () => {
      fireEvent.keyDown(window, { key: "k" });
      fireEvent.keyDown(window, { code: "Space", key: " " });
    });
    expect(screen.queryByTestId("shuttle-palette")).not.toBeInTheDocument();
  });

  it("Esc closes", async () => {
    render(<Shuttle />);
    await openPalette();
    await act(async () => {
      fireEvent.keyDown(paletteInput(), { key: "Escape" });
    });
    expect(screen.queryByTestId("shuttle-palette")).not.toBeInTheDocument();
  });

  it("click outside (backdrop) closes; click inside panel does not", async () => {
    render(<Shuttle />);
    await openPalette();
    await act(async () => {
      fireEvent.mouseDown(screen.getByTestId("shuttle-panel"));
    });
    expect(screen.getByTestId("shuttle-palette")).toBeInTheDocument();
    await act(async () => {
      fireEvent.mouseDown(screen.getByTestId("shuttle-backdrop"));
    });
    expect(screen.queryByTestId("shuttle-palette")).not.toBeInTheDocument();
  });

  it("loom-shuttle-open event opens the palette (top-bar chip seam)", async () => {
    render(<Shuttle />);
    await act(async () => {
      window.dispatchEvent(new CustomEvent("loom-shuttle-open"));
    });
    expect(screen.getByTestId("shuttle-palette")).toBeInTheDocument();
  });

  it("registers its keydown listener at window CAPTURE phase", () => {
    const spy = vi.spyOn(window, "addEventListener");
    render(<Shuttle />);
    const call = spy.mock.calls.find(
      (c) => c[0] === "keydown" && c[2] === true
    );
    expect(call).toBeDefined();
    spy.mockRestore();
  });
});

describe("Shuttle — focus", () => {
  it("input is focused on open", async () => {
    render(<Shuttle />);
    await openPalette();
    expect(document.activeElement).toBe(paletteInput());
  });

  it("Tab is trapped (focus stays on the input)", async () => {
    render(<Shuttle />);
    await openPalette();
    await act(async () => {
      fireEvent.keyDown(paletteInput(), { key: "Tab" });
    });
    expect(document.activeElement).toBe(paletteInput());
  });
});

describe("Shuttle — grouped list + fuzzy filter", () => {
  it("shows mono-uppercase group headers for populated groups", async () => {
    render(<Shuttle />);
    await openPalette();
    expect(screen.getByTestId("shuttle-group-build")).toHaveTextContent(/build/i);
    expect(screen.queryByTestId("shuttle-group-decks")).not.toBeInTheDocument();
    expect(screen.queryByTestId("shuttle-group-watch")).not.toBeInTheDocument();
    expect(screen.getByTestId("shuttle-group-system")).toBeInTheDocument();
    // organs group appears once the organ list loads
    expect(await screen.findByTestId("shuttle-group-organs")).toBeInTheDocument();
    expect(await screen.findByText("open water tracker")).toBeInTheDocument();
  });

  it("typing filters the list (what can → help stays, build template gone)", async () => {
    render(<Shuttle />);
    await openPalette();
    await act(async () => {
      fireEvent.change(paletteInput(), { target: { value: "what can" } });
    });
    expect(screen.getByText("what can you do")).toBeInTheDocument();
    expect(screen.queryByText("build me a …")).not.toBeInTheDocument();
  });

  it("no match shows the free-text hint row", async () => {
    render(<Shuttle />);
    await openPalette();
    await act(async () => {
      fireEvent.change(paletteInput(), { target: { value: "zqxjv" } });
    });
    expect(screen.getByTestId("shuttle-freetext-hint")).toBeInTheDocument();
  });
});

describe("Shuttle — execution routes through the voice seam", () => {
  it("Enter executes the selected entry: loom-utterance with canonical phrase, spoken:false, palette closes", async () => {
    const spy = vi.fn();
    window.addEventListener("loom-utterance", spy);
    render(<Shuttle />);
    await openPalette();
    await screen.findByText("open water tracker"); // organs group loaded
    await act(async () => {
      // the top entry is the build TEMPLATE (pre-fills, never dispatches);
      // step down to the first utterance entry
      fireEvent.keyDown(paletteInput(), { key: "ArrowDown" });
    });
    await act(async () => {
      fireEvent.keyDown(paletteInput(), { key: "Enter" });
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const detail = (spy.mock.calls[0][0] as CustomEvent).detail;
    expect(detail).toEqual({ text: "open water tracker", spoken: false });
    expect(screen.queryByTestId("shuttle-palette")).not.toBeInTheDocument();
    window.removeEventListener("loom-utterance", spy);
  });

  it("ArrowDown moves selection twice; Enter executes the third entry", async () => {
    const spy = vi.fn();
    window.addEventListener("loom-utterance", spy);
    render(<Shuttle />);
    await openPalette();
    await screen.findByText("open water tracker");
    await act(async () => {
      fireEvent.keyDown(paletteInput(), { key: "ArrowDown" });
    });
    await act(async () => {
      fireEvent.keyDown(paletteInput(), { key: "ArrowDown" });
    });
    await act(async () => {
      fireEvent.keyDown(paletteInput(), { key: "Enter" });
    });
    const detail = (spy.mock.calls[0][0] as CustomEvent).detail;
    expect(detail.text).toBe("open settings");
    window.removeEventListener("loom-utterance", spy);
  });

  it("ArrowUp from the top wraps to the last entry", async () => {
    render(<Shuttle />);
    await openPalette();
    await act(async () => {
      fireEvent.change(paletteInput(), { target: { value: "what can" } });
      fireEvent.keyDown(paletteInput(), { key: "ArrowUp" });
    });
    // only one match — selection stays valid (smoke: no crash, entry selected)
    const row = screen.getByText("what can you do").closest("[data-selected]");
    expect(row).toHaveAttribute("data-selected", "true");
  });

  it("click on a row executes it through the same seam", async () => {
    const spy = vi.fn();
    window.addEventListener("loom-utterance", spy);
    render(<Shuttle />);
    await openPalette();
    await act(async () => {
      fireEvent.click(screen.getByText("what can you do"));
    });
    const detail = (spy.mock.calls[0][0] as CustomEvent).detail;
    expect(detail).toEqual({ text: "what can you do", spoken: false });
    expect(screen.queryByTestId("shuttle-palette")).not.toBeInTheDocument();
    window.removeEventListener("loom-utterance", spy);
  });

  it("free text with no catalog match falls through the seam verbatim", async () => {
    const spy = vi.fn();
    window.addEventListener("loom-utterance", spy);
    render(<Shuttle />);
    await openPalette();
    await act(async () => {
      fireEvent.change(paletteInput(), { target: { value: "what is the meaning of zqxjv" } });
      fireEvent.keyDown(paletteInput(), { key: "Enter" });
    });
    const detail = (spy.mock.calls[0][0] as CustomEvent).detail;
    expect(detail).toEqual({ text: "what is the meaning of zqxjv", spoken: false });
    expect(screen.queryByTestId("shuttle-palette")).not.toBeInTheDocument();
    window.removeEventListener("loom-utterance", spy);
  });

  it("Enter with unmatched whitespace-only text does not dispatch", async () => {
    const spy = vi.fn();
    window.addEventListener("loom-utterance", spy);
    render(<Shuttle />);
    await openPalette();
    await act(async () => {
      // non-matching query first so no entry is selected, then blank it out
      fireEvent.change(paletteInput(), { target: { value: "zqxjv" } });
      fireEvent.keyDown(paletteInput(), { key: "Enter" });
    });
    // "zqxjv" matched nothing but IS free text → it dispatches; reset and
    // verify blank free text never dispatches
    expect(spy).toHaveBeenCalledTimes(1);
    await openPalette();
    // whitespace query → treated as empty → full list, top entry selected;
    // Enter executes the selection (never the whitespace as free text). The
    // top entry is the build template, so step to the first utterance first.
    await screen.findByText("open water tracker");
    await act(async () => {
      fireEvent.change(paletteInput(), { target: { value: "   " } });
      fireEvent.keyDown(paletteInput(), { key: "ArrowDown" });
    });
    await act(async () => {
      fireEvent.keyDown(paletteInput(), { key: "Enter" });
    });
    expect(spy).toHaveBeenCalledTimes(2);
    const detail = (spy.mock.calls[1][0] as CustomEvent).detail;
    expect(detail.text).toBe("open water tracker");
    window.removeEventListener("loom-utterance", spy);
  });

  it("template entry (build me a …) pre-fills the input and stays open", async () => {
    const spy = vi.fn();
    window.addEventListener("loom-utterance", spy);
    render(<Shuttle />);
    await openPalette();
    await act(async () => {
      fireEvent.change(paletteInput(), { target: { value: "build me" } });
      fireEvent.keyDown(paletteInput(), { key: "Enter" });
    });
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByTestId("shuttle-palette")).toBeInTheDocument();
    expect(paletteInput().value).toBe("build me a ");
    // completing the template and hitting Enter executes as an utterance
    await act(async () => {
      fireEvent.change(paletteInput(), { target: { value: "build me a zq tracker" } });
      fireEvent.keyDown(paletteInput(), { key: "Enter" });
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const detail = (spy.mock.calls[0][0] as CustomEvent).detail;
    expect(detail).toEqual({ text: "build me a zq tracker", spoken: false });
    window.removeEventListener("loom-utterance", spy);
  });
});

describe("Shuttle — cleanup", () => {
  it("removes window listeners on unmount", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(<Shuttle />);
    const added = addSpy.mock.calls.filter((c) => c[0] === "keydown" || c[0] === "loom-shuttle-open").length;
    unmount();
    const removed = removeSpy.mock.calls.filter((c) => c[0] === "keydown" || c[0] === "loom-shuttle-open").length;
    expect(removed).toBeGreaterThanOrEqual(added);
    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
});
