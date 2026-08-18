/**
 * DeckLayer.test.tsx — Deck layer + AUSPEX globe deck integration tests.
 * Tests cover: void/globe rendering, z-index, pointer-events, deck switching,
 * interact mode, companion panel compact mode, Field dim prop, orb-band
 * pointer-events safety, and bundle file existence.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { existsSync } from "fs";
import path from "path";
import DeckLayer from "./DeckLayer";
import Shell from "../Shell";
import * as settingsMod from "../../lib/voice/settings";

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock("../../lib/voice/settings", () => ({
  getSetting: vi.fn((k: string) => (k === "cockpit.deck" ? "void" : "")),
  setSetting: vi.fn(),
}));

vi.mock("framer-motion", () => ({
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) =>
      <div {...props}>{children}</div>,
  },
  useReducedMotion: () => false,
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));

vi.mock("../orb/Orb", () => ({
  Orb: () => <div data-testid="orb" />,
}));

vi.mock("../FleetHUD", () => ({
  default: () => <div data-testid="fleet-hud" />,
}));

vi.mock("../Companion", () => ({
  default: () => <div data-testid="companion" />,
}));

vi.mock("../desktop/Desktop", () => ({
  default: () => <div data-testid="desktop" />,
}));

vi.mock("../ambient/Threads", () => ({
  default: () => <div data-testid="threads" />,
}));

vi.mock("../../lib/core", () => ({
  fleetStatus: vi.fn().mockResolvedValue([]),
  timelineInit: vi.fn().mockResolvedValue(undefined),
  timelineLog: vi.fn().mockResolvedValue([]),
  voiceStatus: vi.fn().mockResolvedValue({ ready: false }),
  organList: vi.fn().mockResolvedValue([]),
  organWrite: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../organs/seeds/install", () => ({
  installSeeds: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../lib/voice/useVoice", () => ({
  useVoice: vi.fn(() => ({
    state: "idle",
    error: null,
    start: vi.fn(),
    stop: vi.fn(),
    cancel: vi.fn(),
  })),
  makeSpacePttHandlers: vi.fn(() => ({
    onKeyDown: vi.fn(),
    onKeyUp: vi.fn(),
  })),
}));

vi.mock("../../lib/orb/audioLevel", () => ({
  audioLevel: { current: 0 },
}));

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// ── DeckLayer isolation tests ──────────────────────────────────────────────────

describe("DeckLayer", () => {
  it("1. renders nothing when deck=void (no iframe)", () => {
    render(
      <DeckLayer deck="void" interactMode={false} onInteractToggle={() => {}} />
    );
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("2. renders iframe with /decks/auspex/index.html when deck=globe", () => {
    render(
      <DeckLayer deck="globe" interactMode={false} onInteractToggle={() => {}} />
    );
    const iframe = document.querySelector("iframe");
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute("src")).toContain("decks/auspex/index.html");
  });

  it("3. deck layer has zIndex 2", () => {
    render(
      <DeckLayer deck="void" interactMode={false} onInteractToggle={() => {}} />
    );
    const layer = screen.getByTestId("deck-layer");
    expect(layer.style.zIndex).toBe("2");
  });

  it("4. deck layer has pointerEvents none", () => {
    render(
      <DeckLayer deck="void" interactMode={false} onInteractToggle={() => {}} />
    );
    const layer = screen.getByTestId("deck-layer");
    expect(layer.style.pointerEvents).toBe("none");
  });

  it("7. iframe has pointerEvents none when interactMode=false", () => {
    render(
      <DeckLayer deck="globe" interactMode={false} onInteractToggle={() => {}} />
    );
    const iframe = document.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe?.style.pointerEvents).toBe("none");
  });

  it("8. iframe has pointerEvents auto when interactMode=true", () => {
    render(
      <DeckLayer deck="globe" interactMode={true} onInteractToggle={() => {}} />
    );
    const iframe = document.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe?.style.pointerEvents).toBe("auto");
  });
});

// ── Shell integration tests ───────────────────────────────────────────────────

describe("Shell deck integration", () => {
  beforeEach(() => {
    vi.mocked(settingsMod.getSetting).mockImplementation(
      (k: string) => (k === "cockpit.deck" ? "void" : "")
    );
  });

  it("5. loom-deck CustomEvent switches deck and persists to localStorage", async () => {
    render(<Shell />);

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("loom-deck", { detail: { deck: "globe" } })
      );
    });

    expect(settingsMod.setSetting).toHaveBeenCalledWith("cockpit.deck", "globe");
  });

  it("6. interact toggle button appears only when deck=globe", async () => {
    render(<Shell />);

    // Initially void — no interact button
    expect(screen.queryByTestId("deck-interact-btn")).toBeNull();

    // Switch to globe
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("loom-deck", { detail: { deck: "globe" } })
      );
    });

    expect(screen.getByTestId("deck-interact-btn")).not.toBeNull();
  });

  it("9. companion panel gets data-deck-active when deck=globe", async () => {
    render(<Shell />);

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("loom-deck", { detail: { deck: "globe" } })
      );
    });

    // Find the PanelTag wrapper with data-deck-active
    const panels = document.querySelectorAll("[data-deck-active='true']");
    expect(panels.length).toBeGreaterThan(0);
  });

  it("10. Field rendered with dim=true when deck=globe", async () => {
    render(<Shell />);

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("loom-deck", { detail: { deck: "globe" } })
      );
    });

    // When dim=true, the canvas opacity should be 0.35
    const canvas = screen.getByTestId("ambient-field") as HTMLCanvasElement;
    expect(canvas.style.opacity).toBe("0.35");
  });

  it("11. orb-band pointer-events unaffected by deck=globe + interactMode=false", async () => {
    render(<Shell />);

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("loom-deck", { detail: { deck: "globe" } })
      );
    });

    const orbBand = screen.getByTestId("orb-band");
    // orb-band should not have pointerEvents: none (it must stay clickable)
    expect(orbBand.style.pointerEvents).not.toBe("none");
  });
});

// ── Bundle existence tests ─────────────────────────────────────────────────────

describe("Bundle existence", () => {
  const repoRoot = path.resolve(process.cwd());

  it("12a. public/decks/auspex/index.html exists", () => {
    expect(
      existsSync(path.join(repoRoot, "public/decks/auspex/index.html"))
    ).toBe(true);
  });

  it("12b. public/decks/auspex/loom-adapter.js exists", () => {
    expect(
      existsSync(path.join(repoRoot, "public/decks/auspex/loom-adapter.js"))
    ).toBe(true);
  });
});
