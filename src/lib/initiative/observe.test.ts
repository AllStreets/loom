import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  emptyLedger,
  foldUsage,
  loadUsage,
  saveUsage,
  mountObserver,
  type UsageLedger,
  type UsageEvent,
} from "./observe";

beforeEach(() => {
  localStorage.clear();
});

// ── emptyLedger ────────────────────────────────────────────────────────────────

describe("emptyLedger", () => {
  it("seeds firstSeenTs and updatedAt to now, everything else zero", () => {
    const now = 1_700_000_000_000;
    const l = emptyLedger(now);
    expect(l.firstSeenTs).toBe(now);
    expect(l.updatedAt).toBe(now);
    expect(l.commands).toEqual({});
    expect(l.morningActivity).toBe(0);
    expect(l.lastMorningDay).toBe("");
  });
});

// ── foldUsage — purity ───────────────────────────────────────────────────────

describe("foldUsage — purity", () => {
  it("is pure — does not mutate the input ledger", () => {
    const l0 = emptyLedger(0);
    const snapshot = JSON.stringify(l0);
    foldUsage(l0, { type: "utterance", text: "build me a thing" }, 5);
    expect(JSON.stringify(l0)).toBe(snapshot);
  });

  it("records updatedAt from the fold time", () => {
    const l1 = foldUsage(emptyLedger(0), { type: "intent", kind: "build", weight: 1 }, 10);
    expect(l1.updatedAt).toBe(10);
    expect(l1.commands.build).toBe(1);
  });
});

// ── foldUsage — utterance intent ─────────────────────────────────────────────

describe("foldUsage — utterance", () => {
  it("classifies a 'brief me' utterance into the brief command bucket", () => {
    let l = emptyLedger(0);
    l = foldUsage(l, { type: "utterance", text: "brief me on the news" }, 1);
    expect(l.commands.brief).toBe(1);
  });

  it("classifies an alert/notify utterance into the alert bucket", () => {
    let l = emptyLedger(0);
    l = foldUsage(l, { type: "utterance", text: "notify me when BTC drops" }, 1);
    expect(l.commands.alert).toBe(1);
  });

  it("classifies a build utterance into the build bucket", () => {
    let l = emptyLedger(0);
    l = foldUsage(l, { type: "utterance", text: "build a stopwatch" }, 1);
    expect(l.commands.build).toBe(1);
  });

  it("classifies an unmatched utterance into the 'other' bucket", () => {
    let l = emptyLedger(0);
    l = foldUsage(l, { type: "utterance", text: "hello there" }, 1);
    expect(l.commands.other).toBe(1);
  });

  it("empty / whitespace utterance is ignored (no bucket bump)", () => {
    let l = emptyLedger(0);
    l = foldUsage(l, { type: "utterance", text: "   " }, 1);
    expect(l.commands).toEqual({});
  });

  it("accumulates across utterances of the same kind", () => {
    let l = emptyLedger(0);
    l = foldUsage(l, { type: "utterance", text: "brief me" }, 1);
    l = foldUsage(l, { type: "utterance", text: "give me a briefing" }, 2);
    expect(l.commands.brief).toBe(2);
  });
});

// ── foldUsage — retired buckets ──────────────────────────────────────────────

describe("foldUsage — retired Cockpit buckets never appear", () => {
  it("news and market phrasings land in 'other', not a retired bucket", () => {
    let l = emptyLedger(0);
    l = foldUsage(l, { type: "utterance", text: "what's in the news" }, 1);
    l = foldUsage(l, { type: "utterance", text: "show me the price of bitcoin" }, 2);
    expect(l.commands.other).toBe(2);
    expect(l.commands.watch).toBeUndefined();
    expect(l.commands.market).toBeUndefined();
  });
});

// ── foldUsage — morning-session detection ────────────────────────────────────

describe("foldUsage — morning session", () => {
  // A local 8am timestamp on 2026-08-23.
  const morning = new Date(2026, 7, 23, 8, 0, 0).getTime();
  const morningNextDay = new Date(2026, 7, 24, 8, 0, 0).getTime();
  const afternoon = new Date(2026, 7, 23, 15, 0, 0).getTime();
  const preDawn = new Date(2026, 7, 23, 4, 0, 0).getTime();

  it("bumps morningActivity once when an event lands in the 5am–11am window", () => {
    let l = emptyLedger(morning - 1000);
    l = foldUsage(l, { type: "deck", deck: "void" }, morning);
    expect(l.morningActivity).toBe(1);
  });

  it("does NOT double-count two morning events on the same calendar day", () => {
    let l = emptyLedger(0);
    l = foldUsage(l, { type: "deck", deck: "void" }, morning);
    l = foldUsage(l, { type: "utterance", text: "brief me" }, morning + 60_000);
    expect(l.morningActivity).toBe(1);
  });

  it("counts a second morning on a new calendar day", () => {
    let l = emptyLedger(0);
    l = foldUsage(l, { type: "deck", deck: "void" }, morning);
    l = foldUsage(l, { type: "deck", deck: "void" }, morningNextDay);
    expect(l.morningActivity).toBe(2);
  });

  it("does not bump for afternoon activity", () => {
    let l = emptyLedger(0);
    l = foldUsage(l, { type: "deck", deck: "void" }, afternoon);
    expect(l.morningActivity).toBe(0);
  });

  it("does not bump for pre-dawn (before 5am) activity", () => {
    let l = emptyLedger(0);
    l = foldUsage(l, { type: "deck", deck: "void" }, preDawn);
    expect(l.morningActivity).toBe(0);
  });
});

