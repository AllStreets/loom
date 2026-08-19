import { describe, it, expect, vi } from "vitest";
import { handle, type CompanionDeps } from "./runtime";
import type { ScoredEvent } from "../watch/types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDeps(overrides: Partial<CompanionDeps> = {}): CompanionDeps {
  return {
    chat: vi.fn().mockResolvedValue("chat reply"),
    build: vi.fn().mockResolvedValue({ ok: true, organId: "test", sha: "abc", log: [] }),
    edit: vi.fn().mockResolvedValue({ ok: true, organId: "test", sha: "abc", log: [] }),
    organIds: vi.fn().mockResolvedValue([]),
    askModel: vi.fn().mockResolvedValue('{"intent":"converse","organId":null}'),
    currentDeck: () => "void",
    ...overrides,
  };
}

// ── deck_command fast path ────────────────────────────────────────────────────

describe("handle — deck_command routes without model call", () => {
  it("'show the globe' returns deck_command turn kind, no chat/askModel call", async () => {
    const deps = makeDeps();
    const turn = await handle("show the globe", [], deps);
    expect(turn.kind).toBe("deck_command");
    expect(deps.chat).not.toHaveBeenCalled();
    expect(deps.askModel).not.toHaveBeenCalled();
  });

  it("deck_command turn carries deckCommandResult with deckSwitch:globe", async () => {
    const deps = makeDeps();
    const turn = await handle("show the globe", [], deps);
    if (turn.kind !== "deck_command") throw new Error("Expected deck_command");
    expect(turn.deckCommandResult.deckSwitch).toBe("globe");
    expect(turn.deckCommandResult.bridgeCmds).toHaveLength(0);
  });

  it("'show military news' returns deck_command with set_cat military, no model call", async () => {
    const deps = makeDeps({ currentDeck: () => "globe" });
    const turn = await handle("show military news", [], deps);
    expect(turn.kind).toBe("deck_command");
    expect(deps.askModel).not.toHaveBeenCalled();
    if (turn.kind !== "deck_command") throw new Error("Expected deck_command");
    expect(turn.deckCommandResult.bridgeCmds[0]).toEqual({ type: "set_cat", cat: "military" });
    expect(turn.deckCommandResult.deckSwitch).toBeUndefined();
    expect(turn.confirmation).toMatch(/military/i);
  });

  it("'show vessels' from void → deckSwitch:globe FIRST then toggle_overlay vessels", async () => {
    const deps = makeDeps({ currentDeck: () => "void" });
    const turn = await handle("show vessels", [], deps);
    if (turn.kind !== "deck_command") throw new Error("Expected deck_command");
    expect(turn.deckCommandResult.deckSwitch).toBe("globe");
    expect(turn.deckCommandResult.bridgeCmds[0]).toEqual({ type: "toggle_overlay", overlay: "vessels" });
  });

  it("'reset the view' → deck_command with reset_view, confirmation 'View reset.'", async () => {
    const deps = makeDeps({ currentDeck: () => "globe" });
    const turn = await handle("reset the view", [], deps);
    if (turn.kind !== "deck_command") throw new Error("Expected deck_command");
    expect(turn.deckCommandResult.bridgeCmds[0]).toEqual({ type: "reset_view" });
    expect(turn.confirmation).toMatch(/view reset/i);
  });

  it("'stop spinning' → deck_command with set_spin false", async () => {
    const deps = makeDeps({ currentDeck: () => "globe" });
    const turn = await handle("stop spinning", [], deps);
    if (turn.kind !== "deck_command") throw new Error("Expected deck_command");
    expect(turn.deckCommandResult.bridgeCmds[0]).toEqual({ type: "set_spin", on: false });
  });

  it("'hide the globe' → deck_command with deckSwitch:void", async () => {
    const deps = makeDeps({ currentDeck: () => "globe" });
    const turn = await handle("hide the globe", [], deps);
    if (turn.kind !== "deck_command") throw new Error("Expected deck_command");
    expect(turn.deckCommandResult.deckSwitch).toBe("void");
  });
});

// ── Existing intents still route correctly ────────────────────────────────────

describe("handle — non-deck intents unaffected", () => {
  it("'hello' still routes to converse (reply kind)", async () => {
    const deps = makeDeps({ chat: vi.fn().mockResolvedValue("Hello from LOOM") });
    const turn = await handle("hello", [], deps);
    expect(turn.kind).toBe("reply");
  });

  it("'build me a water tracker' still routes to build kind", async () => {
    const deps = makeDeps();
    const turn = await handle("build me a water tracker", [], deps);
    expect(turn.kind).toBe("build");
  });

  it("'show me a water tracker' with organ → act kind", async () => {
    const deps = makeDeps({ organIds: vi.fn().mockResolvedValue(["water-tracker"]) });
    const turn = await handle("show me a water tracker", [], deps);
    expect(turn.kind).toBe("act");
  });
});

// ── briefing fast path ────────────────────────────────────────────────────────

