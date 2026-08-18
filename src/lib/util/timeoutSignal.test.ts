/**
 * timeoutSignal.test.ts — unit tests for the AbortSignal timeout helper.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { timeoutSignal } from "./timeoutSignal";

describe("timeoutSignal", () => {
  afterEach(() => vi.restoreAllMocks());

  it("delegates to AbortSignal.timeout when available", () => {
    const mockSignal = {} as AbortSignal;
    const spy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(mockSignal);
    const result = timeoutSignal(5000);
    expect(spy).toHaveBeenCalledWith(5000);
    expect(result).toBe(mockSignal);
  });

  it("returns an AbortSignal", () => {
    const sig = timeoutSignal(10_000);
    expect(sig).toBeDefined();
    expect(typeof sig.aborted).toBe("boolean");
  });

  it("uses AbortController fallback when AbortSignal.timeout is not a function", () => {
    vi.useFakeTimers();
    const orig = AbortSignal.timeout;
    // @ts-expect-error — intentionally removing to test fallback
    AbortSignal.timeout = undefined;
    try {
      const sig = timeoutSignal(100);
      expect(sig.aborted).toBe(false);
      vi.advanceTimersByTime(100);
      expect(sig.aborted).toBe(true);
    } finally {
      AbortSignal.timeout = orig;
      vi.useRealTimers();
    }
  });

  it("fallback abort reason is a DOMException with TimeoutError name", () => {
    vi.useFakeTimers();
    const orig = AbortSignal.timeout;
    // @ts-expect-error
    AbortSignal.timeout = undefined;
    try {
      const sig = timeoutSignal(50);
      vi.advanceTimersByTime(50);
      expect(sig.reason).toBeInstanceOf(DOMException);
      expect((sig.reason as DOMException).name).toBe("TimeoutError");
    } finally {
      AbortSignal.timeout = orig;
      vi.useRealTimers();
    }
  });
});
