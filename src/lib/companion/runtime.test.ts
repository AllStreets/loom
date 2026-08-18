import { describe, it, expect, vi } from "vitest";
import { handle, type CompanionDeps } from "./runtime";

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
