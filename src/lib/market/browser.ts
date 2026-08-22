/**
 * browser.ts — browser-dev fallbacks for the market engine.
 *
 * The desktop routes every market request through market.rs (typed commands,
 * hardcoded hosts, browser UA — stage-5 law). In plain-browser dev those
 * commands reject (ShellUnavailableError), so this module provides fetchers
 * that produce the SAME shapes as market.rs:
 *
 *   - Coinbase Exchange + Frankfurter: direct fetch (both CORS-open, verified).
 *   - Yahoo chart: the existing corsproxy dev path only (via quoteUrl —
 *     Yahoo-direct inside the Tauri webview, corsproxy in the plain browser).
 *
 * Validation mirrors market.rs and runs BEFORE any request; every fetcher
 * carries a 10s timeout (timeoutSignal) and returns null on any failure —
 * never throws. Normalizers are pure and exported for tests.
 */

import type { MarketBook, MarketChart, MarketCrypto, MarketFx, MarketTrade } from "../core";
import { quoteUrl } from "../terminal/quotes";
import { timeoutSignal } from "../util/timeoutSignal";

// ── Constants (mirror market.rs) ────────────────────────────────────────────

const COINBASE = "https://api.exchange.coinbase.com";
const FRANKFURTER = "https://api.frankfurter.dev";
const REQUEST_TIMEOUT_MS = 10_000;
const TRADES_CAP = 30;
const DEPTH_MIN = 1;
const DEPTH_MAX = 50;

/** Coinbase products LOOM will ever ask for (mirror of market.rs). */
export const PRODUCT_WHITELIST = ["BTC-USD", "ETH-USD", "SOL-USD"] as const;

// ── Validation (mirror market.rs — runs before any request) ─────────────────

/** Equity/index/future symbol: `^[A-Z0-9.^=-]{1,12}$`. */
export function isValidSymbol(s: string): boolean {
  return /^[A-Z0-9.^=-]{1,12}$/.test(s);
}

/** Coinbase product: whitelist membership AND `^[A-Z]{2,6}-USD$` shape. */
export function isValidProduct(p: string): boolean {
  return (PRODUCT_WHITELIST as readonly string[]).includes(p) && /^[A-Z]{2,6}-USD$/.test(p);
}

/** ISO currency code: `^[A-Z]{3}$`. */
export function isValidFxCode(c: string): boolean {
  return /^[A-Z]{3}$/.test(c);
}

/** Clamp a requested book depth into [1, 50]. */
export function clampDepth(depth: number): number {
  if (!Number.isFinite(depth)) return DEPTH_MIN;
  return Math.min(DEPTH_MAX, Math.max(DEPTH_MIN, Math.floor(depth)));
}

// ── Pure normalizers (same shapes as market.rs; unit-tested directly) ───────

/** Coinbase serializes numbers as strings; Yahoo as numbers. Accept both. */
function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number.parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

function seriesOf(quote: Record<string, unknown> | undefined, key: string): Array<number | null> {
  const arr = quote?.[key];
  return Array.isArray(arr) ? arr.map((v) => num(v)) : [];
}

/** Normalize one Yahoo /v8/chart body into a MarketChart, or null. */
export function normalizeChart(symbol: string, body: unknown): MarketChart | null {
  const result = (body as { chart?: { result?: unknown[] } })?.chart?.result?.[0] as
    | {
        meta?: Record<string, unknown>;
        timestamp?: unknown[];
        indicators?: { quote?: Array<Record<string, unknown>> };
      }
    | undefined;
  const meta = result?.meta;
  const price = num(meta?.regularMarketPrice);
  if (!meta || price === null) return null;

  // Mirror market.rs: chartPreviousClose → previousClose → price; 0 → price.
  const prevRaw = num(meta.chartPreviousClose) ?? num(meta.previousClose);
  const prevClose = prevRaw !== null && prevRaw !== 0 ? prevRaw : price;
  const name = typeof meta.shortName === "string" && meta.shortName ? meta.shortName : null;

  const quote = result?.indicators?.quote?.[0];
  const rawCloses = seriesOf(quote, "close");
  const rawTs = Array.isArray(result?.timestamp) ? result.timestamp : [];

  // Pairwise: keep only slots where close is finite AND a timestamp exists.
  const closes: number[] = [];
  const timestamps: number[] = [];
  rawCloses.forEach((c, i) => {
    const t = rawTs[i];
    if (c !== null && typeof t === "number" && Number.isFinite(t)) {
      closes.push(c);
      timestamps.push(t);
    }
  });

  const finite = (xs: Array<number | null>) => xs.filter((v): v is number => v !== null);
  const opens = finite(seriesOf(quote, "open"));
  const highs = finite(seriesOf(quote, "high"));
  const lows = finite(seriesOf(quote, "low"));
  const volumes = finite(seriesOf(quote, "volume"));

  return {
    symbol,
    name,
    price,
    prevClose,
    open: opens.length ? opens[0] : null,
    high: highs.length ? Math.max(...highs) : null,
    low: lows.length ? Math.min(...lows) : null,
    volume: volumes.length ? volumes.reduce((a, b) => a + b, 0) : null,
    closes,
    timestamps,
  };
}

/**
 * Merge Coinbase /ticker + /stats into a MarketCrypto, or null when the ticker
 * has no price. Stats fields degrade to null (a stats failure must not kill spot).
 */
