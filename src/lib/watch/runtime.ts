/**
 * runtime.ts — The Watch runtime
 *
 * Polls live sensors on a 120s interval (min 60s), scores all events against
 * the user's watchlist and engagement history, keeps the top 100 by score,
 * and emits `loom-salience` CustomEvent {items: ScoredEvent[]} ONLY when the
 * top-10 id-ordering actually changed.
 *
 * Behaviour:
 *   - First poll fires immediately on startWatch().
 *   - document.hidden pauses polling (visibilitychange listener).
 *   - In-flight guard prevents overlapping polls.
 *   - startWatch()/stopWatch() are idempotent.
 *   - getSalient(k) returns the current top-k for consumers (voice briefing etc.)
 */

import type { WatchEvent, ScoredEvent } from "./types";
import { scoreEvent } from "./score";
import { getWatchlist, engagementMap } from "./store";
import { fetchAuspexStories, fetchQuakes } from "./sensors";

const DEFAULT_INTERVAL_MS = 120_000; // 2 minutes
const MIN_INTERVAL_MS = 60_000; // 1 minute (guard)
const TOP_N = 100; // keep this many scored events
const CHANGE_WINDOW = 10; // compare the top-10 ids to detect ordering change

// ── Module-level state ─────────────────────────────────────────────────────────

let intervalId: ReturnType<typeof setInterval> | null = null;
let inFlight = false;
let lastTopIds = ""; // cheap join of top-CHANGE_WINDOW ids
let salientItems: ScoredEvent[] = [];

// ── Visibility pause/resume ────────────────────────────────────────────────────

function onVisibilityChange() {
  if (document.hidden) {
    pausePolling();
  } else {
    if (intervalId !== null) {
      // Already running — do nothing (just let the interval fire normally)
    } else if (intervalId === null && _isStarted) {
      // Was paused — restart
      resumePolling();
    }
  }
}

// Track whether startWatch has been called (for resume-after-hidden logic)
let _isStarted = false;

function pausePolling() {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

function resumePolling() {
  if (intervalId !== null) return;
  // Immediate poll then interval
  void poll();
  scheduleInterval();
}

function scheduleInterval() {
  const ms = Math.max(MIN_INTERVAL_MS, DEFAULT_INTERVAL_MS);
  intervalId = setInterval(() => { void poll(); }, ms);
}

// ── Core poll ─────────────────────────────────────────────────────────────────

async function poll(): Promise<void> {
  if (inFlight) return; // no overlapping polls
  inFlight = true;
  try {
    // Fetch both sensors concurrently
    const [stories, quakes] = await Promise.all([
      fetchAuspexStories(50),
      fetchQuakes(4.5),
    ]);

    // Merge and dedupe by id
    const seen = new Set<string>();
    const merged: WatchEvent[] = [];
    for (const e of [...stories, ...quakes]) {
      if (!seen.has(e.id)) {
        seen.add(e.id);
        merged.push(e);
      }
    }

    // Score all events
    const watchlist = getWatchlist();
    const engagement = engagementMap(merged);
    const scored: ScoredEvent[] = merged.map((e) =>
      scoreEvent(e, watchlist, engagement)
    );

    // Sort descending, keep top N
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, TOP_N);

    // Compare top-CHANGE_WINDOW ids to detect meaningful reordering
    const topIds = top
      .slice(0, CHANGE_WINDOW)
      .map((e) => e.id)
      .join(",");

    if (topIds !== lastTopIds) {
      lastTopIds = topIds;
      salientItems = top;
      window.dispatchEvent(
        new CustomEvent<{ items: ScoredEvent[] }>("loom-salience", {
          detail: { items: top },
        })
      );
    }
  } finally {
    inFlight = false;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/** Start the Watch runtime. Idempotent — safe to call multiple times. */
export function startWatch(): void {
  if (_isStarted) return;
  _isStarted = true;

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange, { passive: true });
  }

  if (typeof document !== "undefined" && document.hidden) {
    // Start paused — will resume on visibility
    return;
  }

  // Immediate first poll
  void poll();
  scheduleInterval();
}

/** Stop the Watch runtime and clean up. Idempotent. */
export function stopWatch(): void {
  if (!_isStarted) return;
  _isStarted = false;

  if (typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", onVisibilityChange);
  }

  pausePolling();
  inFlight = false;
  lastTopIds = "";
  salientItems = [];
}

/**
 * Return the current top-k salient events synchronously.
 * Consumers (voice briefing, WatchPanel) call this to read without subscribing.
 */
export function getSalient(k = 10): ScoredEvent[] {
  return salientItems.slice(0, k);
}
