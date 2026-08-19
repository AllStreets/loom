import { describe, it, expect } from "vitest";
import { tokenize, computeWeights } from "./learned";
import { learnedBoost, scoreEvent } from "./score";
import type { WatchEvent } from "./types";

// ── tokenize ──────────────────────────────────────────────────────────────────

describe("tokenize", () => {
  it("lowercases and filters stopwords", () => {
    const tokens = tokenize("The New York earthquake");
    // "the", "new" are stopwords; "york" and "earthquake" should survive
    expect(tokens).not.toContain("the");
    expect(tokens).not.toContain("new");
    expect(tokens).toContain("york");
    expect(tokens).toContain("earthquake");
  });

  it("filters tokens shorter than 3 characters", () => {
    const tokens = tokenize("an ox ate hay");
    // "an" is a stopword, "ox" is 2 chars (filtered), "ate" is ok, "hay" is ok
    expect(tokens).not.toContain("an");
    expect(tokens).not.toContain("ox");
    expect(tokens).toContain("ate");
    expect(tokens).toContain("hay");
  });

  it("strips punctuation", () => {
    const tokens = tokenize("Breaking: volcano erupts!");
    expect(tokens).toContain("breaking");
    expect(tokens).toContain("volcano");
    expect(tokens).toContain("erupts");
    // No punctuation characters
    for (const t of tokens) {
      expect(t).toMatch(/^[a-z0-9]+$/);
    }
  });

  it("caps at maxTokens param", () => {
    const tokens = tokenize("alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu", 5);
    expect(tokens.length).toBeLessThanOrEqual(5);
  });

  it("defaults to cap of 10", () => {
    const manyWords = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ");
    const tokens = tokenize(manyWords);
    expect(tokens.length).toBeLessThanOrEqual(10);
  });

  it("returns empty array for empty string", () => {
    expect(tokenize("")).toEqual([]);
  });

  it("returns empty array for string with only stopwords", () => {
    const tokens = tokenize("the and or but");
    expect(tokens).toEqual([]);
  });

  it("handles numbers as tokens", () => {
    const tokens = tokenize("M6.5 earthquake detected near 123 island");
    // Numbers >= 3 chars should survive (e.g. "123")
    expect(tokens).toContain("123");
  });
});

// ── computeWeights — basic math ───────────────────────────────────────────────

describe("computeWeights — weight math per action", () => {
  it("open signal adds +0.05 to category, source, and tokens", () => {
    const weights = computeWeights([
      { action: "open", category: "geo", source: "auspex", titleTokens: ["volcano"] },
    ]);
    expect(weights.category["geo"]).toBeCloseTo(0.05);
    expect(weights.source["auspex"]).toBeCloseTo(0.05);
    expect(weights.token["volcano"]).toBeCloseTo(0.05);
  });

  it("act signal adds +0.10 to category, source, and tokens", () => {
    const weights = computeWeights([
      { action: "act", category: "finance", source: "world", titleTokens: ["bitcoin"] },
    ]);
    expect(weights.category["finance"]).toBeCloseTo(0.10);
    expect(weights.source["world"]).toBeCloseTo(0.10);
    expect(weights.token["bitcoin"]).toBeCloseTo(0.10);
  });

  it("dismiss signal subtracts -0.08 from category, source, and tokens", () => {
    const weights = computeWeights([
      { action: "dismiss", category: "military", source: "quakes", titleTokens: ["war"] },
    ]);
    expect(weights.category["military"]).toBeCloseTo(-0.08);
    expect(weights.source["quakes"]).toBeCloseTo(-0.08);
    expect(weights.token["war"]).toBeCloseTo(-0.08);
  });
});

// ── computeWeights — accumulation ────────────────────────────────────────────

