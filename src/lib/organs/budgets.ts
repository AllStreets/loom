/**
 * budgets.ts — per-organ power budgets as a pure token bucket.
 *
 * Each (organ, power) pair owns one bucket. Buckets refill continuously at
 * capacity/windowMs tokens per ms, capped at capacity. `take` spends one token
 * or reports how long until the next one arrives — the caller turns that into
 * a calm error + a THROTTLED chip; nothing here throws or touches the DOM.
 *
 * The clock is injectable so tests are deterministic.
 */

export type Clock = () => number;

export type BucketSpec = { capacity: number; windowMs: number };

/** The budgeted powers and their per-organ limits. */
export const POWER_BUDGETS = {
  market: { capacity: 30, windowMs: 60_000 },      // 30 requests / minute
  voice: { capacity: 1, windowMs: 30_000 },        // 1 utterance / 30s
  notify: { capacity: 6, windowMs: 3_600_000 },    // 6 notices / hour
} as const satisfies Record<string, BucketSpec>;

export type BudgetedPower = keyof typeof POWER_BUDGETS;

export type TakeResult = { ok: true } | { ok: false; retryMs: number };

type BucketState = { tokens: number; last: number };

export type BudgetLedger = {
  /** Spend one token for (organId, power). Full bucket at first sight. */
  take(organId: string, power: BudgetedPower): TakeResult;
  /** Drop all buckets for one organ (or every organ when omitted). */
  reset(organId?: string): void;
};

export function makeLedger(clock: Clock = () => Date.now()): BudgetLedger {
  const buckets = new Map<string, BucketState>();

  return {
    take(organId, power) {
      const spec = POWER_BUDGETS[power];
      const key = `${organId}:${power}`;
      const now = clock();
      let b = buckets.get(key);
      if (!b) {
        b = { tokens: spec.capacity, last: now };
        buckets.set(key, b);
      }
      // Continuous refill since last touch, capped at capacity.
      const rate = spec.capacity / spec.windowMs; // tokens per ms
      b.tokens = Math.min(spec.capacity, b.tokens + (now - b.last) * rate);
      b.last = now;
      if (b.tokens >= 1) {
        b.tokens -= 1;
        return { ok: true };
      }
      return { ok: false, retryMs: Math.ceil((1 - b.tokens) / rate) };
    },

    reset(organId) {
      if (organId === undefined) {
        buckets.clear();
        return;
      }
      const prefix = `${organId}:`;
      for (const key of [...buckets.keys()]) {
        if (key.startsWith(prefix)) buckets.delete(key);
      }
    },
  };
}
