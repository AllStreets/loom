import { describe, it, expect } from "vitest";
import { proposeFromObservation, type ProposeInputs, type Proposal } from "./propose";
import { emptyLedger, foldUsage, type UsageLedger } from "./observe";
import { computeWeights } from "../watch/learned";
import { requestImpliesPowers } from "../loom/prompts";
import type { EngagementSignal } from "../watch/store";

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const NOW = 1_700_000_000_000;

// A base inputs object well past the rate-limit, enabled, nothing installed.
function baseInputs(over: Partial<ProposeInputs> = {}): ProposeInputs {
  return {
    ledger: emptyLedger(NOW - 30 * DAY),
    signals: [],
    weights: computeWeights([]),
    organs: [],
    neverList: [],
    lastProposalTs: NOW - 2 * DAY, // past the 24h rate-limit
    now: NOW,
    enabled: true,
    ...over,
  };
}

// Build a ledger with N watch opens and M brief utterances.
function ledgerWith(opts: {
  watchOpens?: number;
  briefs?: number;
  morningActivity?: number;
  floor?: { product: string; count: number };
}): UsageLedger {
  let l = emptyLedger(NOW - 30 * DAY);
  for (let i = 0; i < (opts.watchOpens ?? 0); i++) l = foldUsage(l, { type: "watch-open" }, NOW - 20 * DAY);
  for (let i = 0; i < (opts.briefs ?? 0); i++) l = foldUsage(l, { type: "utterance", text: "brief me" }, NOW - 20 * DAY);
  if (opts.morningActivity) l = { ...l, morningActivity: opts.morningActivity };
  if (opts.floor) {
    for (let i = 0; i < opts.floor.count; i++) {
      l = foldUsage(l, { type: "floor-open", product: opts.floor.product }, NOW - 20 * DAY);
    }
  }
  return l;
}

function actSignals(category: string, n: number): EngagementSignal[] {
  const out: EngagementSignal[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ eventKey: `${category}-${i}`, action: "act", ts: NOW - 10 * DAY, category });
  }
  return out;
}

// ── The default: silence ─────────────────────────────────────────────────────

describe("proposeFromObservation — silence is the default", () => {
  it("empty ledger → null", () => {
    expect(proposeFromObservation(baseInputs())).toBeNull();
  });

  it("thin evidence (below every gate) → null", () => {
    const inputs = baseInputs({
      ledger: ledgerWith({ watchOpens: 2, briefs: 1, floor: { product: "BTC-USD", count: 2 } }),
      signals: actSignals("science", 2),
      weights: computeWeights(actSignals("science", 2)),
    });
    expect(proposeFromObservation(inputs)).toBeNull();
  });
});

// ── Governance: disabled / rate-limit ────────────────────────────────────────

describe("proposeFromObservation — governance short-circuits", () => {
  const firing = () =>
    baseInputs({ ledger: ledgerWith({ floor: { product: "BTC-USD", count: 5 } }) });

  it("returns null when disabled, even with firing evidence", () => {
    expect(proposeFromObservation({ ...firing(), enabled: false })).toBeNull();
  });

  it("returns null inside the 24h rate-limit window", () => {
    expect(proposeFromObservation({ ...firing(), lastProposalTs: NOW - HOUR })).toBeNull();
  });

  it("fires exactly at the 24h boundary (now - lastProposalTs === 24h)", () => {
    const p = proposeFromObservation({ ...firing(), lastProposalTs: NOW - DAY });
    expect(p).not.toBeNull();
  });

  it("fires with lastProposalTs = 0 (never proposed)", () => {
    const p = proposeFromObservation({ ...firing(), lastProposalTs: 0 });
    expect(p).not.toBeNull();
  });
});

// ── price-alert gate ─────────────────────────────────────────────────────────

