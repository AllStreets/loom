/**
 * quotes.ts — keyless market-quote fetcher + 60s poll runtime for the Terminal deck.
 *
 * Endpoint (keyless; in Tauri production webview Yahoo CORS headers are not
 * enforced so the request hits Yahoo direct; in plain browser dev mode the
 * request is proxied through corsproxy.io carrying only ticker symbols):
 *   https://query1.finance.yahoo.com/v8/finance/chart/<SYMBOL>?interval=15m&range=1d
 *
 * Response shape (relevant fields):
 *   { chart: { result: [ { meta: { symbol, regularMarketPrice,
 *       chartPreviousClose, previousClose, shortName },
 *       indicators: { quote: [ { close: number[] } ] } } ] } }
 *
 * One request per symbol (Yahoo's multi-quote /v7/finance/quote endpoint now
 * requires a crumb; the /v8/chart endpoint stays keyless). Requests run in
 * parallel via Promise.allSettled so one hanging symbol never blocks the rest.
 *
 * Fetch routing:
 *   - Desktop (Tauri present): quotes flow through LOOM's own Rust via
 *     `quoteFetch` (quotes::quote_fetch command). Third-party corsproxy dead
 *     in the desktop product.
 *   - Browser dev: existing Yahoo-direct → corsproxy chain UNCHANGED (dev-only).
 *
 * The poll runtime runs ONLY while the terminal deck is active: TerminalDeck
 * calls startQuotes() on mount and stopQuotes() on unmount. There is no global
 * autostart — no background burn.
 *
 * Failure policy: a failed poll keeps the last-known snapshot and flips the
 * `stale` flag; getQuotes() never returns blank once it has data. A
 * `loom-quotes` CustomEvent fires on each SUCCESSFUL poll (fresh data). It also
 * fires once when the stale flag flips (first failure after a run of successes)
 * so the UI can degrade gracefully.
 */

import { quoteFetch } from "../core";
import { timeoutSignal } from "../util/timeoutSignal";

export interface Quote {
  symbol: string;
  /** Human label from the endpoint when present (meta.shortName). */
  name?: string;
  price: number;
  /** Absolute change vs previous close. */
  chg: number;
  /** Percent change vs previous close. */
  chgPct: number;
  /** Intraday close series when the endpoint provides it (for sparklines). */
  spark?: number[];
}

export interface QuotesSnapshot {
  quotes: Quote[];
  /** True when the last poll failed and we are serving the previous snapshot. */
  stale: boolean;
  /** Epoch ms of the last SUCCESSFUL poll (0 before the first success). */
  updatedAt: number;
}

/**
 * The tape's universe. Order is intentional: indices, then mega-cap equities,
 * then macro (VIX / 10Y yield / gold / oil / bitcoin). TerminalDeck slices by
 * membership sets below rather than re-listing symbols.
 */
export const INDEX_SYMBOLS = ["SPY", "QQQ", "DIA", "IWM"] as const;
export const EQUITY_SYMBOLS = [
  "AAPL",
  "MSFT",
  "NVDA",
  "GOOGL",
  "AMZN",
  "META",
  "TSLA",
] as const;
export const MACRO_SYMBOLS = ["^VIX", "^TNX", "GC=F", "CL=F", "BTC-USD"] as const;

export const SYMBOLS: readonly string[] = [
  ...INDEX_SYMBOLS,
  ...EQUITY_SYMBOLS,
  ...MACRO_SYMBOLS,
];

/** Human labels for symbols the endpoint may not name cleanly. */
export const SYMBOL_LABELS: Record<string, string> = {
  SPY: "S&P 500",
  QQQ: "NASDAQ 100",
  DIA: "DOW 30",
  IWM: "RUSSELL 2K",
  "^VIX": "VIX",
  "^TNX": "10Y YIELD",
  "GC=F": "GOLD",
  "CL=F": "CRUDE OIL",
  "BTC-USD": "BITCOIN",
};

const ENDPOINT = "https://query1.finance.yahoo.com/v8/finance/chart";
const REQUEST_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 60_000;

