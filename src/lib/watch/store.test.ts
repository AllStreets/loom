import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getWatchlist,
  addWatchlistEntry,
  removeWatchlistEntry,
  clearWatchlist,
  recordEngagement,
  getSignals,
  engagementMap,
} from "./store";
import type { WatchlistEntry, EngagementSignal } from "./store";

// ── localStorage mock ─────────────────────────────────────────────────────────

// jsdom provides localStorage — we reset it between tests
beforeEach(() => {
  localStorage.clear();
});

// ── Watchlist CRUD ─────────────────────────────────────────────────────────────

describe("store — watchlist", () => {
  it("starts empty", () => {
    expect(getWatchlist()).toEqual([]);
  });

  it("addWatchlistEntry adds an entry", () => {
    addWatchlistEntry({ kind: "topic", value: "climate" });
    expect(getWatchlist()).toHaveLength(1);
    expect(getWatchlist()[0]).toMatchObject({ kind: "topic", value: "climate" });
  });

  it("dedupes entries with same kind+value (case-insensitive)", () => {
    addWatchlistEntry({ kind: "topic", value: "Climate" });
    addWatchlistEntry({ kind: "topic", value: "climate" });
    addWatchlistEntry({ kind: "topic", value: "CLIMATE" });
    expect(getWatchlist()).toHaveLength(1);
  });

  it("different kinds with same value are distinct entries", () => {
    addWatchlistEntry({ kind: "topic", value: "nasa" });
    addWatchlistEntry({ kind: "entity", value: "nasa" });
    expect(getWatchlist()).toHaveLength(2);
  });

  it("removeWatchlistEntry removes a matching entry", () => {
    addWatchlistEntry({ kind: "place", value: "Tokyo" });
    removeWatchlistEntry("place", "Tokyo");
    expect(getWatchlist()).toHaveLength(0);
  });

  it("removeWatchlistEntry is case-insensitive", () => {
    addWatchlistEntry({ kind: "topic", value: "floods" });
    removeWatchlistEntry("topic", "FLOODS");
    expect(getWatchlist()).toHaveLength(0);
  });

  it("removeWatchlistEntry is a no-op for absent entries", () => {
    addWatchlistEntry({ kind: "topic", value: "volcanoes" });
    removeWatchlistEntry("topic", "unicorns");
    expect(getWatchlist()).toHaveLength(1);
  });

  it("clearWatchlist empties the list", () => {
    addWatchlistEntry({ kind: "topic", value: "floods" });
    addWatchlistEntry({ kind: "entity", value: "NASA" });
    clearWatchlist();
    expect(getWatchlist()).toHaveLength(0);
  });

  it("ignores blank values", () => {
    addWatchlistEntry({ kind: "topic", value: "   " });
    expect(getWatchlist()).toHaveLength(0);
  });

  it("caps at 200 entries (drops oldest)", () => {
    for (let i = 0; i < 210; i++) {
      addWatchlistEntry({ kind: "topic", value: `term${i}` });
    }
    expect(getWatchlist().length).toBeLessThanOrEqual(200);
  });
});

// ── Engagement signals ─────────────────────────────────────────────────────────

describe("store — engagement signals", () => {
  it("starts with no signals", () => {
    expect(getSignals()).toHaveLength(0);
  });

  it("records signals and persists them", () => {
    const sig: EngagementSignal = { eventKey: "auspex:1", action: "open", ts: Date.now() };
    recordEngagement(sig);
    expect(getSignals()).toHaveLength(1);
    expect(getSignals()[0]).toMatchObject({ eventKey: "auspex:1", action: "open" });
  });

  it("caps at 500 signals, dropping oldest", () => {
    for (let i = 0; i < 520; i++) {
      recordEngagement({ eventKey: `auspex:${i}`, action: "open", ts: i });
    }
    const signals = getSignals();
    expect(signals.length).toBeLessThanOrEqual(500);
    // Oldest should be gone
    const keys = signals.map((s) => s.eventKey);
    expect(keys).not.toContain("auspex:0");
  });

  it("records all three action types", () => {
    recordEngagement({ eventKey: "q:1", action: "open", ts: 1 });
    recordEngagement({ eventKey: "q:2", action: "dismiss", ts: 2 });
    recordEngagement({ eventKey: "q:3", action: "act", ts: 3 });
    const actions = getSignals().map((s) => s.action);
    expect(actions).toContain("open");
    expect(actions).toContain("dismiss");
    expect(actions).toContain("act");
  });
});

// ── engagementMap builder ──────────────────────────────────────────────────────

describe("store — engagementMap", () => {
  it("returns empty map when no signals stored", () => {
    expect(engagementMap()).toEqual({});
  });

  it("returns empty map when fewer than 3 signals for a key", () => {
    recordEngagement({ eventKey: "auspex:1", action: "act", ts: 1 });
    recordEngagement({ eventKey: "auspex:2", action: "act", ts: 2 });
    const map = engagementMap([
      { id: "auspex:1", title: "x", source: "auspex", category: "geo", publishedAt: new Date().toISOString() },
      { id: "auspex:2", title: "x", source: "auspex", category: "geo", publishedAt: new Date().toISOString() },
    ]);
    // Less than 3 evidence — should not influence
    expect(Object.keys(map)).toHaveLength(0);
  });

  it("returns positive engagement after enough positive signals", () => {
    const events = Array.from({ length: 5 }, (_, i) => ({
      id: `auspex:${i}`, title: "x", source: "auspex", category: "geo", publishedAt: new Date().toISOString(),
    }));
    for (const e of events) {
      recordEngagement({ eventKey: e.id, action: "act", ts: Date.now() });
    }
    const map = engagementMap(events);
    expect(map["source:auspex"]).toBeGreaterThan(0);
  });

  it("storage errors are swallowed (survives quota error)", () => {
    // Simulate storage failure by temporarily breaking setItem
    const orig = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => recordEngagement({ eventKey: "x:1", action: "open", ts: 1 })).not.toThrow();
    vi.restoreAllMocks();
  });

  it("64KB byte-guard trims large signals to fit payload", () => {
    // Create a signal with an 80KB eventKey value (simulating large data)
    const largeKey = "x:" + "a".repeat(80 * 1024);
    recordEngagement({ eventKey: largeKey, action: "open", ts: Date.now() });

    // Add more signals to grow the store
    for (let i = 0; i < 10; i++) {
      recordEngagement({ eventKey: `normal:${i}`, action: "act", ts: Date.now() });
    }

    // Retrieve stored data and verify serialized form is under 64KB
    const signals = getSignals();
    const storeData = { watchlist: getWatchlist(), signals };
    const serialised = JSON.stringify(storeData);

    expect(serialised.length).toBeLessThanOrEqual(64 * 1024);
    // Store should still be parseable
    expect(() => JSON.parse(serialised)).not.toThrow();
  });
});
