/**
 * source.ts — one market-data contract for deck surfaces.
 *
 * Routes each request by runtime:
 *   - Desktop (Tauri): market.rs typed commands (hardcoded hosts, browser UA,
 *     validation in Rust — stage-5 law; the desktop never touches a proxy).
 *   - Plain browser dev: the browser adapters in ./browser (Coinbase and
 *     Frankfurter direct — CORS-open; Yahoo via the existing corsproxy dev
 *     path). Identical shapes on both paths.
 *
 * Contract: every getter resolves with data or REJECTS — never resolves null.
 * Browser adapters return null on failure; that is converted to a thrown
 * Error here so callers have exactly one failure path (calm copy in the UI).
 */

import {
  marketBook,
  marketChart,
  marketCrypto,
  marketFx,
  marketTrades,
  type MarketBook,
  type MarketChart,
  type MarketCrypto,
  type MarketFx,
  type MarketTrade,
} from "../core";
import {
  fetchBookBrowser,
  fetchChartBrowser,
  fetchCryptoBrowser,
  fetchFxBrowser,
  fetchTradesBrowser,
} from "./browser";

/** Mirrors safeInvoke's detection (v2 injects __TAURI_INTERNALS__). */
function inTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

function orThrow<T>(v: T | null, what: string): T {
  if (v === null) throw new Error(`${what} did not answer`);
  return v;
}

/** Intraday chart for one symbol (fresh, fuller than the tape snapshot). */
export async function getChart(symbol: string, signal?: AbortSignal): Promise<MarketChart> {
  if (inTauri()) return marketChart(symbol);
  return orThrow(await fetchChartBrowser(symbol, signal), "the chart source");
}

/** Spot + 24h stats for one Coinbase product (BTC-USD / ETH-USD / SOL-USD). */
export async function getCrypto(product: string, signal?: AbortSignal): Promise<MarketCrypto> {
  if (inTauri()) return marketCrypto(product);
  return orThrow(await fetchCryptoBrowser(product, signal), "the crypto source");
}

/** Coinbase level-2 order book, truncated to `depth` rows per side. */
export async function getBook(product: string, depth: number, signal?: AbortSignal): Promise<MarketBook> {
  if (inTauri()) return marketBook(product, depth);
  return orThrow(await fetchBookBrowser(product, depth, signal), "the book source");
}

/** Coinbase recent trades (capped; `side` is the MAKER side — raw). */
export async function getTrades(product: string, signal?: AbortSignal): Promise<MarketTrade[]> {
  if (inTauri()) return marketTrades(product);
  return orThrow(await fetchTradesBrowser(product, signal), "the trades source");
}

/** Frankfurter daily FX rates (daily data — label it honestly). */
export async function getFx(base: string, symbols: string[], signal?: AbortSignal): Promise<MarketFx> {
  if (inTauri()) return marketFx(base, symbols);
  return orThrow(await fetchFxBrowser(base, symbols, signal), "the fx source");
}
