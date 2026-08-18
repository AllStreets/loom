import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as sensors from "./sensors";
import * as storeModule from "./store";
import { startWatch, stopWatch, getSalient } from "./runtime";

// ── Sensor stubs (fast, no real network) ──────────────────────────────────────

const makeStory = (id: string) => ({
  id: `auspex:${id}`,
  title: `Story ${id}`,
  source: "auspex" as const,
  category: "geo",
  publishedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
});

const makeQuake = (id: string) => ({
  id: `quakes:${id}`,
  title: `Quake ${id}`,
  source: "quakes" as const,
  category: "seismic",
  publishedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  magnitude: 5.0,
});

// ── Setup ──────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();

  vi.spyOn(sensors, "fetchAuspexStories").mockResolvedValue([
    makeStory("a"),
    makeStory("b"),
    makeStory("c"),
  ]);
  vi.spyOn(sensors, "fetchQuakes").mockResolvedValue([
    makeQuake("q1"),
    makeQuake("q2"),
  ]);
  vi.spyOn(storeModule, "getWatchlist").mockReturnValue([]);
  vi.spyOn(storeModule, "engagementMap").mockReturnValue({});

  // Ensure clean state before each test
  stopWatch();
});

afterEach(() => {
  stopWatch();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// Helper: let the immediate poll promise settle (uses microtask queue flush)
async function flushPoll() {
  // Advance time by 0 to flush any resolved promises from mock sensors
  await vi.advanceTimersByTimeAsync(0);
}

// ── Poll cadence ───────────────────────────────────────────────────────────────

describe("runtime — poll cadence", () => {
  it("fires an immediate first poll on startWatch", async () => {
    startWatch();
    await flushPoll();
    expect(sensors.fetchAuspexStories).toHaveBeenCalledTimes(1);
    expect(sensors.fetchQuakes).toHaveBeenCalledTimes(1);
  });

  it("polls again after the interval (120s)", async () => {
    startWatch();
    await flushPoll(); // first poll
    await vi.advanceTimersByTimeAsync(120_000); // triggers interval
    expect(sensors.fetchAuspexStories).toHaveBeenCalledTimes(2);
  });

  it("stopWatch halts further polls", async () => {
    startWatch();
    await flushPoll(); // first poll
    stopWatch();
    await vi.advanceTimersByTimeAsync(300_000); // no interval should fire
    expect(sensors.fetchAuspexStories).toHaveBeenCalledTimes(1);
  });

  it("startWatch is idempotent — double-start does not double-poll", async () => {
    startWatch();
    startWatch();
    await flushPoll();
    expect(sensors.fetchAuspexStories).toHaveBeenCalledTimes(1);
  });
});

// ── Hidden pause / resume ─────────────────────────────────────────────────────

describe("runtime — document.hidden pause/resume", () => {
  it("does not poll when document is hidden at start", async () => {
    Object.defineProperty(document, "hidden", { value: true, configurable: true, writable: true });
    startWatch();
    await flushPoll();
    expect(sensors.fetchAuspexStories).not.toHaveBeenCalled();
    // Cleanup
    Object.defineProperty(document, "hidden", { value: false, configurable: true, writable: true });
  });

  it("resumes polling on visibilitychange → visible", async () => {
    // Start hidden
    Object.defineProperty(document, "hidden", { value: true, configurable: true, writable: true });
    startWatch();
    await flushPoll();
    expect(sensors.fetchAuspexStories).not.toHaveBeenCalled();

    // Become visible
    Object.defineProperty(document, "hidden", { value: false, configurable: true, writable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await flushPoll();
    expect(sensors.fetchAuspexStories).toHaveBeenCalledTimes(1);
  });
});

// ── No overlapping polls ──────────────────────────────────────────────────────

describe("runtime — no overlapping polls", () => {
  it("does not start a second poll while one is in-flight", async () => {
    // Make first sensor call never resolve during this test
    let resolveStories!: (v: Awaited<ReturnType<typeof sensors.fetchAuspexStories>>) => void;
    vi.spyOn(sensors, "fetchAuspexStories").mockReturnValue(
      new Promise((res) => { resolveStories = res; })
    );

    startWatch(); // triggers first poll (in-flight, never resolves yet)
    // Advance to trigger the interval tick — should NOT start a second poll
    await vi.advanceTimersByTimeAsync(120_000);

    expect(sensors.fetchAuspexStories).toHaveBeenCalledTimes(1);

    // Clean up
    resolveStories([]);
    await flushPoll();
  });
});

// ── Change-only emission ──────────────────────────────────────────────────────

describe("runtime — loom-salience event emission", () => {
  it("emits loom-salience on first poll", async () => {
    const handler = vi.fn();
    window.addEventListener("loom-salience", handler);

    startWatch();
    await flushPoll();

    expect(handler).toHaveBeenCalledTimes(1);
    const detail = (handler.mock.calls[0][0] as CustomEvent).detail;
    expect(Array.isArray(detail.items)).toBe(true);
    expect(detail.items.length).toBeGreaterThan(0);

    window.removeEventListener("loom-salience", handler);
  });

  it("does NOT re-emit when top-10 ordering is unchanged", async () => {
    const handler = vi.fn();
    window.addEventListener("loom-salience", handler);

    startWatch();
    await flushPoll(); // first poll — emits

    // Same sensor data — second poll
    await vi.advanceTimersByTimeAsync(120_000);

    // Should still be 1 (same top-10)
    expect(handler).toHaveBeenCalledTimes(1);

    window.removeEventListener("loom-salience", handler);
  });

  it("emits again when top-10 ordering changes", async () => {
    const handler = vi.fn();
    window.addEventListener("loom-salience", handler);

    startWatch();
    await flushPoll(); // first poll

    // Change sensor output on second poll — different ids
    vi.spyOn(sensors, "fetchAuspexStories").mockResolvedValue([
      makeStory("x"), makeStory("y"), makeStory("z"),
    ]);
    vi.spyOn(sensors, "fetchQuakes").mockResolvedValue([]);

    await vi.advanceTimersByTimeAsync(120_000);

    expect(handler).toHaveBeenCalledTimes(2);

    window.removeEventListener("loom-salience", handler);
  });
});

// ── getSalient ────────────────────────────────────────────────────────────────

describe("runtime — getSalient", () => {
  it("returns empty array before first poll", () => {
    expect(getSalient()).toEqual([]);
    expect(getSalient(5)).toEqual([]);
  });

  it("returns up to k items after a poll", async () => {
    startWatch();
    await flushPoll();
    const items = getSalient(3);
    expect(items.length).toBeLessThanOrEqual(3);
    expect(items.length).toBeGreaterThan(0);
  });

  it("returned items have score and reasons fields", async () => {
    startWatch();
    await flushPoll();
    const items = getSalient(10);
    for (const item of items) {
      expect(typeof item.score).toBe("number");
      expect(Array.isArray(item.reasons)).toBe(true);
      expect(item.reasons.length).toBeGreaterThan(0);
    }
  });

  it("returns [] after stopWatch clears state", async () => {
    startWatch();
    await flushPoll();
    expect(getSalient().length).toBeGreaterThan(0);
    stopWatch();
    expect(getSalient()).toEqual([]);
  });
});

// ── Merge + dedupe ────────────────────────────────────────────────────────────

describe("runtime — merge and dedupe", () => {
  it("dedupes events with the same id across sensors", async () => {
    // Both sensors return an item with the same id
    vi.spyOn(sensors, "fetchAuspexStories").mockResolvedValue([makeStory("shared")]);
    vi.spyOn(sensors, "fetchQuakes").mockResolvedValue([
      { ...makeQuake("shared"), id: "auspex:shared" }, // same id as story
    ] as Awaited<ReturnType<typeof sensors.fetchQuakes>>);

    startWatch();
    await flushPoll();

    const items = getSalient(20);
    const ids = items.map((i) => i.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });
});
