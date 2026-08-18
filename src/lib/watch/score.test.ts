import { describe, it, expect } from "vitest";
import { scoreEvent, buildEngagementMap } from "./score";
import type { WatchEvent } from "./types";
import type { WatchlistEntry } from "./score";

// Helper: expect an array of strings to include a string matching a pattern
function expectReason(reasons: string[], pattern: RegExp | string) {
  expect(reasons).toEqual(
    expect.arrayContaining([
      typeof pattern === "string"
        ? expect.stringContaining(pattern)
        : expect.stringMatching(pattern),
    ])
  );
}

// ── Fixtures ───────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<WatchEvent> = {}): WatchEvent {
  return {
    id: "test:1",
    title: "A test event",
    source: "auspex",
    category: "geo",
    publishedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30 min ago
    ...overrides,
  };
}

// ── Source trust tiers ─────────────────────────────────────────────────────────

describe("score — source trust baseline", () => {
  it("auspex events earn higher base than unknown sources", () => {
    const auspex = scoreEvent(makeEvent({ source: "auspex", category: "geo" }));
    const unknown = scoreEvent(makeEvent({ source: "unknown-source", category: "geo" }));
    expect(auspex.score).toBeGreaterThan(unknown.score);
  });

  it("quakes source earns its own base relevance (0.3)", () => {
    const result = scoreEvent(makeEvent({ source: "quakes", category: "seismic" }));
    expectReason(result.reasons, /base relevance 0\.30/);
  });

  it("unknown source falls back to 0.25 base", () => {
    const result = scoreEvent(makeEvent({ source: "mystery-source", category: "geo" }));
    expectReason(result.reasons, "0.25");
  });
});

// ── Category weights ───────────────────────────────────────────────────────────

describe("score — category weights", () => {
  it("outage category earns a large bonus", () => {
    const outage = scoreEvent(makeEvent({ source: "auspex", category: "outage" }));
    const geo = scoreEvent(makeEvent({ source: "auspex", category: "geo" }));
    expect(outage.score).toBeGreaterThan(geo.score);
    expectReason(outage.reasons, /category "outage" \+0\.40/);
  });

  it("seismic-major earns more than seismic", () => {
    const major = scoreEvent(makeEvent({ source: "quakes", category: "seismic-major" }));
    const minor = scoreEvent(makeEvent({ source: "quakes", category: "seismic" }));
    expect(major.score).toBeGreaterThan(minor.score);
  });

  it("unknown category does not add a category bonus", () => {
    const result = scoreEvent(makeEvent({ source: "auspex", category: "unicorn" }));
    expect(result.reasons.every((r) => !r.startsWith("category"))).toBe(true);
  });
});

// ── Recency decay curve ────────────────────────────────────────────────────────

describe("score — recency decay", () => {
  const baseEvent = (publishedAt: string) =>
    makeEvent({ source: "auspex", category: "geo", publishedAt });

  it("fresh event (<1h) gets full recency boost 0.25", () => {
    const recent = new Date(Date.now() - 20 * 60 * 1000).toISOString(); // 20 min
    const result = scoreEvent(baseEvent(recent));
    expectReason(result.reasons, /breaking \(<1h\) \+0\.25/);
  });

  it("6h-old event gets 0.10 recency boost (today tier)", () => {
    // 7h falls into the "today" bucket (>=6h, <24h)
    const sixHAgo = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    const result = scoreEvent(baseEvent(sixHAgo));
    expectReason(result.reasons, /today \+0\.10/);
  });

  it("48h-old event gets small boost (this week) 0.04", () => {
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const result = scoreEvent(baseEvent(twoDaysAgo));
    expectReason(result.reasons, /this week \+0\.04/);
  });

  it("week-old event gets no recency boost", () => {
    const weekAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const result = scoreEvent(baseEvent(weekAgo));
    const hasRecency = result.reasons.some(
      (r) => r.includes("breaking") || r.includes("recent") || r.includes("this week") || r.includes("today")
    );
    expect(hasRecency).toBe(false);
  });

  it("fresh > 6h-old > 48h-old in score (recency hierarchy)", () => {
    const fresh = scoreEvent(baseEvent(new Date(Date.now() - 10 * 60 * 1000).toISOString()));
    const sixH = scoreEvent(baseEvent(new Date(Date.now() - 7 * 3600 * 1000).toISOString()));
    const twoDays = scoreEvent(baseEvent(new Date(Date.now() - 48 * 3600 * 1000).toISOString()));
    expect(fresh.score).toBeGreaterThan(sixH.score);
    expect(sixH.score).toBeGreaterThan(twoDays.score);
  });
});

