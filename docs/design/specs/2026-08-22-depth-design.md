# LOOM Phase 17 — Depth (design)

**Date:** 2026-08-22 · **Status:** approved for planning

## Problem

The Terminal and AGORA decks are empty. Root causes, diagnosed live:

1. **Terminal:** the Rust quote proxy sends no User-Agent; Yahoo's chart endpoint returns **429 without a browser UA, 200 with one** (verified by curl). Every desktop quote fails, so every panel renders empty — and the failure is silent, deck-wide.
2. **AGORA:** the deck is only an iframe dock; unless the owner's local AGORA app is running, the entire deck is one offline card.

Verified free, keyless sources: Yahoo chart (with browser UA), **Coinbase Exchange API** (ticker, 24h stats, level-2 book, trades — CORS-open, no key), **Frankfurter** (FX, no key). Stooq is dead (404). Binance.com geo-blocked (451).

## 1 · The market engine (Rust)

`src-tauri/src/market.rs` (absorbing/extending `quotes.rs`): typed commands only — no arbitrary-URL fetch. Every command validates symbols by regex, carries a browser UA, 10s timeout, and an allowlisted host:

- `market_chart(symbol)` — Yahoo v8 chart (UA fixed; `query2` host retry on 429).
- `market_crypto(product)` — Coinbase ticker + 24h stats merged.
- `market_book(product, depth)` — Coinbase level-2 top-N.
- `market_trades(product)` — Coinbase recent trades.
- `market_fx(base, symbols)` — Frankfurter latest.

Browser dev mode: Coinbase and Frankfurter are CORS-open (direct); Yahoo keeps the existing corsproxy dev path. The desktop never touches a third-party proxy (stage-5 law).

## 2 · Terminal — depth

- **Editable watchlist:** `terminal.symbols` setting (validated tickers, sensible defaults = today's list); add/remove inline in the movers table. The deck renders *your* tape.
- **Symbol detail:** click any row/card → a large intraday area chart (real chart data already fetched), open/high/low/prev-close/volume, delta; Esc/click-out closes.
- **Crypto strip:** BTC / ETH / SOL spot + 24h delta via Coinbase.
- **FX strip:** EUR/JPY/GBP vs USD via Frankfurter (daily — labeled honestly, not fake-live).
- **Honesty chrome:** per-source health dots (EQUITIES · CRYPTO · FX) with last-update age; per-panel error/stale states. An empty panel must say *why* — never silently blank.
- Lifecycle poller discipline unchanged (poll only while mounted; tape pauses when hidden).

## 3 · AGORA — the floor

When the local AGORA app is not reachable, the deck is no longer a lone card: **the floor** — a native LOOM exchange surface, keyless, live:

- **Order-book ladder:** Coinbase level-2, top ~12 bids/asks, size bars, mid + spread readout, 2s poll while mounted.
- **Trades tape:** recent trades, side-tinted (accent buys / danger sells), flowing.
- **Product switcher:** BTC-USD / ETH-USD / SOL-USD (chips; persisted `deck.agora.product`).
- The launch card (START, IGNITING, health strip) compresses to a strip above the floor; when local AGORA becomes reachable the iframe takes over exactly as today. The floor is LOOM's own — not a copy of AGORA.

## Non-goals

Keyed APIs, websockets (polling holds v1), order placement, historical databases, touching the AGORA repo.

## Testing

Rust: validation + parse per command (fixture JSON). TS: source adapters, panel states (fresh/stale/error/empty), watchlist edit, detail panel, floor ladder math (cumulative sizes, spread), product switch, poll lifecycle (fake timers, no leaks). Screenshot gate per stage-3 discipline. `npm run check` green per task.