describe("proposeFromObservation — price-alert archetype", () => {
  it("3 floor opens (below gate of 4) → null", () => {
    const inputs = baseInputs({ ledger: ledgerWith({ floor: { product: "BTC-USD", count: 3 } }) });
    expect(proposeFromObservation(inputs)).toBeNull();
  });

  it("4 floor opens (at gate) → fires with a stable per-product id", () => {
    const inputs = baseInputs({ ledger: ledgerWith({ floor: { product: "BTC-USD", count: 4 } }) });
    const p = proposeFromObservation(inputs);
    expect(p).not.toBeNull();
    expect(p!.archetype).toBe("price-alert");
    expect(p!.id).toBe("price-alert:BTC-USD");
  });

  it("rationale quotes the real observed floor-open count", () => {
    const inputs = baseInputs({ ledger: ledgerWith({ floor: { product: "ETH-USD", count: 6 } }) });
    const p = proposeFromObservation(inputs)!;
    expect(p.rationale).toContain("6");
    expect(p.rationale).toContain("ETH-USD");
  });

  it("request mentions the product and triggers requestImpliesPowers", () => {
    const inputs = baseInputs({ ledger: ledgerWith({ floor: { product: "BTC-USD", count: 5 } }) });
    const p = proposeFromObservation(inputs)!;
    expect(p.request).toContain("BTC-USD");
    expect(requestImpliesPowers(p.request)).toBe(true);
  });

  it("declares pulse + market + notify powers", () => {
    const inputs = baseInputs({ ledger: ledgerWith({ floor: { product: "BTC-USD", count: 5 } }) });
    const p = proposeFromObservation(inputs)!;
    expect(p.powers.sort()).toEqual(["market", "notify", "pulse"]);
  });

  it("counts one product independently — two below-gate products stay silent", () => {
    let l = emptyLedger(NOW - 30 * DAY);
    for (let i = 0; i < 3; i++) l = foldUsage(l, { type: "floor-open", product: "BTC-USD" }, NOW - 20 * DAY);
    for (let i = 0; i < 3; i++) l = foldUsage(l, { type: "floor-open", product: "ETH-USD" }, NOW - 20 * DAY);
    expect(proposeFromObservation(baseInputs({ ledger: l }))).toBeNull();
  });
});

// ── morning-brief gate ───────────────────────────────────────────────────────

describe("proposeFromObservation — morning-brief archetype", () => {
  it("4 watch opens + 3 briefs (watchOpens below gate of 5) → null", () => {
    const inputs = baseInputs({ ledger: ledgerWith({ watchOpens: 4, briefs: 3 }) });
    expect(proposeFromObservation(inputs)).toBeNull();
  });

  it("5 watch opens + 2 briefs (briefs below gate of 3) → null", () => {
    const inputs = baseInputs({ ledger: ledgerWith({ watchOpens: 5, briefs: 2 }) });
    expect(proposeFromObservation(inputs)).toBeNull();
  });

  it("5 watch opens + 3 briefs (path A at gate) → fires", () => {
    const inputs = baseInputs({ ledger: ledgerWith({ watchOpens: 5, briefs: 3 }) });
    const p = proposeFromObservation(inputs);
    expect(p).not.toBeNull();
    expect(p!.archetype).toBe("morning-brief");
    expect(p!.id).toBe("morning-brief");
  });

  it("path B: 3 morning sessions + non-empty watchlist (positive weights) → fires", () => {
    const inputs = baseInputs({
      ledger: ledgerWith({ morningActivity: 3 }),
      weights: computeWeights(actSignals("science", 1)), // a positive weight exists
    });
    const p = proposeFromObservation(inputs);
    expect(p).not.toBeNull();
    expect(p!.archetype).toBe("morning-brief");
  });

  it("path B: 3 morning sessions but NO positive weights (empty watchlist proxy) → null", () => {
    const inputs = baseInputs({ ledger: ledgerWith({ morningActivity: 3 }) });
    expect(proposeFromObservation(inputs)).toBeNull();
  });

  it("path B: 2 morning sessions (below gate) + positive weights → null", () => {
    const inputs = baseInputs({
      ledger: ledgerWith({ morningActivity: 2 }),
      weights: computeWeights(actSignals("science", 1)),
    });
    expect(proposeFromObservation(inputs)).toBeNull();
  });

  it("request triggers requestImpliesPowers and declares pulse+watch+voice", () => {
    const inputs = baseInputs({ ledger: ledgerWith({ watchOpens: 6, briefs: 4 }) });
    const p = proposeFromObservation(inputs)!;
    expect(requestImpliesPowers(p.request)).toBe(true);
    expect(p.powers.sort()).toEqual(["pulse", "voice", "watch"]);
  });

  it("rationale quotes the real watch-open count", () => {
    const inputs = baseInputs({ ledger: ledgerWith({ watchOpens: 7, briefs: 3 }) });
    const p = proposeFromObservation(inputs)!;
    expect(p.rationale).toContain("7");
  });
});

// ── topic-digest gate ────────────────────────────────────────────────────────

