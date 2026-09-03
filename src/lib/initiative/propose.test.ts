import { describe, it, expect } from "vitest";
import { proposeFromObservation, type ProposeInputs, type Proposal } from "./propose";
import { emptyLedger, type UsageLedger } from "./observe";
import { requestImpliesPowers } from "../loom/prompts";

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const NOW = 1_700_000_000_000;

const ONE_ORGAN = [{ id: "water-tracker", title: "Water Tracker" }];

// A base inputs object well past the rate-limit, enabled, one organ installed.
function baseInputs(over: Partial<ProposeInputs> = {}): ProposeInputs {
  return {
    ledger: emptyLedger(NOW - 30 * DAY),
    organs: ONE_ORGAN,
    neverList: [],
    lastProposalTs: NOW - 2 * DAY, // past the 24h rate-limit
    now: NOW,
    enabled: true,
    ...over,
  };
}

function ledgerWith(opts: { morningActivity?: number }): UsageLedger {
  const l = emptyLedger(NOW - 30 * DAY);
  return { ...l, morningActivity: opts.morningActivity ?? 0 };
}

// ── The default: silence ─────────────────────────────────────────────────────

describe("proposeFromObservation — silence is the default", () => {
  it("empty ledger → null", () => {
    expect(proposeFromObservation(baseInputs())).toBeNull();
  });

  it("thin evidence (below the gate) → null", () => {
    expect(proposeFromObservation(baseInputs({ ledger: ledgerWith({ morningActivity: 2 }) }))).toBeNull();
  });
});

// ── Governance: disabled / rate-limit ────────────────────────────────────────

describe("proposeFromObservation — governance short-circuits", () => {
  const firing = () => baseInputs({ ledger: ledgerWith({ morningActivity: 5 }) });

  it("returns null when disabled, even with firing evidence", () => {
    expect(proposeFromObservation({ ...firing(), enabled: false })).toBeNull();
  });

  it("returns null inside the 24h rate-limit window", () => {
    expect(proposeFromObservation({ ...firing(), lastProposalTs: NOW - HOUR })).toBeNull();
  });

  it("fires exactly at the 24h boundary (now - lastProposalTs === 24h)", () => {
    expect(proposeFromObservation({ ...firing(), lastProposalTs: NOW - DAY })).not.toBeNull();
  });

  it("fires with lastProposalTs = 0 (never proposed)", () => {
    expect(proposeFromObservation({ ...firing(), lastProposalTs: 0 })).not.toBeNull();
  });
});

// ── morning-brief gate ───────────────────────────────────────────────────────

describe("proposeFromObservation — morning-brief archetype", () => {
  it("3 mornings running + one organ (at gate) → fires with a stable id", () => {
    const p = proposeFromObservation(baseInputs({ ledger: ledgerWith({ morningActivity: 3 }) }));
    expect(p).not.toBeNull();
    expect(p!.archetype).toBe("morning-brief");
    expect(p!.id).toBe("morning-brief");
  });

  it("2 mornings (below gate) → null", () => {
    expect(proposeFromObservation(baseInputs({ ledger: ledgerWith({ morningActivity: 2 }) }))).toBeNull();
  });

  it("3 mornings but an EMPTY weave → null (nothing to read aloud)", () => {
    expect(
      proposeFromObservation(baseInputs({ ledger: ledgerWith({ morningActivity: 3 }), organs: [] }))
    ).toBeNull();
  });

  it("rationale quotes the real morning count and organ count", () => {
    const p = proposeFromObservation(
      baseInputs({
        ledger: ledgerWith({ morningActivity: 4 }),
        organs: [...ONE_ORGAN, { id: "notes", title: "Notes" }],
      })
    )!;
    expect(p.rationale).toContain("4 mornings");
    expect(p.rationale).toContain("2 organs");
  });

  it("request triggers requestImpliesPowers and declares only surviving powers", () => {
    const p = proposeFromObservation(baseInputs({ ledger: ledgerWith({ morningActivity: 6 }) }))!;
    expect(requestImpliesPowers(p.request)).toBe(true);
    expect(p.powers.sort()).toEqual(["pulse", "timeline", "voice"]);
    expect(p.powers).not.toContain("watch");
    expect(p.powers).not.toContain("market");
  });
});

// ── never-list exclusion ─────────────────────────────────────────────────────

describe("proposeFromObservation — never-list exclusion", () => {
  it("a never-listed archetype id is never proposed", () => {
    const inputs = baseInputs({ ledger: ledgerWith({ morningActivity: 6 }), neverList: ["morning-brief"] });
    expect(proposeFromObservation(inputs)).toBeNull();
  });

  it("a legacy never-list entry from a retired archetype does not block", () => {
    const inputs = baseInputs({ ledger: ledgerWith({ morningActivity: 6 }), neverList: ["price-alert:BTC-USD"] });
    expect(proposeFromObservation(inputs)).not.toBeNull();
  });
});

// ── existing-organ exclusion ─────────────────────────────────────────────────

describe("proposeFromObservation — existing-organ exclusion", () => {
  it("skips the archetype when a morning brief already looks installed (title match)", () => {
    const inputs = baseInputs({
      ledger: ledgerWith({ morningActivity: 6 }),
      organs: [{ id: "some-id", title: "Morning Brief" }],
    });
    expect(proposeFromObservation(inputs)).toBeNull();
  });

  it("does not skip when only unrelated organs are installed", () => {
    const inputs = baseInputs({
      ledger: ledgerWith({ morningActivity: 6 }),
      organs: [{ id: "x", title: "a water tracker" }],
    });
    expect(proposeFromObservation(inputs)).not.toBeNull();
  });
});

// ── shape ────────────────────────────────────────────────────────────────────

describe("proposeFromObservation — shape", () => {
  it("returns a single Proposal, never an array", () => {
    const p = proposeFromObservation(baseInputs({ ledger: ledgerWith({ morningActivity: 8 }) }));
    expect(Array.isArray(p)).toBe(false);
    expect(p).toMatchObject<Partial<Proposal>>({ archetype: "morning-brief" });
  });
});