// ── Watchlist matches with reasons ────────────────────────────────────────────

describe("score — watchlist matches", () => {
  it("topic match in title adds a reason", () => {
    const watchlist: WatchlistEntry[] = [{ kind: "topic", value: "earthquake" }];
    const result = scoreEvent(
      makeEvent({ title: "Major earthquake in Pacific Rim" }),
      watchlist
    );
    expectReason(result.reasons, /watchlist "earthquake"/);
  });

  it("entity match in summary adds a reason", () => {
    const watchlist: WatchlistEntry[] = [{ kind: "entity", value: "NASA" }];
    const result = scoreEvent(
      makeEvent({ title: "Space news", summary: "NASA launches new mission" }),
      watchlist
    );
    expectReason(result.reasons, /watchlist "NASA"/i);
  });

  it("place match searches title/summary", () => {
    const watchlist: WatchlistEntry[] = [{ kind: "place", value: "Tokyo" }];
    const result = scoreEvent(
      makeEvent({ title: "Typhoon hits Tokyo" }),
      watchlist
    );
    expectReason(result.reasons, /watchlist "Tokyo"/i);
  });

  it("source match by source field", () => {
    const watchlist: WatchlistEntry[] = [{ kind: "source", value: "auspex" }];
    const result = scoreEvent(makeEvent({ source: "auspex" }), watchlist);
    expectReason(result.reasons, /watchlist "auspex"/);
  });

  it("source match by category field", () => {
    const watchlist: WatchlistEntry[] = [{ kind: "source", value: "geo" }];
    const result = scoreEvent(makeEvent({ source: "auspex", category: "geo" }), watchlist);
    expectReason(result.reasons, /watchlist "geo"/);
  });

  it("no match → no watchlist reason", () => {
    const watchlist: WatchlistEntry[] = [{ kind: "topic", value: "ZZZNOTPRESENT" }];
    const result = scoreEvent(makeEvent({ title: "Routine geopolitics" }), watchlist);
    expect(result.reasons.every((r) => !r.includes("watchlist"))).toBe(true);
  });

  it("multiple watchlist hits add count reason", () => {
    const watchlist: WatchlistEntry[] = [
      { kind: "topic", value: "climate" },
      { kind: "topic", value: "flood" },
    ];
    const result = scoreEvent(
      makeEvent({ title: "Climate flood disaster", category: "flood" }),
      watchlist
    );
    expectReason(result.reasons, /\d+ watchlist hits/);
  });
});

// ── Engagement boost and suppression ─────────────────────────────────────────