describe("computeWeights — accumulation across multiple signals", () => {
  it("accumulates category weights across signals", () => {
    const weights = computeWeights([
      { action: "open", category: "geo", source: "auspex", titleTokens: [] },
      { action: "act", category: "geo", source: "auspex", titleTokens: [] },
    ]);
    // 0.05 + 0.10 = 0.15
    expect(weights.category["geo"]).toBeCloseTo(0.15);
  });

  it("accumulates source weights across signals", () => {
    const weights = computeWeights([
      { action: "open", category: "geo", source: "auspex", titleTokens: [] },
      { action: "open", category: "geo", source: "auspex", titleTokens: [] },
      { action: "open", category: "geo", source: "auspex", titleTokens: [] },
    ]);
    // 3 × 0.05 = 0.15
    expect(weights.source["auspex"]).toBeCloseTo(0.15);
  });

  it("accumulates token weights across signals", () => {
    const weights = computeWeights([
      { action: "act", category: "geo", source: "auspex", titleTokens: ["earthquake"] },
      { action: "act", category: "geo", source: "auspex", titleTokens: ["earthquake"] },
    ]);
    // 2 × 0.10 = 0.20
    expect(weights.token["earthquake"]).toBeCloseTo(0.20);
  });

  it("positive and negative signals on same key partially cancel", () => {
    const weights = computeWeights([
      { action: "act", category: "geo", source: "auspex", titleTokens: [] },    // +0.10
      { action: "dismiss", category: "geo", source: "auspex", titleTokens: [] }, // -0.08
    ]);
    // 0.10 - 0.08 = 0.02
    expect(weights.category["geo"]).toBeCloseTo(0.02);
  });

  it("independent features accumulate independently", () => {
    const weights = computeWeights([
      { action: "act", category: "geo", source: "auspex", titleTokens: ["flood"] },
      { action: "dismiss", category: "finance", source: "world", titleTokens: ["bond"] },
    ]);
    expect(weights.category["geo"]).toBeCloseTo(0.10);
    expect(weights.category["finance"]).toBeCloseTo(-0.08);
    expect(weights.source["auspex"]).toBeCloseTo(0.10);
    expect(weights.source["world"]).toBeCloseTo(-0.08);
    expect(weights.token["flood"]).toBeCloseTo(0.10);
    expect(weights.token["bond"]).toBeCloseTo(-0.08);
  });
});

// ── computeWeights — clamping ─────────────────────────────────────────────────

describe("computeWeights — clamping to [-0.5, +0.5]", () => {
  it("clamps positive weights at +0.5", () => {
    // 6 × act = 6 × 0.10 = 0.60, should clamp to 0.5
    const signals = Array.from({ length: 6 }, () => ({
      action: "act" as const,
      category: "outage",
      source: "auspex",
      titleTokens: ["crisis"],
    }));
    const weights = computeWeights(signals);
    expect(weights.category["outage"]).toBeLessThanOrEqual(0.5);
    expect(weights.source["auspex"]).toBeLessThanOrEqual(0.5);
    expect(weights.token["crisis"]).toBeLessThanOrEqual(0.5);
  });

  it("clamps negative weights at -0.5", () => {
    // 7 × dismiss = 7 × -0.08 = -0.56, should clamp to -0.5
    const signals = Array.from({ length: 7 }, () => ({
      action: "dismiss" as const,
      category: "spam",
      source: "junk",
      titleTokens: ["garbage"],
    }));
    const weights = computeWeights(signals);
    expect(weights.category["spam"]).toBeGreaterThanOrEqual(-0.5);
    expect(weights.source["junk"]).toBeGreaterThanOrEqual(-0.5);
    expect(weights.token["garbage"]).toBeGreaterThanOrEqual(-0.5);
  });

  it("clamped weight is exactly ±0.5 at boundary", () => {
    // Many act signals — clamp should hit exactly 0.5
    const signals = Array.from({ length: 20 }, () => ({
      action: "act" as const,
      category: "test",
      source: "src",
      titleTokens: [],
    }));
    const weights = computeWeights(signals);
    expect(weights.category["test"]).toBe(0.5);
    expect(weights.source["src"]).toBe(0.5);
  });
});

// ── computeWeights — token table cap ─────────────────────────────────────────

describe("computeWeights — token table cap at 200", () => {
  it("caps token table at 200 entries, keeping highest |weight|", () => {
    // Create 201 distinct tokens: first one has higher weight (2 acts = 0.20),
    // rest have lower weight (1 act = 0.10)
    const highWeightToken = "supertoken";
    const signals = [
      { action: "act" as const, category: "geo", source: "auspex", titleTokens: [highWeightToken] },
      { action: "act" as const, category: "geo", source: "auspex", titleTokens: [highWeightToken] },
    ];
    // Add 200 more signals with unique tokens (weight 0.10 each)
    for (let i = 0; i < 200; i++) {
      signals.push({
        action: "act" as const,
        category: "geo",
        source: "auspex",
        titleTokens: [`token${i}`],
      });
    }
    const weights = computeWeights(signals);
    const tokenCount = Object.keys(weights.token).length;
    expect(tokenCount).toBe(200);
    // High-weight token should be retained
    expect(weights.token[highWeightToken]).toBeDefined();
    expect(weights.token[highWeightToken]).toBeCloseTo(0.20);
  });

  it("under 200 tokens: no trimming", () => {
    const signals = Array.from({ length: 5 }, (_, i) => ({
      action: "act" as const,
      category: "geo",
      source: "auspex",
      titleTokens: [`word${i}`],
    }));
    const weights = computeWeights(signals);
    expect(Object.keys(weights.token).length).toBe(5);
  });
});