export function normalizeCrypto(product: string, ticker: unknown, stats: unknown): MarketCrypto | null {
  const t = (ticker ?? {}) as Record<string, unknown>;
  const s = (stats ?? {}) as Record<string, unknown>;
  const price = num(t.price);
  if (price === null) return null;
  const open24h = num(s.open);
  return {
    product,
    price,
    bid: num(t.bid),
    ask: num(t.ask),
    open24h,
    high24h: num(s.high),
    low24h: num(s.low),
    volume24h: num(s.volume),
    changePct24h: open24h !== null && open24h !== 0 ? ((price - open24h) / open24h) * 100 : null,
    time: typeof t.time === "string" ? t.time : null,
  };
}

/** One level-2 row: ["price", "size", num_orders]. Malformed rows are skipped. */
function normalizeLevel(row: unknown): { price: number; size: number } | null {
  if (!Array.isArray(row)) return null;
  const price = num(row[0]);
  const size = num(row[1]);
  return price !== null && size !== null ? { price, size } : null;
}

/** Truncate a Coinbase level-2 book to `depth` rows per side, or null. */
export function normalizeBook(product: string, body: unknown, depth: number): MarketBook | null {
  const b = (body ?? {}) as { bids?: unknown; asks?: unknown };
  if (!Array.isArray(b.bids) && !Array.isArray(b.asks)) return null;
  const side = (rows: unknown) =>
    Array.isArray(rows)
      ? rows.map(normalizeLevel).filter((l): l is { price: number; size: number } => l !== null).slice(0, depth)
      : [];
  return { product, bids: side(b.bids), asks: side(b.asks) };
}

/** Cap Coinbase recent trades at TRADES_CAP; malformed rows are skipped. */
export function normalizeTrades(body: unknown): MarketTrade[] | null {
  if (!Array.isArray(body)) return null;
  const out: MarketTrade[] = [];
  for (const r of body) {
    if (out.length >= TRADES_CAP) break;
    const row = (r ?? {}) as Record<string, unknown>;
    const price = num(row.price);
    const size = num(row.size);
    if (
      typeof row.trade_id === "number" &&
      typeof row.time === "string" &&
      typeof row.side === "string" &&
      price !== null &&
      size !== null
    ) {
      out.push({ tradeId: row.trade_id, time: row.time, price, size, side: row.side });
    }
  }
  return out;
}

/** Normalize a Frankfurter /v1/latest body, or null. */
export function normalizeFx(body: unknown): MarketFx | null {
  const b = (body ?? {}) as { base?: unknown; date?: unknown; rates?: unknown };
  if (typeof b.base !== "string" || typeof b.date !== "string") return null;
  if (typeof b.rates !== "object" || b.rates === null || Array.isArray(b.rates)) return null;
  const rates: Record<string, number> = {};
  for (const [code, v] of Object.entries(b.rates as Record<string, unknown>)) {
    const n = num(v);
    if (n !== null) rates[code] = n;
  }
  return { base: b.base, date: b.date, rates };
}

// ── Fetch plumbing ──────────────────────────────────────────────────────────

/** Per-request 10s timeout combined with an optional external signal. */
function combinedSignal(signal?: AbortSignal): AbortSignal {
  const timeout = timeoutSignal(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

/** GET JSON, or null on any failure (network, HTTP, parse). Never throws. */
async function getJson(url: string, signal?: AbortSignal): Promise<unknown | null> {
  try {
    const r = await fetch(url, { signal: combinedSignal(signal) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// ── Browser fetchers (same shapes as the market.rs commands) ────────────────

/** Yahoo chart via the existing dev path (quoteUrl: direct in Tauri, corsproxy in browser). */
export async function fetchChartBrowser(symbol: string, signal?: AbortSignal): Promise<MarketChart | null> {
  if (!isValidSymbol(symbol)) return null;
  const body = await getJson(quoteUrl(symbol), signal);
  return body === null ? null : normalizeChart(symbol, body);
}

/** Coinbase ticker + stats, direct (CORS-open). Ticker required, stats optional. */
export async function fetchCryptoBrowser(product: string, signal?: AbortSignal): Promise<MarketCrypto | null> {
  if (!isValidProduct(product)) return null;
  const [ticker, stats] = await Promise.all([
    getJson(`${COINBASE}/products/${product}/ticker`, signal),
    getJson(`${COINBASE}/products/${product}/stats`, signal),
  ]);
  if (ticker === null) return null;
  return normalizeCrypto(product, ticker, stats);
}

/** Coinbase level-2 book, direct (CORS-open), truncated to `depth` per side. */
export async function fetchBookBrowser(product: string, depth: number, signal?: AbortSignal): Promise<MarketBook | null> {
  if (!isValidProduct(product)) return null;
  const body = await getJson(`${COINBASE}/products/${product}/book?level=2`, signal);
  return body === null ? null : normalizeBook(product, body, clampDepth(depth));
}

/** Coinbase recent trades, direct (CORS-open), capped at 30. */
export async function fetchTradesBrowser(product: string, signal?: AbortSignal): Promise<MarketTrade[] | null> {
  if (!isValidProduct(product)) return null;
  const body = await getJson(`${COINBASE}/products/${product}/trades`, signal);
  return body === null ? null : normalizeTrades(body);
}

/** Frankfurter latest daily rates, direct (CORS-open). */
export async function fetchFxBrowser(base: string, symbols: string[], signal?: AbortSignal): Promise<MarketFx | null> {
  if (!isValidFxCode(base) || symbols.length === 0 || !symbols.every(isValidFxCode)) return null;
  const body = await getJson(`${FRANKFURTER}/v1/latest?base=${base}&symbols=${symbols.join(",")}`, signal);
  return body === null ? null : normalizeFx(body);
}
