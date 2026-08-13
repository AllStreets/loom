import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// We need to control rAF and document.hidden.
// Use vitest fake timers + manual rAF mock.
// ---------------------------------------------------------------------------

// Collect rAF callbacks so we can fire them manually
const rafCallbacks: Map<number, FrameRequestCallback> = new Map();
let rafId = 0;

beforeEach(() => {
  rafCallbacks.clear();
  rafId = 0;

  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = ++rafId;
    rafCallbacks.set(id, cb);
    return id;
  });

  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    rafCallbacks.delete(id);
  });

  // Ensure document is visible
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

function flushRaf(now = 1000) {
  const callbacks = [...rafCallbacks.values()];
  rafCallbacks.clear();
  for (const cb of callbacks) {
    cb(now);
  }
}

// We need to reimport the module fresh each test so the module-level state is reset.
// Use dynamic imports.

describe("ambientLoop", () => {
  it("subscribe: fn is called on each rAF tick", async () => {
    const { subscribe } = await import("./ambientLoop");
    const fn = vi.fn();

    subscribe(fn);

    // First tick
    flushRaf(1000);
    expect(fn).toHaveBeenCalledTimes(1);

    // Second tick
    flushRaf(1016);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("unsubscribe: fn is not called after unsubscribing", async () => {
    const { subscribe } = await import("./ambientLoop");
    const fn = vi.fn();

    const unsub = subscribe(fn);

    flushRaf(1000);
    expect(fn).toHaveBeenCalledTimes(1);

    unsub();

    // Should have cancelled rAF too, but even if a tick fires fn should not be called
    // after removal (flush any remaining)
    flushRaf(1016);
    expect(fn).toHaveBeenCalledTimes(1); // unchanged
  });

  it("multiple subscribers all receive ticks", async () => {
    const { subscribe } = await import("./ambientLoop");
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    const fn3 = vi.fn();

    subscribe(fn1);
    subscribe(fn2);
    subscribe(fn3);

    flushRaf(1000);

    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(1);
    expect(fn3).toHaveBeenCalledTimes(1);
  });

  it("rAF is NOT re-armed while document.hidden and resumes on visible", async () => {
    const { subscribe } = await import("./ambientLoop");
    const fn = vi.fn();

    subscribe(fn);

    // First tick (visible) — loop arms a new rAF after ticking
    flushRaf(1000);
    expect(fn).toHaveBeenCalledTimes(1);
    // A new rAF should be pending (loop re-armed itself)
    expect(rafCallbacks.size).toBeGreaterThan(0);

    // Hide document — visibilitychange fires stop(), loop should cancel rAF
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });
    document.dispatchEvent(new Event("visibilitychange"));

    // After hide: no rAF should be pending
    expect(rafCallbacks.size).toBe(0);

    // Flushing any stale callbacks (there shouldn't be any) must NOT re-arm rAF
    const rafCountBeforeFlush = rafCallbacks.size;
    if (rafCountBeforeFlush > 0) flushRaf(1016);
    expect(rafCallbacks.size).toBe(0);

    // fn must not have been called while hidden
    expect(fn).toHaveBeenCalledTimes(1);

    // Restore visibility — visibilitychange fires start(), loop should resume
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => false,
    });
    document.dispatchEvent(new Event("visibilitychange"));

    // A new rAF should now be pending
    expect(rafCallbacks.size).toBeGreaterThan(0);

    // Tick — fn should be called again
    flushRaf(1032);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("unsubscribing last subscriber stops the rAF loop", async () => {
    const { subscribe } = await import("./ambientLoop");
    const fn = vi.fn();

    const unsub = subscribe(fn);
    const rafCountBefore = rafCallbacks.size;
    expect(rafCountBefore).toBeGreaterThan(0);

    unsub();

    // After unsub, no more rAF pending
    expect(rafCallbacks.size).toBe(0);
  });
});