// ── computeWeights — old format migration safety ──────────────────────────────

describe("computeWeights — migration safety", () => {
  it("skips signals without any features", () => {
    const weights = computeWeights([
      { action: "act" } as { action: "act"; category?: string; source?: string; titleTokens?: string[] },
    ]);
    expect(Object.keys(weights.category)).toHaveLength(0);
    expect(Object.keys(weights.source)).toHaveLength(0);
    expect(Object.keys(weights.token)).toHaveLength(0);
  });

  it("skips signals with only an empty titleTokens array", () => {
    const weights = computeWeights([
      { action: "open", titleTokens: [] },
    ]);
    expect(Object.keys(weights.category)).toHaveLength(0);
    expect(Object.keys(weights.source)).toHaveLength(0);
    expect(Object.keys(weights.token)).toHaveLength(0);
  });

  it("processes signals with features even if some fields missing", () => {
    const weights = computeWeights([
      { action: "act", category: "geo" }, // no source or titleTokens
    ]);
    expect(weights.category["geo"]).toBeCloseTo(0.10);
    expect(Object.keys(weights.source)).toHaveLength(0);
    expect(Object.keys(weights.token)).toHaveLength(0);
  });

  it("mixes old-format and new-format signals gracefully", () => {
    const weights = computeWeights([
      { action: "act" } as { action: "act"; category?: string; source?: string; titleTokens?: string[] }, // old — no features
      { action: "act", category: "geo", source: "auspex", titleTokens: ["flood"] }, // new
    ]);
    // Only new-format signal contributes
    expect(weights.category["geo"]).toBeCloseTo(0.10);
    expect(weights.source["auspex"]).toBeCloseTo(0.10);
    expect(weights.token["flood"]).toBeCloseTo(0.10);
  });
});

// ── computeWeights — determinism ─────────────────────────────────────────────

describe("computeWeights — determinism", () => {
  it("same signals same order → same weights", () => {
    const signals = [
      { action: "act" as const, category: "geo", source: "auspex", titleTokens: ["flood"] },
      { action: "dismiss" as const, category: "military", source: "world", titleTokens: ["war"] },
      { action: "open" as const, category: "finance", source: "auspex", titleTokens: ["bond"] },
    ];
    const w1 = computeWeights(signals);
    const w2 = computeWeights(signals);
    expect(w1).toEqual(w2);
  });
});

// ── computeWeights — empty signals ────────────────────────────────────────────

describe("computeWeights — empty signals", () => {
  it("returns all empty tables for empty signals array", () => {
    const weights = computeWeights([]);
    expect(weights.category).toEqual({});
    expect(weights.source).toEqual({});
    expect(weights.token).toEqual({});
  });
});

