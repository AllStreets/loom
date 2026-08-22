/**
 * usePoll.test.tsx — the hook's abort guarantee.
 *
 * The docstring promises every run's AbortSignal fires on pause/unmount.
 * That only holds if run() aborts the PREVIOUS controller before creating
 * the next one — otherwise an in-flight tick is orphaned with a signal
 * stop() can no longer reach (review finding, Phase 17 ship gate).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { act } from "react";
import { usePoll } from "./usePoll";

describe("usePoll abort guarantees", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts the previous run's signal when the next tick fires", () => {
    const signals: AbortSignal[] = [];
    const tick = (signal: AbortSignal) => {
      signals.push(signal);
      // never resolves — simulates a slow in-flight request
    };
    renderHook(() => usePoll(tick, 1000));

    expect(signals.length).toBe(1);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(signals.length).toBe(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
  });

  it("aborts the latest in-flight signal on unmount", () => {
    const signals: AbortSignal[] = [];
    const { unmount } = renderHook(() => usePoll((s) => void signals.push(s), 1000));
    expect(signals.length).toBe(1);
    unmount();
    expect(signals[0].aborted).toBe(true);
  });
});
