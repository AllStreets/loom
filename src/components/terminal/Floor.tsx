/**
 * Floor.tsx — THE FLOOR: LOOM's native exchange surface for one crypto product.
 *
 * Order-book ladder (12/side, cumulative depth bars, mid + spread bps), trades
 * tape (taker-side tinted), and a spot + 24h Δ% header — all on keyless
 * Coinbase data through the market source facade. Lives inside the Terminal's
 * crypto detail overlay: the clicked CRYPTO-strip symbol IS the product.
 *
 * Poll discipline (usePoll — shared with the Terminal strips): every poll is
 * mount-bound, pauses while document.hidden, and dies with the floor — the
 * moment the overlay closes the floor unmounts and ALL polls stop. Per-panel
 * failures state themselves calmly and keep polling (the poll IS the retry) —
 * the floor is never blank.
 */
import { useState, useCallback, useMemo } from "react";
import type { CSSProperties } from "react";
import { usePoll } from "../../lib/util/usePoll";
import { getBook, getCrypto, getTrades } from "../../lib/market/source";
import type { BookLevel, MarketBook, MarketCrypto, MarketTrade } from "../../lib/core";

// ── Constants + pure helpers (exported for tests) ────────────────────────────

// Poll cadences. Coinbase's public rate limit is ~10 req/s/IP. Worst case
// here: book 1/2s (0.50 req/s) + trades 1/3s (0.33 req/s) + spot 1/30s
// (ticker + stats = 2 requests on the browser path → 0.07 req/s) ≈ 0.9 req/s
// — an order of magnitude under the limit, and every poll stops the moment
// the floor unmounts or the document hides (usePoll discipline).
export const BOOK_POLL_MS = 2_000;
export const TRADES_POLL_MS = 3_000;
const SPOT_POLL_MS = 30_000;
const BOOK_DEPTH = 12;
const TAPE_ROWS = 20;

export type CumLevel = BookLevel & { cum: number };

/** Running cumulative size in the given (best-first) order. */
export function cumulate(levels: BookLevel[]): CumLevel[] {
  let run = 0;
  return levels.map((l) => {
    run += l.size;
    return { ...l, cum: run };
  });
}

/** Mid + spread (abs and bps) from the top of the book, or null when one-sided. */
export function bookStats(
  book: MarketBook | null
): { mid: number; spreadAbs: number; spreadBps: number } | null {
  const bid = book?.bids[0]?.price;
  const ask = book?.asks[0]?.price;
  if (bid === undefined || ask === undefined) return null;
  const mid = (bid + ask) / 2;
  if (mid === 0) return null;
  return { mid, spreadAbs: ask - bid, spreadBps: ((ask - bid) / mid) * 10_000 };
}

/**
 * Coinbase Exchange trade `side` is the MAKER side (verified against the
 * Exchange API docs): side:"buy" means the resting order was a buy, so the
 * taker SOLD into it — a down-tick; side:"sell" means the maker was selling,
 * so the taker BOUGHT — an up-tick. The tape tints by TAKER side, because the
 * aggressor is the story: accent = taker bought, danger = taker sold.
 */
export function takerSide(makerSide: string): "buy" | "sell" {
  return makerSide === "buy" ? "sell" : "buy";
}