// ── learnedBoost ──────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<WatchEvent> = {}): WatchEvent {
  return {
    id: "test:1",
    title: "A test event",
    source: "auspex",
    category: "geo",
    publishedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

describe("learnedBoost", () => {
  it("emits positive reason when category |w| >= 0.02", () => {
    const weights = { category: { geo: 0.10 }, source: {}, token: {} };
    const { boost, reasons } = learnedBoost(makeEvent({ category: "geo" }), weights);
    expect(boost).toBeCloseTo(0.10);
    expect(reasons.some((r) => r.includes("learned"))).toBe(true);
    expect(reasons.some((r) => r.includes("often open"))).toBe(true);
  });

  it("emits negative reason when category w is below -0.02", () => {
    const weights = { category: { military: -0.08 }, source: {}, token: {} };
    const { boost, reasons } = learnedBoost(makeEvent({ category: "military" }), weights);
    expect(boost).toBeCloseTo(-0.08);
    expect(reasons.some((r) => r.includes("tend to dismiss"))).toBe(true);
  });

  it("emits source reason when |w| >= 0.02 (positive)", () => {
    const weights = { category: {}, source: { auspex: 0.15 }, token: {} };
    const { boost, reasons } = learnedBoost(makeEvent({ source: "auspex" }), weights);
    expect(boost).toBeCloseTo(0.15);
    expect(reasons.some((r) => r.includes("favor") && r.includes("auspex"))).toBe(true);
  });

  it("emits source reason when w is negative", () => {
    const weights = { category: {}, source: { quakes: -0.08 }, token: {} };
    const { boost, reasons } = learnedBoost(makeEvent({ source: "quakes" }), weights);
    expect(boost).toBeCloseTo(-0.08);
    expect(reasons.some((r) => r.includes("avoid") && r.includes("quakes"))).toBe(true);
  });

  it("no reason emitted when |w| < 0.02 (w = 0.01)", () => {
    const weights = { category: { geo: 0.01 }, source: { auspex: 0.01 }, token: {} };
    const { boost, reasons } = learnedBoost(makeEvent(), weights);
    expect(boost).toBeCloseTo(0);
    expect(reasons).toHaveLength(0);
  });

  it("no reason emitted when w = 0", () => {
    const weights = { category: {}, source: {}, token: {} };
    const { boost, reasons } = learnedBoost(makeEvent(), weights);
    expect(boost).toBe(0);
    expect(reasons).toHaveLength(0);
  });

  it("caps token reasons at top 3 by |weight|", () => {
    // Create 4 matching tokens with different weights
    const event = makeEvent({ title: "earthquake volcano flood missile" });
    const weights = {
      category: {},
      source: {},
      token: {
        earthquake: 0.40,  // highest
        volcano: 0.30,     // second
        flood: 0.20,       // third
        missile: 0.10,     // fourth — should be excluded
      },
    };
    const { reasons } = learnedBoost(event, weights);
    // Count token reasons (those with quotes)
    const tokenReasons = reasons.filter((r) => r.includes('"'));
    expect(tokenReasons.length).toBeLessThanOrEqual(3);
    // Top 3 should be present
    expect(reasons.some((r) => r.includes('"earthquake"'))).toBe(true);
    expect(reasons.some((r) => r.includes('"volcano"'))).toBe(true);
    expect(reasons.some((r) => r.includes('"flood"'))).toBe(true);
    // 4th should be excluded
    expect(reasons.some((r) => r.includes('"missile"'))).toBe(false);
  });

  it("token reason uses 'draws you' for positive weights", () => {
    const event = makeEvent({ title: "big earthquake disaster" });
    const weights = {
      category: {},
      source: {},
      token: { earthquake: 0.20 },
    };
    const { reasons } = learnedBoost(event, weights);
    expect(reasons.some((r) => r.includes("draws you"))).toBe(true);
  });

  it("token reason uses 'you avoid' for negative weights", () => {
    const event = makeEvent({ title: "celebrity gossip scandal" });
    const weights = {
      category: {},
      source: {},
      token: { celebrity: -0.10, gossip: -0.10, scandal: -0.10 },
    };
    const { reasons } = learnedBoost(event, weights);
    expect(reasons.some((r) => r.includes("you avoid"))).toBe(true);
  });

  it("tokens not in title are not boosted", () => {
    // Title has "earthquake" but weights has "celebrity"
    const event = makeEvent({ title: "big earthquake" });
    const weights = {
      category: {},
      source: {},
      token: { celebrity: 0.40 },
    };
    const { boost, reasons } = learnedBoost(event, weights);
    expect(boost).toBeCloseTo(0);
    expect(reasons).toHaveLength(0);
  });
});

// ── Integration: scoreEvent with learnedWeights ───────────────────────────────

describe("scoreEvent + learnedWeights integration", () => {
  const fixedDate = "2026-06-19T10:00:00Z";

  it("event matching learned-positive category scores higher than identical event without weights", () => {
    const event = makeEvent({ category: "geo", publishedAt: fixedDate });
    const withWeights = scoreEvent(event, [], {}, {
      category: { geo: 0.20 },
      source: {},
      token: {},
    });
    const withoutWeights = scoreEvent(event, [], {});
    expect(withWeights.score).toBeGreaterThan(withoutWeights.score);
  });

  it("learned reasons appear in scoreEvent result", () => {
    const event = makeEvent({ category: "geo", publishedAt: fixedDate });
    const result = scoreEvent(event, [], {}, {
      category: { geo: 0.20 },
      source: {},
      token: {},
    });
    expect(result.reasons.some((r) => r.includes("learned"))).toBe(true);
  });

  it("no learned reasons when learnedWeights not provided", () => {
    const event = makeEvent({ publishedAt: fixedDate });
    const result = scoreEvent(event, [], {});
    expect(result.reasons.every((r) => !r.includes("learned"))).toBe(true);
  });

  it("score stays clamped to [0, 1] even with large learned boosts", () => {
    const event = makeEvent({ title: "earthquake flood volcano disaster", publishedAt: fixedDate });
    const result = scoreEvent(event, [], {}, {
      category: { geo: 0.5 },
      source: { auspex: 0.5 },
      token: { earthquake: 0.5, flood: 0.5, volcano: 0.5, disaster: 0.5 },
    });
    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  it("negative learned weights can lower score below baseline", () => {
    const event = makeEvent({ category: "geo", publishedAt: fixedDate });
    const baseline = scoreEvent(event, [], {});
    const withNegative = scoreEvent(event, [], {}, {
      category: { geo: -0.5 },
      source: { auspex: -0.5 },
      token: {},
    });
    expect(withNegative.score).toBeLessThan(baseline.score);
  });
});
