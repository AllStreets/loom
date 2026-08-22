/**
 * Shell.chatmin.test.tsx — the typing box folds away; the weave stays visible.
 *
 * Covers the minimizable companion surface:
 * - hover-reveal minimize control collapses the panel to the bottom-center
 *   glass pill (LoomGlyph + ⌘K hint); the panel is hidden, never unmounted
 * - clicking the pill restores
 * - state persists as cockpit.chatMin and live-updates via loom-settings-changed
 * - Space PTT still starts/stops voice while minimized
 * - an incoming loom-utterance (voice PTT or Shuttle free-text) auto-restores
 *   the surface — the reply bubble renders inside the companion panel and
 *   nowhere else, so the surface must return to show it
 */

import { render, screen, act, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom";

// ---------------------------------------------------------------------------
// matchMedia mock (jsdom lacks it)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tauri invoke mock
// ---------------------------------------------------------------------------

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "fleet_status") return [];
    if (cmd === "organ_list") return [];
    return [];
  }),
}));

// ---------------------------------------------------------------------------
// Voice mock — real makeSpacePttHandlers, spyable start/stop, so the PTT
// seam is exercised for real while the typing box is folded.
// ---------------------------------------------------------------------------

const _voice = {
  state: "idle" as const,
  error: null as string | null,
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  cancel: vi.fn(),
};

vi.mock("../lib/voice/useVoice", async (importActual) => {
  const actual = await importActual<typeof import("../lib/voice/useVoice")>();
  return {
    ...actual,
    useVoice: () => _voice,
  };
});

beforeEach(() => {
  localStorage.setItem("loom.orb", "flat"); // never touch WebGL in jsdom
  localStorage.setItem("loom.ignited", "1");
  _voice.start.mockClear();
  _voice.stop.mockClear();
});

afterEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

import Shell from "./Shell";

describe("Shell — minimizable typing box", () => {
  it("minimize collapses the panel to the bottom-center pill; Companion stays mounted", async () => {
    render(<Shell />);
    const btn = screen.getByTestId("chat-min-btn");
    expect(screen.queryByTestId("chat-min-pill")).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(btn);
    });

    // the panel folds — hidden, not unmounted (Companion keeps the
    // conversation and the loom-utterance listener alive behind the fold)
    expect(screen.getByTestId("companion-panel").style.display).toBe("none");
    expect(screen.getByPlaceholderText(/Talk to LOOM/i)).toBeInTheDocument();

    // the pill: glass, bottom-center, glyph + mono ⌘K hint
    const pill = screen.getByTestId("chat-min-pill");
    expect(pill).toHaveTextContent("⌘K");
    expect(pill.querySelector('[data-testid="loom-glyph"]')).not.toBeNull();
  });

  it("clicking the pill restores the typing box", async () => {
    localStorage.setItem("cockpit.chatMin", "on");
    render(<Shell />);
    const pill = screen.getByTestId("chat-min-pill");

    await act(async () => {
      fireEvent.click(pill);
    });

    expect(screen.queryByTestId("chat-min-pill")).not.toBeInTheDocument();
    expect(screen.getByTestId("companion-panel").style.display).not.toBe("none");
  });

  it("persists as cockpit.chatMin: minimize writes on, restore writes off", async () => {
    render(<Shell />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("chat-min-btn"));
    });
    expect(localStorage.getItem("cockpit.chatMin")).toBe("on");

    await act(async () => {
      fireEvent.click(screen.getByTestId("chat-min-pill"));
    });
    expect(localStorage.getItem("cockpit.chatMin")).toBe("off");
  });

  it("boots minimized when cockpit.chatMin is on", () => {
    localStorage.setItem("cockpit.chatMin", "on");
    render(<Shell />);
    expect(screen.getByTestId("chat-min-pill")).toBeInTheDocument();
    expect(screen.getByTestId("companion-panel").style.display).toBe("none");
  });

  it("live-updates via loom-settings-changed", async () => {
    render(<Shell />);
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("loom-settings-changed", {
          detail: { key: "cockpit.chatMin", value: "on" },
        })
      );
    });
    expect(screen.getByTestId("chat-min-pill")).toBeInTheDocument();

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("loom-settings-changed", {
          detail: { key: "cockpit.chatMin", value: "off" },
        })
      );
    });
    expect(screen.queryByTestId("chat-min-pill")).not.toBeInTheDocument();
  });

  it("Space PTT still starts and stops voice while minimized", async () => {
    localStorage.setItem("cockpit.chatMin", "on");
    render(<Shell />);
    expect(screen.getByTestId("chat-min-pill")).toBeInTheDocument();

    await act(async () => {
      fireEvent.keyDown(window, { code: "Space" });
    });
    expect(_voice.start).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.keyUp(window, { code: "Space" });
    });
    expect(_voice.stop).toHaveBeenCalledTimes(1);
  });

  it("auto-restores when an utterance arrives — the reply needs the surface", async () => {
    localStorage.setItem("cockpit.chatMin", "on");
    render(<Shell />);
    expect(screen.getByTestId("chat-min-pill")).toBeInTheDocument();

    // voice PTT and Shuttle free-text both send through loom-utterance
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("loom-utterance", { detail: { text: "hello loom", spoken: true } })
      );
    });

    expect(screen.queryByTestId("chat-min-pill")).not.toBeInTheDocument();
    expect(screen.getByTestId("companion-panel").style.display).not.toBe("none");
    expect(localStorage.getItem("cockpit.chatMin")).toBe("off");
  });
});