/** ISO timestamp → local HH:MM:SS (the tape's clock). */
export function fmtTradeTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Exchange-grade price: thousands-separated, 2dp (4dp under a dollar). */
export function fmtFloorPrice(v: number): string {
  if (Math.abs(v) < 1) return v.toFixed(4);
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Order/trade size: coarse above 1k, fine below. */
export function fmtFloorSize(v: number): string {
  if (v >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (v >= 10) return v.toFixed(2);
  return v.toFixed(4);
}

function fmtPct(v: number): string {
  return (v >= 0 ? "+" : "-") + Math.abs(v).toFixed(2) + "%";
}

// ── Styles (tokens only) ─────────────────────────────────────────────────────

const MONO_LABEL: CSSProperties = {
  fontFamily: "var(--f-mono, monospace)",
  fontSize: 10,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: "var(--t3)",
};

const FLOOR_PANEL: CSSProperties = {
  // Near-opaque navy — a DATA surface (same discipline as the Terminal), so
  // the orb band's glow doesn't wash out the tabular numbers underneath.
  background: "rgba(9,15,29,0.96)",
  border: "1px solid var(--line)",
  borderRadius: 10,
  padding: 12,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  minHeight: 0,
  overflow: "hidden",
};

const NUM: CSSProperties = {
  fontFamily: "var(--f-mono, monospace)",
  fontVariantNumeric: "tabular-nums",
  fontSize: 11,
  textAlign: "right",
};

/** Calm per-panel copy — the poll keeps running underneath (the poll IS the retry). */
function PanelCopy({ id, children }: { id: string; children: string }) {
  return (
    <div
      data-testid={id}
      style={{
        fontFamily: "var(--f-mono, monospace)",
        fontSize: 11,
        color: "var(--t3)",
        lineHeight: 1.5,
        padding: "6px 0",
      }}
    >
      {children}
    </div>
  );
}

type PanelState<T> = { data: T | null; error: boolean };

// ── Sub-surfaces ─────────────────────────────────────────────────────────────

function LadderRow({
  side,
  level,
  maxCum,
}: {
  side: "bid" | "ask";
  level: CumLevel;
  maxCum: number;
}) {
  const pct = maxCum > 0 ? Math.min(100, (level.cum / maxCum) * 100) : 0;
  return (
    <div
      data-testid={`floor-${side}-row`}
      style={{
        position: "relative",
        display: "grid",
        gridTemplateColumns: "1fr 1fr 1fr",
        gap: 8,
        padding: "1px 6px",
        lineHeight: "16px",
      }}
    >
      <div
        aria-hidden
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          right: 0,
          width: `${pct}%`,
          // Cumulative-depth bar, max-normalized per side. Token-derived washes:
          // accent for bids, danger for asks — accent means alive, danger means offers.
          background:
            side === "bid"
              ? "var(--accent-soft)"
              : "color-mix(in srgb, var(--danger) 12%, transparent)",
          borderRadius: 2,
          pointerEvents: "none",
        }}
      />
      <span style={{ ...NUM, color: side === "bid" ? "var(--accent)" : "var(--danger)", position: "relative" }}>
        {fmtFloorPrice(level.price)}
      </span>
      <span style={{ ...NUM, color: "var(--t2)", position: "relative" }}>{fmtFloorSize(level.size)}</span>
      <span style={{ ...NUM, color: "var(--t3)", position: "relative" }}>{fmtFloorSize(level.cum)}</span>
    </div>
  );
}

interface FloorProps {
  /** Coinbase product id, e.g. "BTC-USD" — the clicked crypto-strip symbol. */
  product: string;
}

/**
 * THE FLOOR — order-book ladder + trades tape + spot readout for one product.
 * Mount it only while its overlay is open: every poll starts on mount and
 * stops dead on unmount (usePoll cleanup) — no background floor polls, ever.
 */