describe("proposeFromObservation — topic-digest archetype", () => {
  it("3 act signals in a category (below gate of 4) → null", () => {
    const sigs = actSignals("markets", 3);
    const inputs = baseInputs({ signals: sigs, weights: computeWeights(sigs) });
    expect(proposeFromObservation(inputs)).toBeNull();
  });

  it("4 act signals with positive category weight (at gate) → fires", () => {
    const sigs = actSignals("markets", 4);
    const inputs = baseInputs({ signals: sigs, weights: computeWeights(sigs) });
    const p = proposeFromObservation(inputs);
    expect(p).not.toBeNull();
    expect(p!.archetype).toBe("topic-digest");
    expect(p!.id).toBe("topic-digest:markets");
  });

  it("4 act but net-negative weight (dismisses outweigh) → null", () => {
    const sigs: EngagementSignal[] = [
      ...actSignals("markets", 4),
      { eventKey: "d1", action: "dismiss", ts: NOW, category: "markets" },
      { eventKey: "d2", action: "dismiss", ts: NOW, category: "markets" },
      { eventKey: "d3", action: "dismiss", ts: NOW, category: "markets" },
      { eventKey: "d4", action: "dismiss", ts: NOW, category: "markets" },
      { eventKey: "d5", action: "dismiss", ts: NOW, category: "markets" },
      { eventKey: "d6", action: "dismiss", ts: NOW, category: "markets" },
    ];
    const inputs = baseInputs({ signals: sigs, weights: computeWeights(sigs) });
    expect(proposeFromObservation(inputs)).toBeNull();
  });

  it("request mentions the category, triggers powers, declares pulse+watch+notify", () => {
    const sigs = actSignals("science", 5);
    const inputs = baseInputs({ signals: sigs, weights: computeWeights(sigs) });
    const p = proposeFromObservation(inputs)!;
    expect(p.request.toLowerCase()).toContain("science");
    expect(requestImpliesPowers(p.request)).toBe(true);
    expect(p.powers.sort()).toEqual(["notify", "pulse", "watch"]);
  });

  it("rationale quotes the real act-signal count", () => {
    const sigs = actSignals("science", 5);
    const inputs = baseInputs({ signals: sigs, weights: computeWeights(sigs) });
    const p = proposeFromObservation(inputs)!;
    expect(p.rationale).toContain("5");
    expect(p.rationale).toContain("science");
  });
});

// ── never-list exclusion ─────────────────────────────────────────────────────

describe("proposeFromObservation — never-list exclusion", () => {
  it("a never-listed archetype id is never proposed", () => {
    const inputs = baseInputs({
      ledger: ledgerWith({ floor: { product: "BTC-USD", count: 6 } }),
      neverList: ["price-alert:BTC-USD"],
    });
    expect(proposeFromObservation(inputs)).toBeNull();
  });

  it("never-listing one product does not block another", () => {
    let l = emptyLedger(NOW - 30 * DAY);
    for (let i = 0; i < 5; i++) l = foldUsage(l, { type: "floor-open", product: "BTC-USD" }, NOW - 20 * DAY);
    for (let i = 0; i < 6; i++) l = foldUsage(l, { type: "floor-open", product: "ETH-USD" }, NOW - 20 * DAY);
    const p = proposeFromObservation(baseInputs({ ledger: l, neverList: ["price-alert:BTC-USD"] }));
    expect(p).not.toBeNull();
    expect(p!.id).toBe("price-alert:ETH-USD");
  });
});

// ── existing-organ exclusion ─────────────────────────────────────────────────

describe("proposeFromObservation — existing-organ exclusion", () => {
  it("skips an archetype whose organ appears already installed (title match)", () => {
    const inputs = baseInputs({
      ledger: ledgerWith({ floor: { product: "BTC-USD", count: 6 } }),
      organs: [{ id: "some-id", title: "BTC-USD price alert" }],
    });
    expect(proposeFromObservation(inputs)).toBeNull();
  });

  it("does not skip when an unrelated organ is installed", () => {
    const inputs = baseInputs({
      ledger: ledgerWith({ floor: { product: "BTC-USD", count: 6 } }),
      organs: [{ id: "x", title: "a water tracker" }],
    });
    expect(proposeFromObservation(inputs)).not.toBeNull();
  });
});

// ── selection: highest-evidence wins ─────────────────────────────────────────

describe("proposeFromObservation — selection", () => {
  it("when multiple rules fire, the highest-evidence one is chosen", () => {
    // price-alert: 20 floor opens (very strong). morning-brief: barely at gate.
    const inputs = baseInputs({
      ledger: ledgerWith({ watchOpens: 5, briefs: 3, floor: { product: "BTC-USD", count: 20 } }),
    });
    const p = proposeFromObservation(inputs)!;
    expect(p.archetype).toBe("price-alert");
  });

  it("returns a single Proposal, never an array", () => {
    const inputs = baseInputs({ ledger: ledgerWith({ floor: { product: "BTC-USD", count: 8 } }) });
    const p = proposeFromObservation(inputs);
    expect(Array.isArray(p)).toBe(false);
    expect(p).toMatchObject<Partial<Proposal>>({ archetype: "price-alert" });
  });
});