// ── caps ─────────────────────────────────────────────────────────────────────

describe("foldUsage — caps", () => {
  it("commands map never exceeds 40 keys (drops smallest-count on overflow)", () => {
    let l = emptyLedger(0);
    for (let i = 0; i < 60; i++) {
      // synthesize distinct 'other'-style buckets by injecting a raw event
      l = foldUsage(l, { type: "intent", kind: `k${i}`, weight: i + 1 }, i + 1);
    }
    expect(Object.keys(l.commands).length).toBeLessThanOrEqual(40);
    // The largest-weight keys should survive; k0 (weight 1) should be evicted.
    expect(l.commands["k0"]).toBeUndefined();
    expect(l.commands["k59"]).toBe(60);
  });
});

// ── load / save ────────────────────────────────────────────────────────────

describe("loadUsage / saveUsage", () => {
  it("round-trips a ledger through localStorage", () => {
    let l = emptyLedger(100);
    l = foldUsage(l, { type: "utterance", text: "build me a thing" }, 200);
    l = foldUsage(l, { type: "intent", kind: "alert", weight: 2 }, 300);
    saveUsage(l);
    const back = loadUsage();
    expect(back.commands.build).toBe(1);
    expect(back.commands.alert).toBe(2);
    expect(back.firstSeenTs).toBe(100);
  });

  it("loadUsage on empty storage returns a fresh ledger", () => {
    const l = loadUsage();
    expect(l.morningActivity).toBe(0);
    expect(l.commands).toEqual({});
  });

  it("loadUsage tolerates corrupt JSON — returns a fresh ledger", () => {
    localStorage.setItem("loom.usage.v1", "{not json");
    const l = loadUsage();
    expect(l.morningActivity).toBe(0);
    expect(l.commands).toEqual({});
  });

  it("loadUsage tolerates a partial object — fills missing fields", () => {
    localStorage.setItem("loom.usage.v1", JSON.stringify({ morningActivity: 3 }));
    const l = loadUsage();
    expect(l.morningActivity).toBe(3);
    expect(l.commands).toEqual({});
    expect(typeof l.firstSeenTs).toBe("number");
  });

  it("loadUsage drops legacy Cockpit fields from a pre-Rebirth ledger", () => {
    localStorage.setItem(
      "loom.usage.v1",
      JSON.stringify({ decks: { globe: { count: 4, lastTs: 1 } }, watchOpens: 9, floorOpens: { "BTC-USD": 3 }, commands: { build: 2 } })
    );
    const l = loadUsage() as unknown as Record<string, unknown>;
    expect(l.decks).toBeUndefined();
    expect(l.watchOpens).toBeUndefined();
    expect(l.floorOpens).toBeUndefined();
    expect((l.commands as Record<string, number>).build).toBe(2);
  });

  it("saveUsage never throws when storage is unavailable", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => saveUsage(emptyLedger(0))).not.toThrow();
    spy.mockRestore();
  });
});

// ── mountObserver ─────────────────────────────────────────────────────────

describe("mountObserver", () => {
  it("folds a loom-utterance event into the persisted ledger", () => {
    const unmount = mountObserver();
    window.dispatchEvent(
      new CustomEvent("loom-utterance", { detail: { text: "brief me", spoken: false } })
    );
    const l = loadUsage();
    expect(l.commands.brief).toBe(1);
    unmount();
  });

  it("ignores the retired Cockpit events entirely", () => {
    const unmount = mountObserver();
    window.dispatchEvent(new CustomEvent("loom-deck", { detail: { deck: "terminal" } }));
    window.dispatchEvent(new CustomEvent("loom-floor-open", { detail: { product: "BTC-USD" } }));
    window.dispatchEvent(
      new CustomEvent("loom-settings-changed", { detail: { key: "cockpit.watchOpen", value: "on" } })
    );
    const l = loadUsage() as unknown as Record<string, unknown>;
    expect(l.decks).toBeUndefined();
    expect(l.floorOpens).toBeUndefined();
    expect(l.watchOpens).toBeUndefined();
    expect(loadUsage().commands).toEqual({});
    unmount();
  });

  it("unmount removes all listeners — later events are ignored", () => {
    const unmount = mountObserver();
    unmount();
    window.dispatchEvent(new CustomEvent("loom-utterance", { detail: { text: "build me a thing" } }));
    expect(loadUsage().commands).toEqual({});
  });

  it("ignores malformed event details without throwing", () => {
    const unmount = mountObserver();
    expect(() => {
      window.dispatchEvent(new CustomEvent("loom-utterance", { detail: null }));
      window.dispatchEvent(new CustomEvent("loom-utterance", { detail: {} }));
    }).not.toThrow();
    unmount();
  });

  it("mountObserver folds a fresh ledger only once per call (idempotent listeners)", () => {
    const u1 = mountObserver();
    window.dispatchEvent(new CustomEvent("loom-utterance", { detail: { text: "build me a thing" } }));
    expect(loadUsage().commands.build).toBe(1);
    u1();
  });
});

// Type-level exercises (compile guards)
const _e: UsageEvent = { type: "intent", kind: "build", weight: 1 };
const _l: UsageLedger = emptyLedger(0);
void _e;
void _l;