// Yahoo's keyless /v8/chart endpoint returns NO CORS headers, so a raw browser
// fetch is blocked (verified: "Failed to fetch"). Two runtimes:
//   • Tauri production webview — no browser CORS enforcement → fetch Yahoo direct.
//   • Plain browser (dev + any web deploy) — route through a keyless CORS proxy
//     that echoes the exact Yahoo JSON body (verified: full meta + intraday
//     indicators preserved). This keeps the deck live everywhere, keyless.
// AUSPEX's ui.js hits Yahoo directly because it ships inside the Tauri webview;
// LOOM's kernel deck must also work in the browser, hence the proxy fallback.
const CORS_PROXY = "https://corsproxy.io/?url=";

/** True when running inside the Tauri desktop webview (direct Yahoo works). */
function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI__" in window;
}

/** Build the fetch URL for a symbol, proxying in the browser. */
export function quoteUrl(symbol: string): string {
  const yahoo = `${ENDPOINT}/${encodeURIComponent(symbol)}?interval=15m&range=1d`;
  return inTauri() ? yahoo : `${CORS_PROXY}${encodeURIComponent(yahoo)}`;
}

// ── Pure normalizer (unit-tested directly) ──────────────────────────────────

/**
 * Normalize one Yahoo /v8/chart response body into a Quote, or null when the
 * body is missing the fields we require (no price → not a usable quote).
 *
 * `symbol` is passed alongside because the display symbol we want (e.g. "^VIX")
 * is what we requested, not necessarily meta.symbol's exact form.
 */
export function normalizeQuote(symbol: string, body: unknown): Quote | null {
  const result = (body as { chart?: { result?: unknown[] } })?.chart?.result?.[0] as
    | {
        meta?: {
          regularMarketPrice?: number;
          chartPreviousClose?: number;
          previousClose?: number;
          shortName?: string;
        };
        indicators?: { quote?: Array<{ close?: Array<number | null> }> };
      }
    | undefined;

  const meta = result?.meta;
  const price = meta?.regularMarketPrice;
  if (!meta || typeof price !== "number" || !Number.isFinite(price)) return null;

  const prevRaw = meta.chartPreviousClose ?? meta.previousClose ?? price;
  const prev = typeof prevRaw === "number" && Number.isFinite(prevRaw) && prevRaw !== 0 ? prevRaw : price;
  const chg = price - prev;
  const chgPct = prev !== 0 ? (chg / prev) * 100 : 0;

  const closes = result?.indicators?.quote?.[0]?.close;
  let spark: number[] | undefined;
  if (Array.isArray(closes)) {
    const clean = closes.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (clean.length >= 2) spark = clean;
  }

  const name = typeof meta.shortName === "string" && meta.shortName ? meta.shortName : undefined;

  return { symbol, name, price, chg, chgPct, spark };
}

// ── Single-symbol fetch ─────────────────────────────────────────────────────

/**
 * Fetch and normalize one symbol. Returns null on any failure (network, HTTP,
 * shape). Honours the provided AbortSignal AND its own 10s timeout.
 */
export async function fetchQuote(symbol: string, signal?: AbortSignal): Promise<Quote | null> {
  const timeout = timeoutSignal(REQUEST_TIMEOUT_MS);
  // Combine our per-request timeout with any external (deck-unmount) signal.
  // AbortSignal.any avoids one addEventListener per fetch on a shared parent
  // signal (which triggered a MaxListeners warning under the 16-symbol fan-out).
  const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
  try {
    const r = await fetch(quoteUrl(symbol), { signal: combined });
    if (!r.ok) return null;
    const body = await r.json();
    return normalizeQuote(symbol, body);
  } catch {
    return null;
  }
}

/**
 * Fetch all SYMBOLS via LOOM's own Rust proxy (Tauri path).
 * Parses the array returned by quotes::quote_fetch into Quote objects using
 * the existing normalizer. Returns empty array on any failure.
 */
