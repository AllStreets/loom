/**
 * store.ts — loom.watch.v1 localStorage store
 *
 * Manages two things client-side, never transmitted:
 *   1. Watchlist entries — topics/places/entities/sources the user cares about.
 *   2. Engagement signals — open/dismiss/act actions on scored events.
 *
 * All storage errors are swallowed silently (storage may be unavailable in
 * some environments). A 64KB total guard prevents runaway growth.
 */

import type { EngagementMap } from "./score";
import { buildEngagementMap } from "./score";

const STORE_KEY = "loom.watch.v1";
const MAX_WATCHLIST = 200;
const MAX_SIGNALS = 500;
const MAX_BYTES = 64 * 1024; // 64KB

export interface WatchlistEntry {
  kind: "topic" | "place" | "entity" | "source";
  value: string;
}

export interface EngagementSignal {
  eventKey: string;
  action: "open" | "dismiss" | "act";
  ts: number;
  // Feature snapshot — added at write time so computeWeights doesn't need live events
  category?: string;
  source?: string;
  titleTokens?: string[];  // lowercase unigrams, stopword-filtered, capped at 10
}

interface StoreData {
  watchlist: WatchlistEntry[];
  signals: EngagementSignal[];
}

function load(): StoreData {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { watchlist: [], signals: [] };
    const parsed = JSON.parse(raw) as Partial<StoreData>;
    return {
      watchlist: Array.isArray(parsed.watchlist) ? parsed.watchlist : [],
      signals: Array.isArray(parsed.signals) ? parsed.signals : [],
    };
  } catch {
    return { watchlist: [], signals: [] };
  }
}

function save(data: StoreData): void {
  try {
    let serialised = JSON.stringify(data);
    // 64KB total guard — if we'd exceed it, drop oldest signals in batches
    if (serialised.length > MAX_BYTES) {
      // Trim signals in batches (drop 10% per iteration) until we fit
      while (data.signals.length > 0 && JSON.stringify(data).length > MAX_BYTES) {
        const trimCount = Math.max(1, Math.floor(data.signals.length * 0.1));
        data.signals.splice(0, trimCount);
      }
    }
    localStorage.setItem(STORE_KEY, JSON.stringify(data));
  } catch {
    // swallow — storage unavailable or quota exceeded
  }
}

// ── Watchlist CRUD ─────────────────────────────────────────────────────────────

/** Return the current watchlist. */
export function getWatchlist(): WatchlistEntry[] {
  return load().watchlist;
}

/** Add an entry to the watchlist. Dedupes by kind+value (case-insensitive). Returns new list. */
export function addWatchlistEntry(entry: WatchlistEntry): WatchlistEntry[] {
  const data = load();
  const normValue = entry.value.trim().toLowerCase();
  if (!normValue) return data.watchlist;
  // Dedupe
  const exists = data.watchlist.some(
    (e) => e.kind === entry.kind && e.value.trim().toLowerCase() === normValue
  );
  if (exists) return data.watchlist;
  // Cap at MAX_WATCHLIST
  const updated = [...data.watchlist, { kind: entry.kind, value: entry.value.trim() }];
  if (updated.length > MAX_WATCHLIST) updated.shift();
  data.watchlist = updated;
  save(data);
  return data.watchlist;
}

/** Remove a watchlist entry by kind+value. Returns new list. */
export function removeWatchlistEntry(kind: WatchlistEntry["kind"], value: string): WatchlistEntry[] {
  const data = load();
  const normValue = value.trim().toLowerCase();
  data.watchlist = data.watchlist.filter(
    (e) => !(e.kind === kind && e.value.trim().toLowerCase() === normValue)
  );
  save(data);
  return data.watchlist;
}

/** Clear the entire watchlist. */
export function clearWatchlist(): void {
  const data = load();
  data.watchlist = [];
  save(data);
}

// ── Engagement signals ─────────────────────────────────────────────────────────

/** Record an engagement signal. Caps at MAX_SIGNALS (drops oldest). */
export function recordEngagement(signal: EngagementSignal): void {
  const data = load();
  data.signals.push(signal);
  // Drop oldest if over cap
  if (data.signals.length > MAX_SIGNALS) {
    data.signals = data.signals.slice(data.signals.length - MAX_SIGNALS);
  }
  save(data);
}

/** Return all stored engagement signals. */
export function getSignals(): EngagementSignal[] {
  return load().signals;
}

/**
 * Build and return the EngagementMap consumed by the scorer.
 * Accepts optional event metadata for source/category lookup.
 */
export function engagementMap(
  events?: import("./types").WatchEvent[]
): EngagementMap {
  const signals = getSignals();
  return buildEngagementMap(signals, events);
}