describe("handle — briefing routes without model call", () => {
  it("'brief me' with salient items returns briefing turn kind, no model call", async () => {
    const deps = makeDeps({
      getSalient: (k: number) => ([
        { id: "e1", title: "Major quake in Japan", source: "USGS", category: "quake", publishedAt: new Date().toISOString(), score: 0.9, reasons: ["M7.2 near Tokyo"] },
        { id: "e2", title: "Oil reaches $100", source: "Reuters", category: "markets", publishedAt: new Date().toISOString(), score: 0.8, reasons: [] },
      ] as ScoredEvent[]).slice(0, k),
    });
    const turn = await handle("brief me", [], deps);
    expect(turn.kind).toBe("briefing");
    expect(deps.chat).not.toHaveBeenCalled();
    expect(deps.askModel).not.toHaveBeenCalled();
  });

  it("briefing text includes title and first reason", async () => {
    const deps = makeDeps({
      getSalient: (_k: number) => [
        { id: "e1", title: "Quake in Japan", source: "USGS", category: "quake", publishedAt: new Date().toISOString(), score: 0.9, reasons: ["M7.2 near Tokyo"] },
      ] as ScoredEvent[],
    });
    const turn = await handle("brief me", [], deps);
    if (turn.kind !== "briefing") throw new Error("Expected briefing");
    expect(turn.text).toContain("Quake in Japan");
    expect(turn.text).toContain("M7.2 near Tokyo");
    expect(turn.text).toMatch(/^Top of the watch:/);
  });

  it("briefing with item with no reasons omits dash-reason", async () => {
    const deps = makeDeps({
      getSalient: (_k: number) => [
        { id: "e1", title: "Oil reaches $100", source: "Reuters", category: "markets", publishedAt: new Date().toISOString(), score: 0.8, reasons: [] },
      ] as ScoredEvent[],
    });
    const turn = await handle("brief me", [], deps);
    if (turn.kind !== "briefing") throw new Error("Expected briefing");
    expect(turn.text).toContain("Oil reaches $100");
    expect(turn.text).not.toContain(" — ");
  });

  it("empty watch returns quiet message", async () => {
    const deps = makeDeps({ getSalient: () => [] });
    const turn = await handle("brief me", [], deps);
    if (turn.kind !== "briefing") throw new Error("Expected briefing");
    expect(turn.text).toBe("The watch is quiet. Nothing crosses your thresholds.");
  });

  it("briefing without getSalient dep returns quiet message", async () => {
    const deps = makeDeps(); // no getSalient
    const turn = await handle("brief me", [], deps);
    if (turn.kind !== "briefing") throw new Error("Expected briefing");
    expect(turn.text).toBe("The watch is quiet. Nothing crosses your thresholds.");
  });
});

// ── briefing fly_to ───────────────────────────────────────────────────────────

describe("handle — briefing fly_to steering", () => {
  const tokyoEvent: ScoredEvent = {
    id: "e-tokyo",
    title: "Earthquake near Tokyo",
    source: "USGS",
    category: "seismic",
    publishedAt: new Date().toISOString(),
    score: 0.95,
    reasons: ["M6.8"],
    lat: 35.68,
    lng: 139.69,
  };

  it("fires fly_to when globe active and top item has coords", async () => {
    const mockSendDeckCommands = vi.fn();
    const deps = makeDeps({
      currentDeck: () => "globe",
      getSalient: (_k: number) => [tokyoEvent],
      sendDeckCommands: mockSendDeckCommands,
    });
    await handle("brief me", [], deps);
    expect(mockSendDeckCommands).toHaveBeenCalledWith([
      { type: "fly_to", lat: 35.68, lng: 139.69 },
    ]);
  });

  it("skips fly_to when globe NOT active", async () => {
    const mockSendDeckCommands = vi.fn();
    const deps = makeDeps({
      currentDeck: () => "void",
      getSalient: (_k: number) => [tokyoEvent],
      sendDeckCommands: mockSendDeckCommands,
    });
    await handle("brief me", [], deps);
    expect(mockSendDeckCommands).not.toHaveBeenCalled();
  });

  it("skips fly_to when no item has coords", async () => {
    const mockSendDeckCommands = vi.fn();
    const deps = makeDeps({
      currentDeck: () => "globe",
      getSalient: (_k: number) => [
        { id: "e1", title: "Market news", source: "Reuters", category: "finance", publishedAt: new Date().toISOString(), score: 0.8, reasons: [] },
      ],
      sendDeckCommands: mockSendDeckCommands,
    });
    await handle("brief me", [], deps);
    expect(mockSendDeckCommands).not.toHaveBeenCalled();
  });

  it("uses first located item coords even if not the highest scored", async () => {
    const mockSendDeckCommands = vi.fn();
    const noCoords: ScoredEvent = { id: "e-nc", title: "No coords", source: "Reuters", category: "finance", publishedAt: new Date().toISOString(), score: 1.0, reasons: [] };
    const withCoords: ScoredEvent = { ...tokyoEvent, id: "e-c", score: 0.7 };
    const deps = makeDeps({
      currentDeck: () => "globe",
      getSalient: (_k: number) => [noCoords, withCoords],
      sendDeckCommands: mockSendDeckCommands,
    });
    await handle("brief me", [], deps);
    expect(mockSendDeckCommands).toHaveBeenCalledWith([
      { type: "fly_to", lat: 35.68, lng: 139.69 },
    ]);
  });
});
