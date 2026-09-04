import { describe, it, expect } from "vitest";
import { makeLedger, POWER_BUDGETS } from "./budgets";

function fixedClock(start = 0) {
  let now = start;
  return {
    clock: () => now,
    advance: (ms: number) => { now += ms; },
  };
}

describe("POWER_BUDGETS", () => {
  it("declares the three budgeted powers with the spec limits", () => {
    expect(Object.keys(POWER_BUDGETS).sort()).toEqual(["notify", "self", "voice"]);
    expect(POWER_BUDGETS.voice).toEqual({ capacity: 1, windowMs: 30_000 });
    expect(POWER_BUDGETS.notify).toEqual({ capacity: 6, windowMs: 3_600_000 });
    // self actions (thread · reweave · returnTo) each close or rebuild LOOM —
    // a runaway organ gets three a minute, not a loop.
    expect(POWER_BUDGETS.self).toEqual({ capacity: 3, windowMs: 60_000 });
  });
});

describe("makeLedger", () => {
  it("throttles a spent bucket and reports a positive retryMs", () => {
    const { clock } = fixedClock();
    const ledger = makeLedger(clock);
    for (let i = 0; i < 6; i++) expect(ledger.take("nudge", "notify").ok).toBe(true);
    const r = ledger.take("nudge", "notify");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryMs).toBeGreaterThan(0);
  });

  it("voice allows exactly 1 per 30s", () => {
    const { clock, advance } = fixedClock();
    const ledger = makeLedger(clock);
    expect(ledger.take("nudge", "voice").ok).toBe(true);
    expect(ledger.take("nudge", "voice").ok).toBe(false);
    advance(29_999);
    expect(ledger.take("nudge", "voice").ok).toBe(false);
    advance(1);
    expect(ledger.take("nudge", "voice").ok).toBe(true);
  });

  it("notify allows 6 per hour", () => {
    const { clock, advance } = fixedClock();
    const ledger = makeLedger(clock);
    for (let i = 0; i < 6; i++) expect(ledger.take("nudge", "notify").ok).toBe(true);
    expect(ledger.take("nudge", "notify").ok).toBe(false);
    advance(600_000); // one token per 10 minutes
    expect(ledger.take("nudge", "notify").ok).toBe(true);
  });

  it("reports retryMs matching the actual refill time", () => {
    const { clock, advance } = fixedClock();
    const ledger = makeLedger(clock);
    ledger.take("nudge", "voice");
    const r = ledger.take("nudge", "voice");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.retryMs).toBe(30_000);
      advance(r.retryMs);
      expect(ledger.take("nudge", "voice").ok).toBe(true);
    }
  });

  it("budgets are per organ — one organ's spend never throttles another", () => {
    const { clock } = fixedClock();
    const ledger = makeLedger(clock);
    ledger.take("a", "voice");
    expect(ledger.take("a", "voice").ok).toBe(false);
    expect(ledger.take("b", "voice").ok).toBe(true);
  });

  it("budgets are per power — spending voice never touches notify", () => {
    const { clock } = fixedClock();
    const ledger = makeLedger(clock);
    ledger.take("a", "voice");
    expect(ledger.take("a", "voice").ok).toBe(false);
    expect(ledger.take("a", "notify").ok).toBe(true);
  });

  it("refill caps at capacity — a long idle never over-fills", () => {
    const { clock, advance } = fixedClock();
    const ledger = makeLedger(clock);
    ledger.take("a", "voice"); // creates the bucket
    advance(3_600_000); // an hour idle — still capacity 1
    expect(ledger.take("a", "voice").ok).toBe(true);
    expect(ledger.take("a", "voice").ok).toBe(false);
  });

  it("reset(organId) clears only that organ's buckets", () => {
    const { clock } = fixedClock();
    const ledger = makeLedger(clock);
    ledger.take("a", "voice");
    ledger.take("b", "voice");
    ledger.reset("a");
    expect(ledger.take("a", "voice").ok).toBe(true);  // fresh bucket
    expect(ledger.take("b", "voice").ok).toBe(false); // still spent
  });

  it("reset() clears everything", () => {
    const { clock } = fixedClock();
    const ledger = makeLedger(clock);
    ledger.take("a", "voice");
    ledger.reset();
    expect(ledger.take("a", "voice").ok).toBe(true);
  });

  it("defaults to Date.now when no clock is injected", () => {
    const ledger = makeLedger();
    expect(ledger.take("a", "voice").ok).toBe(true);
  });
});