describe("score — engagement signals", () => {
  it("positive engagement boosts score", () => {
    // Enough signals for buildEngagementMap to register (needs >= 3)
    const eventsData = Array.from({ length: 6 }, (_, i) => ({
      id: `auspex:evt${i}`,
      title: "x",
      source: "auspex",
      category: "geo",
      publishedAt: new Date().toISOString(),
    }));
    const signals = eventsData.slice(0, 5).map((e) => ({
      eventKey: e.id, action: "act" as const, ts: Date.now(),
    }));
    signals.push({ eventKey: eventsData[5].id, action: "dismiss", ts: Date.now() });
    const engagement = buildEngagementMap(signals, eventsData);
    // Should have positive signal for source:auspex
    const result = scoreEvent(makeEvent({ source: "auspex" }), [], engagement);
    expectReason(result.reasons, /you usually act on auspex/);
  });

  it("negative engagement suppresses score", () => {
    const eventsData = Array.from({ length: 9 }, (_, i) => ({
      id: `auspex:evt${i}`,
      title: "x",
      source: "auspex",
      category: "geo",
      publishedAt: new Date().toISOString(),
    }));
    const signals = eventsData.slice(0, 8).map((e) => ({
      eventKey: e.id, action: "dismiss" as const, ts: Date.now(),
    }));
    signals.push({ eventKey: eventsData[8].id, action: "act", ts: Date.now() });
    const engagement = buildEngagementMap(signals, eventsData);
    const baseScore = scoreEvent(makeEvent({ source: "auspex" }), [], {}).score;
    const suppressedScore = scoreEvent(makeEvent({ source: "auspex" }), [], engagement).score;
    expect(suppressedScore).toBeLessThan(baseScore);
    expectReason(
      scoreEvent(makeEvent({ source: "auspex" }), [], engagement).reasons,
      /you usually dismiss/
    );
  });

  it("low signal count (<3) does not influence score", () => {
    const eventsData = [
      { id: "auspex:evt1", title: "x", source: "auspex", category: "geo", publishedAt: new Date().toISOString() },
    ];
    const signals = [{ eventKey: "auspex:evt1", action: "act" as const, ts: Date.now() }];
    const engagement = buildEngagementMap(signals, eventsData);
    // Not enough evidence — engagement map should be empty
    expect(Object.keys(engagement)).toHaveLength(0);
  });
});

// ── Determinism ───────────────────────────────────────────────────────────────

describe("score — determinism", () => {
  it("same input always produces same output", () => {
    const event = makeEvent({ publishedAt: "2026-08-18T10:00:00Z" });
    const watchlist: WatchlistEntry[] = [{ kind: "topic", value: "test" }];
    const engagement = { "source:auspex": 0.5 };

    const r1 = scoreEvent(event, watchlist, engagement);
    const r2 = scoreEvent(event, watchlist, engagement);

    expect(r1.score).toBe(r2.score);
    expect(r1.reasons).toEqual(r2.reasons);
  });
});

// ── Reasons non-empty and human-readable ──────────────────────────────────────

describe("score — reasons format", () => {
  it("reasons array is always non-empty", () => {
    const result = scoreEvent(makeEvent());
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("each reason is a non-empty string", () => {
    const result = scoreEvent(makeEvent({ category: "geo" }));
    for (const r of result.reasons) {
      expect(typeof r).toBe("string");
      expect(r.trim().length).toBeGreaterThan(0);
    }
  });

  it("score is clamped to [0, 1]", () => {
    // Pile on many watchlist matches to try to exceed 1
    const watchlist: WatchlistEntry[] = Array.from({ length: 20 }, (_, i) => ({
      kind: "topic" as const,
      value: `keyword${i}`,
    }));
    const title = Array.from({ length: 20 }, (_, i) => `keyword${i}`).join(" ");
    const result = scoreEvent(makeEvent({ title }), watchlist);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });
});

// ── Magnitude intrinsic importance ────────────────────────────────────────────

describe("score — magnitude bump", () => {
  it("high magnitude event scores above low magnitude event", () => {
    const high = scoreEvent(
      makeEvent({ source: "quakes", category: "seismic-major", magnitude: 7.8 })
    );
    const low = scoreEvent(
      makeEvent({ source: "quakes", category: "seismic", magnitude: 4.6 })
    );
    expect(high.score).toBeGreaterThan(low.score);
  });

  it("magnitude reason is human-readable", () => {
    const result = scoreEvent(
      makeEvent({ source: "quakes", category: "seismic-major", magnitude: 7.2 })
    );
    expectReason(result.reasons, /M7\.2 magnitude \+/);
  });
});