async function fetchAllQuotesTauri(): Promise<Quote[]> {
  try {
    const raw = await quoteFetch([...SYMBOLS]);
    const arr: Array<{ symbol: string; body: unknown }> = JSON.parse(raw);
    const out: Quote[] = [];
    for (const entry of arr) {
      if (entry.body !== null && entry.body !== undefined) {
        const q = normalizeQuote(entry.symbol, entry.body);
        if (q) out.push(q);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Fetch all SYMBOLS. Routes through LOOM's own Rust when inside Tauri (killing
 * the third-party corsproxy dependency in the desktop product); falls back to
 * the browser fetch chain (Yahoo-direct → corsproxy) in dev. // dev-only
 * Preserves SYMBOLS order in the returned array, dropping any symbol that
 * failed. Never throws.
 */
export async function fetchAllQuotes(signal?: AbortSignal): Promise<Quote[]> {
  if (inTauri()) {
    // Desktop: quotes flow through LOOM's Rust — third-party proxy dead here.
    return fetchAllQuotesTauri();
  }
  // dev-only: browser fetch chain (Yahoo-direct in webview, corsproxy in plain browser)
  const settled = await Promise.allSettled(SYMBOLS.map((s) => fetchQuote(s, signal)));
  const out: Quote[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled" && r.value) out.push(r.value);
  }
  return out;
}

// ── Poll runtime (module state) ─────────────────────────────────────────────

let intervalId: ReturnType<typeof setInterval> | null = null;
let inFlight = false;
let abortCtrl: AbortController | null = null;
let started = false;
let snapshot: QuotesSnapshot = { quotes: [], stale: false, updatedAt: 0 };

/** Synchronous read of the current snapshot. */
export function getQuotes(): QuotesSnapshot {
  return snapshot;
}

function emit() {
  window.dispatchEvent(new CustomEvent<QuotesSnapshot>("loom-quotes", { detail: snapshot }));
}

async function poll(): Promise<void> {
  if (inFlight) return; // in-flight guard — no overlapping polls
  inFlight = true;
  abortCtrl = new AbortController();
  try {
    const quotes = await fetchAllQuotes(abortCtrl.signal);
    if (quotes.length > 0) {
      // Success — replace snapshot, clear stale.
      snapshot = { quotes, stale: false, updatedAt: Date.now() };
      emit();
    } else {
      // Total failure — keep last quotes, flip stale (only emit on a change).
      if (!snapshot.stale && snapshot.quotes.length > 0) {
        snapshot = { ...snapshot, stale: true };
        emit();
      } else if (snapshot.quotes.length === 0 && !snapshot.stale) {
        // Nothing yet AND nothing came back — mark stale so the UI can explain.
        snapshot = { ...snapshot, stale: true };
        emit();
      }
    }
  } finally {
    inFlight = false;
    abortCtrl = null;
  }
}

function onVisibilityChange() {
  if (typeof document === "undefined") return;
  if (document.hidden) {
    pausePolling();
  } else if (intervalId === null && started) {
    resumePolling();
  }
}

function pausePolling() {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
  // Abort any in-flight request so a hidden tab doesn't hold a socket open.
  abortCtrl?.abort();
}

function resumePolling() {
  if (intervalId !== null) return;
  void poll();
  intervalId = setInterval(() => { void poll(); }, POLL_INTERVAL_MS);
}

/**
 * Start the quotes poller. Idempotent. Called by TerminalDeck on mount.
 * First poll fires immediately unless the document is hidden.
 */
export function startQuotes(): void {
  if (started) return;
  started = true;

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange, { passive: true });
  }

  if (typeof document !== "undefined" && document.hidden) {
    return; // start paused; resume on visibility
  }

  void poll();
  intervalId = setInterval(() => { void poll(); }, POLL_INTERVAL_MS);
}

/**
 * Stop the quotes poller. Idempotent. Called by TerminalDeck on unmount.
 * Snapshot is retained so a re-mount shows last-known data immediately.
 */
export function stopQuotes(): void {
  if (!started) return;
  started = false;

  if (typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", onVisibilityChange);
  }

  pausePolling();
  inFlight = false;
}

/** True while the poller is running (test/introspection helper). */
export function isPolling(): boolean {
  return started && intervalId !== null;
}

/** Reset ALL module state — test isolation only. */
export function _resetQuotesForTests(): void {
  pausePolling();
  started = false;
  inFlight = false;
  abortCtrl = null;
  snapshot = { quotes: [], stale: false, updatedAt: 0 };
  if (typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", onVisibilityChange);
  }
}
