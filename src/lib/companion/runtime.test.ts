import { describe, it, expect, vi } from "vitest";
import { handle, type CompanionDeps, type RebirthDeps } from "./runtime";
import type { Identity, ThreadStatus, Generation } from "../core";

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

// ── rebirth handlers (Phase 23) — rules, no model call ───────────────────────

const SHA_A = "3f2a1c3f2a1c3f2a1c3f2a1c3f2a1c3f2a1c3f2a";
const SHA_B = "9b8c7d9b8c7d9b8c7d9b8c7d9b8c7d9b8c7d9b8c";

function identity(over: Partial<Identity> = {}): Identity {
  return {
    mode: "packaged",
    genomeSha: SHA_A,
    generation: SHA_B,
    threaded: true,
    loomhome: "/home/loom",
    ...over,
  };
}

function threadStatus(over: Partial<ThreadStatus> = {}): ThreadStatus {
  return {
    threaded: true,
    tools: [
      { name: "cargo", path: "/usr/bin/cargo", version: "1.80", requiredFor: "core", install: "rustup" },
      { name: "cmake", path: null, version: null, requiredFor: "native deps (whisper.cpp)", install: "brew install cmake" },
    ],
    missing: [],
    drifted: [],
    steps: { seed: true, deps: true, vendor: true, warm: true, register: true },
    needsNetwork: false,
    ...over,
  };
}

function generation(over: Partial<Generation> = {}): Generation {
  return {
    sha: SHA_A,
    wovenAt: "2026-09-02T00:00:00Z",
    sizeBytes: 1,
    reason: "reweave",
    commitSubject: "x",
    isCurrent: true,
    isPrevious: false,
    ...over,
  };
}

function rebirth(over: Partial<RebirthDeps> = {}): RebirthDeps {
  return {
    readiness: vi.fn().mockResolvedValue({ ok: true, generation: SHA_B, genomeSha: SHA_A }),
    commitsAhead: vi.fn().mockResolvedValue(null),
    threadStatus: vi.fn().mockResolvedValue(threadStatus()),
    threadLoom: vi.fn().mockResolvedValue(undefined),
    identity: vi.fn().mockResolvedValue(identity()),
    generations: vi
      .fn()
      .mockResolvedValue([generation(), generation({ sha: SHA_B, isCurrent: false, isPrevious: true })]),
    ...over,
  };
}

describe("handle — reweave", () => {
  it("nothing new → speaks the nothing-new line, never a model call, never starts", async () => {
    const rb = rebirth({
      readiness: vi
        .fn()
        .mockResolvedValue({ ok: false, reason: "nothing new to weave — the body already matches the genome" }),
    });
    const deps = makeDeps({ rebirth: rb });
    const turn = await handle("reweave yourself", [], deps);
    expect(turn).toEqual({
      kind: "reply",
      text: "nothing new to weave — the body already matches the genome",
    });
    expect(deps.chat).not.toHaveBeenCalled();
    expect(deps.askModel).not.toHaveBeenCalled();
  });

  it("ready, commit count unknown → consent turn with the short line", async () => {
    const deps = makeDeps({ rebirth: rebirth() });
    const turn = await handle("become the new version", [], deps);
    expect(turn).toEqual({
      kind: "consent",
      consent: "reweave_consent",
      line: "weave generation 3f2a1c — LOOM will close and return",
    });
  });

  it("ready, commits counted → consent turn names the count", async () => {
    const deps = makeDeps({ rebirth: rebirth({ commitsAhead: vi.fn().mockResolvedValue(4) }) });
    const turn = await handle("rebuild yourself", [], deps);
    expect(turn).toEqual({
      kind: "consent",
      consent: "reweave_consent",
      line: "weave generation 3f2a1c from 4 commits — LOOM will close and return",
    });
  });

  it("one commit reads singular", async () => {
    const deps = makeDeps({ rebirth: rebirth({ commitsAhead: vi.fn().mockResolvedValue(1) }) });
    const turn = await handle("weave the new generation", [], deps);
    expect(turn.kind === "consent" && turn.line).toBe(
      "weave generation 3f2a1c from 1 commit — LOOM will close and return",
    );
  });

  it("unthreaded → the settings line, no consent", async () => {
    const rb = rebirth({
      readiness: vi.fn().mockResolvedValue({ ok: false, reason: "the loom isn't threaded — open Settings" }),
    });
    const turn = await handle("reweave yourself", [], makeDeps({ rebirth: rb }));
    expect(turn).toEqual({ kind: "reply", text: "the loom isn't threaded — open Settings" });
  });
});

describe("handle — thread", () => {
  it("a missing tool → the missing-tools line with the first missing tool's install line, no threadLoom", async () => {
    const rb = rebirth({
      threadStatus: vi
        .fn()
        .mockResolvedValue(threadStatus({ threaded: false, missing: ["cmake"], needsNetwork: true })),
    });
    const turn = await handle("thread the loom", [], makeDeps({ rebirth: rb }));
    expect(turn).toEqual({
      kind: "reply",
      text: "the loom can't be threaded yet — cmake is missing: brew install cmake",
    });
    expect(rb.threadLoom).not.toHaveBeenCalled();
  });

  it("nothing missing → threadLoom() and the honest network line", async () => {
    const rb = rebirth({
      threadStatus: vi.fn().mockResolvedValue(threadStatus({ threaded: false, needsNetwork: true })),
    });
    const turn = await handle("thread the loom", [], makeDeps({ rebirth: rb }));
    expect(rb.threadLoom).toHaveBeenCalledTimes(1);
    expect(turn).toEqual({ kind: "reply", text: "threading the loom — this needs the network once" });
  });
});

describe("handle — identity", () => {
  it("speaks generation · mode · threaded", async () => {
    const turn = await handle("which generation is this", [], makeDeps({ rebirth: rebirth() }));
    expect(turn).toEqual({ kind: "reply", text: "generation 9b8c7d · packaged · threaded" });
  });

  it("no generation yet → unwoven, not threaded", async () => {
    const rb = rebirth({
      identity: vi.fn().mockResolvedValue(identity({ mode: "dev", generation: null, threaded: false })),
    });
    const turn = await handle("what generation are you?", [], makeDeps({ rebirth: rb }));
    expect(turn).toEqual({ kind: "reply", text: "generation unwoven · dev · not threaded" });
  });
});

describe("handle — generation_return", () => {
  it("a previous generation → consent turn carrying its sha", async () => {
    const turn = await handle("return to the previous generation", [], makeDeps({ rebirth: rebirth() }));
    expect(turn).toEqual({
      kind: "consent",
      consent: "generation_return_consent",
      sha: SHA_B,
      line: "return to generation 9b8c7d — LOOM will close and return",
    });
  });

  it("no previous generation → says so", async () => {
    const rb = rebirth({ generations: vi.fn().mockResolvedValue([generation()]) });
    const turn = await handle("go back a generation", [], makeDeps({ rebirth: rb }));
    expect(turn).toEqual({ kind: "reply", text: "there is no previous generation to return to" });
  });
});
