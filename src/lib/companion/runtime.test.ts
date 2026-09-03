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
    ...overrides,
  };
}

// ── Existing intents still route correctly ────────────────────────────────────

describe("handle — core intents route", () => {
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

// ── Retired Cockpit turns (Rebirth) ──────────────────────────────────────────

describe("handle — retired deck and briefing phrases go to the companion", () => {
  it("'show the globe' becomes a plain companion reply", async () => {
    const deps = makeDeps({ chat: vi.fn().mockResolvedValue("There is no globe here.") });
    const turn = await handle("show the globe", [], deps);
    expect(turn.kind).toBe("reply");
    expect(deps.chat).toHaveBeenCalled();
  });

  it("'brief me' becomes a plain companion reply", async () => {
    const deps = makeDeps();
    const turn = await handle("brief me", [], deps);
    expect(turn.kind).toBe("reply");
  });
});

// ── help fast path — voice discoverability from the shuttle catalog ───────────

describe("handle — help routes without model call", () => {
  it("'what can you do' returns help turn kind, no chat/askModel call", async () => {
    const deps = makeDeps();
    const turn = await handle("what can you do", [], deps);
    expect(turn.kind).toBe("help");
    expect(deps.chat).not.toHaveBeenCalled();
    expect(deps.askModel).not.toHaveBeenCalled();
  });

  it("'help' speaks group names with catalog examples", async () => {
    const deps = makeDeps();
    const turn = await handle("help", [], deps);
    if (turn.kind !== "help") throw new Error("Expected help");
    expect(turn.text.toLowerCase()).toContain("build");
    expect(turn.text.toLowerCase()).toContain("system");
    expect(turn.text).toContain('"build me a …"');
    expect(turn.text).toContain('"what can you do"');
    expect(turn.text.toLowerCase()).not.toContain("decks");
    expect(turn.text).not.toContain('"brief me"');
  });

  it("help includes organ examples when organs exist", async () => {
    const deps = makeDeps({ organIds: vi.fn().mockResolvedValue(["water-tracker"]) });
    const turn = await handle("what can you do", [], deps);
    if (turn.kind !== "help") throw new Error("Expected help");
    expect(turn.text.toLowerCase()).toContain("organs");
    expect(turn.text).toContain('"open water tracker"');
  });

  it("'help me build a tracker' does NOT route to help (build wins)", async () => {
    const deps = makeDeps();
    const turn = await handle("help me build a tracker", [], deps);
    expect(turn.kind).toBe("build");
  });
});

// ── self_edit fast path (Phase 21 — LOOM editing its own kernel) ─────────────

describe("handle — self_edit routes without model call, without build/edit", () => {
  it("'change yourself …' returns a self_edit turn carrying the request", async () => {
    const deps = makeDeps();
    const turn = await handle("change yourself so the orb is brighter", [], deps);
    expect(turn.kind).toBe("self_edit");
    if (turn.kind !== "self_edit") throw new Error("expected self_edit");
    expect(turn.request).toMatch(/orb is brighter/i);
    // The runtime never triggers an organ build/edit for a self-edit.
    expect(deps.build).not.toHaveBeenCalled();
    expect(deps.edit).not.toHaveBeenCalled();
    // No model call — the pipeline (in Companion) does the drafting.
    expect(deps.chat).not.toHaveBeenCalled();
    expect(deps.askModel).not.toHaveBeenCalled();
  });

  it("'edit your <x>' never routes to an organ edit", async () => {
    const deps = makeDeps({ organIds: vi.fn().mockResolvedValue(["orb"]) });
    const turn = await handle("edit your orb moods", [], deps);
    expect(turn.kind).toBe("self_edit");
    expect(deps.edit).not.toHaveBeenCalled();
  });
});