export default function Floor({ product }: FloorProps) {
  const [book, setBook] = useState<PanelState<MarketBook>>({ data: null, error: false });
  const [trades, setTrades] = useState<PanelState<MarketTrade[]>>({ data: null, error: false });
  const [spot, setSpot] = useState<PanelState<MarketCrypto>>({ data: null, error: false });

  const tickBook = useCallback(
    async (signal: AbortSignal) => {
      try {
        const b = await getBook(product, BOOK_DEPTH, signal);
        if (!signal.aborted) setBook({ data: b, error: false });
      } catch {
        if (!signal.aborted) setBook((s) => ({ ...s, error: true }));
      }
    },
    [product]
  );
  usePoll(tickBook, BOOK_POLL_MS);

  const tickTrades = useCallback(
    async (signal: AbortSignal) => {
      try {
        const t = await getTrades(product, signal);
        if (!signal.aborted) setTrades({ data: t, error: false });
      } catch {
        if (!signal.aborted) setTrades((s) => ({ ...s, error: true }));
      }
    },
    [product]
  );
  usePoll(tickTrades, TRADES_POLL_MS);

  const tickSpot = useCallback(
    async (signal: AbortSignal) => {
      try {
        const c = await getCrypto(product, signal);
        if (!signal.aborted) setSpot({ data: c, error: false });
      } catch {
        if (!signal.aborted) setSpot((s) => ({ ...s, error: true }));
      }
    },
    [product]
  );
  usePoll(tickSpot, SPOT_POLL_MS);

  const bids = useMemo(() => cumulate(book.data?.bids ?? []), [book.data]);
  const asks = useMemo(() => cumulate(book.data?.asks ?? []), [book.data]);
  const maxBidCum = bids.length ? bids[bids.length - 1].cum : 0;
  const maxAskCum = asks.length ? asks[asks.length - 1].cum : 0;
  const stats = bookStats(book.data);
  // Coinbase returns trades newest-first — keep that order, cap the tape.
  const tape = (trades.data ?? []).slice(0, TAPE_ROWS);

  return (
    <div
      data-testid="floor"
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      {/* Header: spot / 24h Δ% / mid / spread readout */}
      <div
        style={{
          display: "flex",
          gap: 16,
          alignItems: "baseline",
          flexWrap: "wrap",
        }}
      >
        <span style={MONO_LABEL}>SPOT</span>
        <span
          data-testid="floor-spot"
          style={{ ...NUM, fontSize: 14, color: "var(--t1)" }}
        >
          {spot.data ? fmtFloorPrice(spot.data.price) : "—"}
        </span>
        <span
          data-testid="floor-delta"
          style={{
            ...NUM,
            fontSize: 12,
            color:
              spot.data?.changePct24h == null
                ? "var(--t3)"
                : spot.data.changePct24h >= 0
                ? "var(--go)"
                : "var(--danger)",
          }}
        >
          {spot.data?.changePct24h == null ? "24H —" : `24H ${fmtPct(spot.data.changePct24h)}`}
        </span>
        <span style={MONO_LABEL}>MID</span>
        <span data-testid="floor-mid" style={{ ...NUM, fontSize: 12, color: "var(--t1)" }}>
          {stats ? fmtFloorPrice(stats.mid) : "—"}
        </span>
        <span style={MONO_LABEL}>SPREAD</span>
        <span data-testid="floor-spread" style={{ ...NUM, fontSize: 12, color: "var(--t2)" }}>
          {stats ? `${fmtFloorPrice(stats.spreadAbs)} · ${stats.spreadBps.toFixed(1)}bps` : "—"}
        </span>
        {spot.error && <PanelCopy id="floor-spot-copy">the ticker is dark — retrying</PanelCopy>}
      </div>

      {/* Ladder + tape */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 3fr) minmax(0, 2fr)",
          gap: 10,
          flex: 1,
          minHeight: 0,
        }}
      >
        {/* Order-book ladder: asks stacked above (danger), bids below (accent). */}
        <div data-testid="floor-book" style={FLOOR_PANEL}>
          <div style={MONO_LABEL}>THE BOOK — {product}</div>
          {book.error && <PanelCopy id="floor-book-copy">the book is dark — retrying</PanelCopy>}
          {!book.error && !book.data && (
            <PanelCopy id="floor-book-copy">waiting for the book</PanelCopy>
          )}
          {book.data && (
            <div style={{ display: "flex", flexDirection: "column", gap: 2, minHeight: 0, overflow: "hidden" }}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr 1fr",
                  gap: 8,
                  padding: "0 6px",
                }}
              >
                <span style={{ ...MONO_LABEL, textAlign: "right" }}>PRICE</span>
                <span style={{ ...MONO_LABEL, textAlign: "right" }}>SIZE</span>
                <span style={{ ...MONO_LABEL, textAlign: "right" }}>CUM</span>
              </div>
              {/* Asks best-at-bottom so the touch sits at the mid line. */}
              {[...asks].reverse().map((l) => (
                <LadderRow key={`a${l.price}`} side="ask" level={l} maxCum={maxAskCum} />
              ))}
              <div
                style={{
                  display: "flex",
                  justifyContent: "center",
                  gap: 10,
                  padding: "3px 0",
                  borderTop: "1px solid var(--line)",
                  borderBottom: "1px solid var(--line)",
                }}
              >
                <span style={MONO_LABEL}>MID {stats ? fmtFloorPrice(stats.mid) : "—"}</span>
                <span style={MONO_LABEL}>
                  SPREAD {stats ? `${fmtFloorPrice(stats.spreadAbs)} · ${stats.spreadBps.toFixed(1)}bps` : "—"}
                </span>
              </div>
              {bids.map((l) => (
                <LadderRow key={`b${l.price}`} side="bid" level={l} maxCum={maxBidCum} />
              ))}
            </div>
          )}
        </div>

        {/* Trades tape: newest first, tinted by TAKER side (see takerSide). */}
        <div data-testid="floor-tape" style={FLOOR_PANEL}>
          <div style={MONO_LABEL}>THE TAPE — {product}</div>
          {trades.error && <PanelCopy id="floor-tape-copy">the tape is dark — retrying</PanelCopy>}
          {!trades.error && !trades.data && (
            <PanelCopy id="floor-tape-copy">waiting for the tape</PanelCopy>
          )}
          {trades.data && (
            <div style={{ display: "flex", flexDirection: "column", gap: 2, minHeight: 0, overflow: "hidden" }}>
              <div
                style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, padding: "0 6px" }}
              >
                <span style={{ ...MONO_LABEL, textAlign: "right" }}>TIME</span>
                <span style={{ ...MONO_LABEL, textAlign: "right" }}>PRICE</span>
                <span style={{ ...MONO_LABEL, textAlign: "right" }}>SIZE</span>
              </div>
              {tape.map((t) => {
                const taker = takerSide(t.side);
                return (
                  <div
                    key={t.tradeId}
                    data-testid="floor-trade-row"
                    data-side={taker}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr 1fr",
                      gap: 8,
                      padding: "1px 6px",
                      lineHeight: "16px",
                    }}
                  >
                    <span style={{ ...NUM, color: "var(--t3)" }}>{fmtTradeTime(t.time)}</span>
                    <span
                      style={{ ...NUM, color: taker === "buy" ? "var(--accent)" : "var(--danger)" }}
                    >
                      {fmtFloorPrice(t.price)}
                    </span>
                    <span style={{ ...NUM, color: "var(--t2)" }}>{fmtFloorSize(t.size)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
