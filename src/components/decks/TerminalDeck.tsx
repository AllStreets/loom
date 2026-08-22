/**
 * TerminalDeck.tsx — the Terminal deck: a Bloomberg-grade markets surface.
 *
 * A KERNEL deck (not an organ). Full-bleed dark surface under the orb band,
 * mounted by DeckLayer when cockpit.deck === "terminal". It drives the quotes
 * poller by its own lifecycle: startQuotes() on mount, stopQuotes() on unmount
 * — so there is NO background market polling while another deck is active.
 * The crypto and FX polls follow the same discipline (usePoll — shared hook in
 * lib/util/usePoll): start on mount, stop on unmount, pause while hidden.
 *
 * Composition (CSS grid, everything on the 4px grid):
 *   ┌──────────────────────────── TICKER TAPE (marquee) ───────────────────────┐
 *   │  INDEX HERO CARDS row (SPY QQQ DIA IWM)          │  FINANCE WIRE column   │
 *   │  MOVERS table (the owner's watchlist, |chgPct|)  │  (getSalient finance)  │
 *   │  MACRO strip (VIX 10Y GOLD OIL BTC)              │                        │
 *   │  CRYPTO strip (Coinbase 30s) · FX strip (daily)  │                        │
 *   └──────────────────────────────────────────────────────────────────────────┘
 * Health chips (EQUITIES · CRYPTO · FX) sit top-right under the tape. Clicking
 * an index card or mover row opens the symbol detail overlay (fresh chart via
 * the market engine); clicking a CRYPTO-strip symbol opens THE FLOOR overlay
 * (order-book ladder + trades tape + spot, see terminal/Floor.tsx) — the
 * clicked symbol IS the product. Both overlays share the same glass pattern
 * and close semantics (Esc / click-out / ✕); the floor's polls run only while
 * its overlay is open (mount-bound usePoll discipline). Every panel states its
 * empty/error state — never blank.
 *
 * Poll cadences: equities 60s (quotes.ts) · crypto 30s · FX 10min (Frankfurter
 * is DAILY data — the long cadence and the label are honest about that).
 *
 * Accent discipline: cyan = live/selected only; #4ade80 / --danger = deltas only.
 * All numbers use fontVariantNumeric: tabular-nums.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useReducedMotion } from "framer-motion";
import {
  startQuotes,
  stopQuotes,
  getQuotes,
  getWatchlist,
  addWatchSymbol,
  removeWatchSymbol,
  type Quote,
  type QuotesSnapshot,
  INDEX_SYMBOLS,
  MACRO_SYMBOLS,
  SYMBOL_LABELS,
} from "../../lib/terminal/quotes";
import { TICKER_RE } from "../../lib/voice/settings";
import { usePoll } from "../../lib/util/usePoll";
import { getChart, getCrypto, getFx } from "../../lib/market/source";
import type { MarketChart, MarketCrypto, MarketFx } from "../../lib/core";
import { getSalient } from "../../lib/watch/runtime";
import type { ScoredEvent } from "../../lib/watch/types";
import Floor from "../terminal/Floor";

const POS = "#4ade80";
const NEG = "var(--danger)";
// Near-opaque navy — this is a full-bleed DATA surface, not floating chrome, so
// panels are solid enough that the orb band's screen-blend glow (z10) doesn't
// wash out the tabular numbers underneath.
const PANEL_BG = "rgba(9,15,29,0.96)";

// Poll cadences. Coinbase public limit is ~10 req/s/IP; the crypto strip is
// 3 requests / 30s ≈ 0.1 req/s — comfortable. Frankfurter publishes DAILY
// rates, so 10 minutes is already generous; anything faster would fake liveness.
const EQUITIES_POLL_MS = 60_000; // quotes.ts POLL_INTERVAL_MS (owned there)
const CRYPTO_POLL_MS = 30_000;
const FX_POLL_MS = 600_000;

const CRYPTO_PRODUCTS = ["BTC-USD", "ETH-USD", "SOL-USD"] as const;
const FX_CODES = ["EUR", "GBP", "JPY"] as const;

// ── Number formatting (tabular-friendly) ─────────────────────────────────────

function fmtPrice(v: number): string {
  if (Math.abs(v) >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (Math.abs(v) >= 1) return v.toFixed(2);
  return v.toFixed(4);
}
function fmtChg(v: number): string {
  const s = Math.abs(v) >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : v.toFixed(2);
  return (v >= 0 ? "+" : "-") + s.replace("-", "");
}
function fmtPct(v: number): string {
  return (v >= 0 ? "+" : "-") + Math.abs(v).toFixed(2) + "%";
}
function fmtVol(v: number): string {
  if (v >= 1e9) return (v / 1e9).toFixed(1) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return String(Math.round(v));
}
function fmtClock(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function fmtAgeMs(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
function color(v: number): string {
  return v >= 0 ? POS : NEG;
}

// ── Source health (EQUITIES · CRYPTO · FX chips) ─────────────────────────────

type SourceState<T> = { data: T | null; updatedAt: number; error: boolean };
type HealthTone = "go" | "warn" | "danger" | "dim";

/**
 * fresh (< 2× poll) → go · older but once-alive → warn + age · last attempt
 * failed → danger · nothing yet, nothing failed → dim (still warming).
 */
function healthOf(updatedAt: number, error: boolean, pollMs: number, now: number): { tone: HealthTone; age?: string } {
  if (error) return { tone: "danger", age: updatedAt > 0 ? fmtAgeMs(now - updatedAt) : undefined };
  if (updatedAt === 0) return { tone: "dim" };
  const age = now - updatedAt;
  if (age < 2 * pollMs) return { tone: "go" };
  return { tone: "warn", age: fmtAgeMs(age) };
}

const TONE_COLOR: Record<HealthTone, string> = {
  go: "var(--go)",
  warn: "var(--warn)",
  danger: "var(--danger)",
  dim: "var(--t3)",
};

function HealthChip({ id, label, tone, age }: { id: string; label: string; tone: HealthTone; age?: string }) {
  return (
    <span
      data-testid={`health-${id}`}
      data-tone={tone}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 8px",
        borderRadius: 999,
        background: PANEL_BG,
        border: "1px solid var(--glass-border)",
      }}
    >
      <span
        aria-hidden
        style={{ width: 6, height: 6, borderRadius: 999, background: TONE_COLOR[tone], flex: "none" }}
      />
      <span style={{ ...H_PANEL, fontSize: 9, letterSpacing: ".14em", color: "var(--t2)" }}>{label}</span>
      {age && <span style={{ ...NUM, fontSize: 9, color: "var(--t3)" }}>{age}</span>}
    </span>
  );
}

// ── Spark (small inline SVG polyline) ────────────────────────────────────────

function Spark({ values, up, w = 72, h = 22 }: { values: number[]; up: boolean; w?: number; h?: number }) {
  if (!values || values.length < 2) return null;
  const mn = Math.min(...values);
  const mx = Math.max(...values);
  const range = mx - mn || 1;
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - ((v - mn) / range) * (h - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const stroke = up ? POS : NEG;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: "block", overflow: "visible" }} aria-hidden>
      <polyline points={pts} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" opacity={0.9} />
    </svg>
  );
}

// ── Shared type tokens ───────────────────────────────────────────────────────

const H_PANEL: React.CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 11,
  letterSpacing: ".12em",
  textTransform: "uppercase",
  color: "var(--t2)",
};
const NUM: React.CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontVariantNumeric: "tabular-nums",
};
/** Calm in-panel state line (empty / error / warming). */
const STATE_LINE: React.CSSProperties = {
  ...H_PANEL,
  fontSize: 10,
  color: "var(--t3)",
  lineHeight: 1.5,
  padding: "12px 12px",
};

// ── Ticker tape ──────────────────────────────────────────────────────────────

function TickerTape({ quotes, reduced }: { quotes: Quote[]; reduced: boolean }) {
  const cells = quotes.map((q) => (
    <span key={q.symbol} style={{ display: "inline-flex", alignItems: "baseline", gap: 8, marginRight: 28 }}>
      <span style={{ ...NUM, fontSize: 11, color: "var(--t2)", letterSpacing: ".04em" }}>{q.symbol}</span>
      <span style={{ ...NUM, fontSize: 11, color: "var(--t1)" }}>{fmtPrice(q.price)}</span>
      <span style={{ ...NUM, fontSize: 11, color: color(q.chgPct) }}>{fmtPct(q.chgPct)}</span>
    </span>
  ));
  // Duplicate the content so the marquee loops seamlessly.
  return (
    <div
      data-testid="ticker-tape"
      style={{
        height: 28,
        display: "flex",
        alignItems: "center",
        overflow: "hidden",
        borderBottom: "1px solid var(--line)",
        maskImage: "linear-gradient(90deg,transparent,#000 3%,#000 97%,transparent)",
        WebkitMaskImage: "linear-gradient(90deg,transparent,#000 3%,#000 97%,transparent)",
      }}
    >
      {reduced ? (
        <div data-testid="tape-static" style={{ display: "flex", whiteSpace: "nowrap", paddingLeft: 12 }}>
          {cells}
        </div>
      ) : (
        <div
          className="loom-tape-track"
          data-testid="tape-track"
          style={{ display: "flex", whiteSpace: "nowrap", willChange: "transform" }}
        >
          <div style={{ display: "flex", paddingLeft: 12 }} data-testid="tape-copy-a">{cells}</div>
          <div style={{ display: "flex", paddingLeft: 12 }} aria-hidden data-testid="tape-copy-b">{cells}</div>
        </div>
      )}
    </div>
  );
}

// ── Index hero card (click → symbol detail) ──────────────────────────────────

function IndexCard({ q, onSelect }: { q: Quote; onSelect: (symbol: string) => void }) {
  const up = q.chgPct >= 0;
  return (
    <div
      data-testid={`index-card-${q.symbol}`}
      className="loom-click-card"
      role="button"
      tabIndex={0}
      onClick={() => onSelect(q.symbol)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onSelect(q.symbol);
      }}
      style={{
        background: PANEL_BG,
        border: "1px solid var(--glass-border)",
        borderRadius: 10,
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        minWidth: 0,
        cursor: "pointer",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
        <span style={{ ...NUM, fontSize: 12, color: "var(--t1)", letterSpacing: ".04em" }}>{q.symbol}</span>
        <span style={{ ...H_PANEL, fontSize: 9, letterSpacing: ".1em", color: "var(--t3)" }}>
          {SYMBOL_LABELS[q.symbol] ?? q.name ?? ""}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 8 }}>
        <span style={{ ...NUM, fontSize: 24, color: "var(--t1)", lineHeight: 1 }}>{fmtPrice(q.price)}</span>
        {q.spark && <Spark values={q.spark} up={up} />}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, ...NUM, fontSize: 12, color: color(q.chgPct) }}>
        <span>{fmtChg(q.chg)}</span>
        <span>{fmtPct(q.chgPct)}</span>
      </div>
    </div>
  );
}

// ── Movers table (editable watchlist) ────────────────────────────────────────

type MoverRow = { symbol: string; q: Quote | null };

function MoversTable({
  rows,
  stale,
  onSelect,
}: {
  rows: MoverRow[];
  stale: boolean;
  onSelect: (symbol: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [invalid, setInvalid] = useState(false);

  const submit = () => {
    const t = draft.trim().toUpperCase();
    if (!TICKER_RE.test(t) || !addWatchSymbol(t)) {
      // Not a ticker, already listed, or the list is full — say no calmly.
      setInvalid(true);
      return;
    }
    setDraft("");
    setInvalid(false);
  };

  return (
    <div
      data-testid="movers-table"
      style={{
        background: PANEL_BG,
        border: "1px solid var(--glass-border)",
        borderRadius: 10,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <div
        style={{
          padding: "8px 12px",
          borderBottom: "1px solid var(--line)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span style={H_PANEL}>Movers</span>
        <span style={{ ...H_PANEL, fontSize: 9, color: "var(--t3)" }}>by |Δ%|</span>
        <span style={{ flex: 1 }} />
        <input
          data-testid="watch-add-input"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value.toUpperCase());
            if (invalid) setInvalid(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="SYMBOL"
          aria-label="Add symbol to watchlist"
          aria-invalid={invalid}
          spellCheck={false}
          maxLength={12}
          style={{
            ...NUM,
            fontSize: 10,
            letterSpacing: ".08em",
            width: 76,
            padding: "3px 8px",
            borderRadius: 6,
            border: `1px solid ${invalid ? "var(--danger)" : "var(--glass-border)"}`,
            background: "rgba(255,255,255,.03)",
            color: "var(--t1)",
            outline: "none",
            textTransform: "uppercase",
          }}
        />
        <button
          data-testid="watch-add-btn"
          onClick={submit}
          className="loom-add-btn"
          style={{
            ...H_PANEL,
            fontSize: 9,
            letterSpacing: ".14em",
            color: "var(--t2)",
            background: "rgba(255,255,255,.04)",
            border: "1px solid var(--glass-border)",
            borderRadius: 6,
            padding: "4px 8px",
            cursor: "pointer",
          }}
        >
          ADD
        </button>
      </div>
      {/* Column header */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 88px 88px 64px 20px",
          padding: "6px 12px",
          borderBottom: "1px solid var(--line)",
          ...NUM,
          fontSize: 9,
          letterSpacing: ".08em",
          color: "var(--t3)",
          textTransform: "uppercase",
        }}
      >
        <span>Symbol</span>
        <span style={{ textAlign: "right" }}>Last</span>
        <span style={{ textAlign: "right" }}>Chg</span>
        <span style={{ textAlign: "right" }}>Δ%</span>
        <span aria-hidden />
      </div>
      <div style={{ overflowY: "auto", minHeight: 0 }} className="loom-scroll">
        {rows.length === 0 ? (
          <div data-testid="movers-empty" style={STATE_LINE}>
            YOUR TAPE IS EMPTY — add a symbol above.
          </div>
        ) : (
          rows.map(({ symbol, q }) => (
            <div
              key={symbol}
              data-testid={`mover-row-${symbol}`}
              className="loom-mover-row"
              role="button"
              tabIndex={0}
              onClick={() => onSelect(symbol)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onSelect(symbol);
              }}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 88px 88px 64px 20px",
                alignItems: "center",
                padding: "8px 12px",
                borderBottom: "1px solid var(--line)",
                ...NUM,
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              <span style={{ color: "var(--t1)", letterSpacing: ".03em" }}>{symbol}</span>
              {q ? (
                <>
                  <span style={{ textAlign: "right", color: "var(--t1)" }}>{fmtPrice(q.price)}</span>
                  <span style={{ textAlign: "right", color: color(q.chgPct) }}>{fmtChg(q.chg)}</span>
                  <span style={{ textAlign: "right", color: color(q.chgPct) }}>{fmtPct(q.chgPct)}</span>
                </>
              ) : (
                <>
                  <span style={{ textAlign: "right", color: "var(--t3)" }}>—</span>
                  <span style={{ textAlign: "right", color: "var(--t3)" }}>—</span>
                  <span
                    data-testid={`mover-awaiting-${symbol}`}
                    style={{ textAlign: "right", color: "var(--t3)", fontSize: 9, letterSpacing: ".06em" }}
                  >
                    {stale ? "DARK" : "SOON"}
                  </span>
                </>
              )}
              <button
                data-testid={`mover-remove-${symbol}`}
                className="loom-mover-x"
                aria-label={`Remove ${symbol} from watchlist`}
                title="Remove from watchlist"
                onClick={(e) => {
                  e.stopPropagation();
                  removeWatchSymbol(symbol);
                }}
                style={{
                  width: 16,
                  height: 16,
                  padding: 0,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "transparent",
                  border: "none",
                  borderRadius: 4,
                  color: "var(--t3)",
                  fontSize: 11,
                  lineHeight: 1,
                  cursor: "pointer",
                  justifySelf: "end",
                }}
              >
                ✕
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ── Macro strip ──────────────────────────────────────────────────────────────

function MacroStrip({ quotes }: { quotes: Quote[] }) {
  return (
    <div data-testid="macro-strip" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {quotes.map((q) => (
        <div
          key={q.symbol}
          data-testid={`macro-chip-${q.symbol}`}
          style={{
            flex: "1 1 0",
            minWidth: 92,
            background: PANEL_BG,
            border: "1px solid var(--glass-border)",
            borderRadius: 8,
            padding: "8px 12px",
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <span style={{ ...H_PANEL, fontSize: 9, letterSpacing: ".1em", color: "var(--t3)" }}>
            {SYMBOL_LABELS[q.symbol] ?? q.symbol}
          </span>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
            <span style={{ ...NUM, fontSize: 14, color: "var(--t1)" }}>{fmtPrice(q.price)}</span>
            <span style={{ ...NUM, fontSize: 11, color: color(q.chgPct) }}>{fmtPct(q.chgPct)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Crypto strip (Coinbase spot + 24h, 30s poll; click → floor overlay) ──────

function CryptoStrip({
  state,
  onSelect,
}: {
  state: SourceState<MarketCrypto[]>;
  onSelect: (product: string) => void;
}) {
  return (
    <div
      data-testid="crypto-strip"
      style={{
        flex: "1 1 0",
        minWidth: 0,
        background: PANEL_BG,
        border: "1px solid var(--glass-border)",
        borderRadius: 10,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--line)", display: "flex", justifyContent: "space-between" }}>
        <span style={H_PANEL}>Crypto</span>
        <span style={{ ...H_PANEL, fontSize: 9, color: "var(--t3)" }}>coinbase · 24h</span>
      </div>
      {state.error && !state.data ? (
        <div data-testid="crypto-error" style={STATE_LINE}>
          THE CRYPTO FEED IS DARK — the source did not answer.
        </div>
      ) : !state.data ? (
        <div data-testid="crypto-warming" style={STATE_LINE}>
          LISTENING — first pull in flight.
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, padding: 8, flexWrap: "wrap" }}>
          {state.data.map((c) => (
            <div
              key={c.product}
              data-testid={`crypto-chip-${c.product}`}
              className="loom-click-card"
              role="button"
              tabIndex={0}
              onClick={() => onSelect(c.product)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") onSelect(c.product);
              }}
              style={{
                flex: "1 1 0",
                minWidth: 88,
                display: "flex",
                flexDirection: "column",
                gap: 4,
                padding: "4px 8px",
                borderRadius: 8,
                border: "1px solid transparent",
                cursor: "pointer",
              }}
            >
              <span style={{ ...H_PANEL, fontSize: 9, letterSpacing: ".1em", color: "var(--t3)" }}>
                {c.product.replace("-USD", "")}
              </span>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
                <span style={{ ...NUM, fontSize: 14, color: "var(--t1)" }}>{fmtPrice(c.price)}</span>
                {c.changePct24h !== null && (
                  <span style={{ ...NUM, fontSize: 11, color: color(c.changePct24h) }}>{fmtPct(c.changePct24h)}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── FX strip (Frankfurter — DAILY data, labeled honestly, 10min poll) ────────

function FxStrip({ state }: { state: SourceState<MarketFx> }) {
  return (
    <div
      data-testid="fx-strip"
      style={{
        flex: "1 1 0",
        minWidth: 0,
        background: PANEL_BG,
        border: "1px solid var(--glass-border)",
        borderRadius: 10,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--line)", display: "flex", justifyContent: "space-between" }}>
        <span style={H_PANEL}>FX · vs USD</span>
        {/* Frankfurter is a daily reference rate — never dressed up as live. */}
        <span data-testid="fx-daily-label" style={{ ...H_PANEL, fontSize: 9, color: "var(--t3)" }}>
          daily{state.data ? ` · ${state.data.date}` : ""}
        </span>
      </div>
      {state.error && !state.data ? (
        <div data-testid="fx-error" style={STATE_LINE}>
          THE FX FEED IS DARK — the source did not answer.
        </div>
      ) : !state.data ? (
        <div data-testid="fx-warming" style={STATE_LINE}>
          LISTENING — first pull in flight.
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, padding: 8, flexWrap: "wrap" }}>
          {FX_CODES.map((code) => {
            const rate = state.data!.rates[code];
            return (
              <div
                key={code}
                data-testid={`fx-chip-${code}`}
                style={{ flex: "1 1 0", minWidth: 88, display: "flex", flexDirection: "column", gap: 4, padding: "4px 8px" }}
              >
                <span style={{ ...H_PANEL, fontSize: 9, letterSpacing: ".1em", color: "var(--t3)" }}>{code}</span>
                <span style={{ ...NUM, fontSize: 14, color: "var(--t1)" }}>
                  {typeof rate === "number" ? rate.toFixed(rate >= 10 ? 2 : 4) : "—"}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Symbol detail overlay (glass, Esc / click-out closes) ────────────────────

function AreaChart({ closes, timestamps, up }: { closes: number[]; timestamps: number[]; up: boolean }) {
  const W = 672;
  const H = 216;
  const PAD_T = 8;
  const PAD_B = 24;
  const PAD_R = 56;
  const mn = Math.min(...closes);
  const mx = Math.max(...closes);
  const range = mx - mn || 1;
  const plotW = W - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const xy = (v: number, i: number): [number, number] => [
    (i / (closes.length - 1)) * plotW,
    PAD_T + plotH - ((v - mn) / range) * plotH,
  ];
  const pts = closes.map((v, i) => xy(v, i));
  const line = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${plotW},${PAD_T + plotH} L0,${PAD_T + plotH} Z`;
  // 4 time ticks across the session (first / third-points / last).
  const tickIdx = [0, Math.floor((closes.length - 1) / 3), Math.floor((2 * (closes.length - 1)) / 3), closes.length - 1];
  const ticks = [...new Set(tickIdx)].map((i) => ({ x: pts[i][0], label: fmtClock(timestamps[i]) }));
  const tint = up ? POS : NEG;
  return (
    <svg
      data-testid="detail-chart"
      viewBox={`0 0 ${W} ${H}`}
      style={{ display: "block", width: "100%", height: "auto" }}
      role="img"
      aria-label="intraday chart"
    >
      {/* Area fill + line: accent = alive. Delta color stays in the readouts. */}
      <path d={area} fill="var(--accent)" opacity={0.08} />
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth={1.5} strokeLinejoin="round" opacity={0.9} />
      {/* Min/max price labels on the right gutter. */}
      <text x={plotW + 8} y={PAD_T + 8} fill="var(--t3)" fontSize={10} fontFamily="var(--f-mono)">
        {fmtPrice(mx)}
      </text>
      <text x={plotW + 8} y={PAD_T + plotH} fill="var(--t3)" fontSize={10} fontFamily="var(--f-mono)">
        {fmtPrice(mn)}
      </text>
      {/* Session baseline + time ticks. */}
      <line x1={0} y1={PAD_T + plotH + 4} x2={plotW} y2={PAD_T + plotH + 4} stroke="var(--line)" strokeWidth={1} />
      {ticks.map((t, i) => (
        <text
          key={i}
          x={Math.min(Math.max(t.x, 2), plotW - 30)}
          y={H - 8}
          fill="var(--t3)"
          fontSize={10}
          fontFamily="var(--f-mono)"
        >
          {t.label}
        </text>
      ))}
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r={2.5} fill={tint} />
    </svg>
  );
}

function Readout({ label, value, tint }: { label: string; value: string; tint?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 72 }}>
      <span style={{ ...H_PANEL, fontSize: 9, letterSpacing: ".1em", color: "var(--t3)" }}>{label}</span>
      <span style={{ ...NUM, fontSize: 13, color: tint ?? "var(--t1)" }}>{value}</span>
    </div>
  );
}

function DetailPanel({ symbol, onClose }: { symbol: string; onClose: () => void }) {
  const [chart, setChart] = useState<MarketChart | null>(null);
  const [error, setError] = useState(false);

  // Fresh, fuller data than the tape snapshot — one shot per open.
  useEffect(() => {
    let alive = true;
    setChart(null);
    setError(false);
    getChart(symbol)
      .then((c) => {
        if (alive) setChart(c);
      })
      .catch(() => {
        if (alive) setError(true);
      });
    return () => {
      alive = false;
    };
  }, [symbol]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const chg = chart ? chart.price - chart.prevClose : 0;
  const chgPct = chart && chart.prevClose !== 0 ? (chg / chart.prevClose) * 100 : 0;

  return (
    <div
      data-testid="detail-backdrop"
      onClick={onClose}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 5,
        background: "rgba(6,11,24,.55)",
        backdropFilter: "blur(4px)",
        WebkitBackdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        // Extra top padding drops the panel's center below the orb hero
        // (z10 above every deck) so the title row stays out of its glow.
        padding: "112px 24px 24px",
      }}
    >
      <div
        data-testid="symbol-detail"
        role="dialog"
        aria-label={`${symbol} detail`}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(720px, 100%)",
          background: "var(--glass-raised)",
          border: "1px solid var(--glass-border)",
          borderRadius: 10,
          boxShadow: "var(--shadow-2)",
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span style={{ ...NUM, fontSize: 16, color: "var(--t1)", letterSpacing: ".04em" }}>{symbol}</span>
          <span style={{ ...H_PANEL, fontSize: 9, letterSpacing: ".1em", color: "var(--t3)" }}>
            {SYMBOL_LABELS[symbol] ?? chart?.name ?? ""}
          </span>
          <span style={{ flex: 1 }} />
          {chart && (
            <>
              <span style={{ ...NUM, fontSize: 16, color: "var(--t1)" }}>{fmtPrice(chart.price)}</span>
              <span style={{ ...NUM, fontSize: 12, color: color(chgPct) }}>{fmtPct(chgPct)}</span>
            </>
          )}
          <button
            data-testid="detail-close"
            aria-label="Close detail"
            onClick={onClose}
            className="loom-add-btn"
            style={{
              width: 22,
              height: 22,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(255,255,255,.04)",
              border: "1px solid var(--glass-border)",
              borderRadius: 6,
              color: "var(--t2)",
              fontSize: 11,
              lineHeight: 1,
              cursor: "pointer",
            }}
          >
            ✕
          </button>
        </div>

        {error ? (
          <div data-testid="detail-error" style={{ ...STATE_LINE, padding: "32px 12px", textAlign: "center" }}>
            THE CHART IS DARK — the source did not answer.
          </div>
        ) : !chart ? (
          <div data-testid="detail-loading" style={{ ...STATE_LINE, padding: "32px 12px", textAlign: "center" }}>
            PULLING THE DAY — one moment.
          </div>
        ) : (
          <>
            {chart.closes.length >= 2 ? (
              <AreaChart closes={chart.closes} timestamps={chart.timestamps} up={chg >= 0} />
            ) : (
              <div data-testid="detail-flat" style={{ ...STATE_LINE, padding: "32px 12px", textAlign: "center" }}>
                THE DAY HAS NO SHAPE YET — too few points to draw.
              </div>
            )}
            <div
              data-testid="detail-readouts"
              style={{
                display: "flex",
                gap: 16,
                flexWrap: "wrap",
                borderTop: "1px solid var(--line)",
                paddingTop: 12,
              }}
            >
              <Readout label="Open" value={chart.open !== null ? fmtPrice(chart.open) : "—"} />
              <Readout label="High" value={chart.high !== null ? fmtPrice(chart.high) : "—"} />
              <Readout label="Low" value={chart.low !== null ? fmtPrice(chart.low) : "—"} />
              <Readout label="Prev Close" value={fmtPrice(chart.prevClose)} />
              <Readout label="Volume" value={chart.volume !== null ? fmtVol(chart.volume) : "—"} />
              <Readout label="Δ%" value={fmtPct(chgPct)} tint={color(chgPct)} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Crypto floor overlay (glass, Esc / click-out closes — see terminal/Floor) ─

function FloorPanel({ product, onClose }: { product: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      data-testid="floor-backdrop"
      onClick={onClose}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 5,
        background: "rgba(6,11,24,.55)",
        backdropFilter: "blur(4px)",
        WebkitBackdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        // Extra top padding drops the panel's center below the orb hero
        // (z10 above every deck) so the title row stays out of its glow.
        padding: "112px 24px 24px",
      }}
    >
      <div
        data-testid="floor-detail"
        role="dialog"
        aria-label={`${product} floor`}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(880px, 100%)",
          height: "min(560px, 100%)",
          background: "var(--glass-raised)",
          border: "1px solid var(--glass-border)",
          borderRadius: 10,
          boxShadow: "var(--shadow-2)",
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span style={{ ...NUM, fontSize: 16, color: "var(--t1)", letterSpacing: ".04em" }}>{product}</span>
          <span style={{ ...H_PANEL, fontSize: 9, letterSpacing: ".1em", color: "var(--t3)" }}>THE FLOOR</span>
          <span style={{ flex: 1 }} />
          <button
            data-testid="floor-close"
            aria-label="Close floor"
            onClick={onClose}
            className="loom-add-btn"
            style={{
              width: 22,
              height: 22,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(255,255,255,.04)",
              border: "1px solid var(--glass-border)",
              borderRadius: 6,
              color: "var(--t2)",
              fontSize: 11,
              lineHeight: 1,
              cursor: "pointer",
            }}
          >
            ✕
          </button>
        </div>
        {/* Mount-bound: the floor's polls start here and stop when it closes. */}
        <Floor product={product} />
      </div>
    </div>
  );
}

// ── Finance wire (getSalient finance/geo) ────────────────────────────────────

function ageOf(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function WireRow({ e }: { e: ScoredEvent }) {
  const pct = Math.round(e.score * 100);
  return (
    <a
      href={e.url || undefined}
      target="_blank"
      rel="noreferrer noopener"
      data-testid="wire-row"
      className="loom-wire-row"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "9px 12px",
        borderBottom: "1px solid var(--line)",
        textDecoration: "none",
        cursor: e.url ? "pointer" : "default",
      }}
    >
      <span
        style={{
          fontFamily: "var(--f-sans)",
          fontSize: 12,
          lineHeight: 1.3,
          color: "var(--t1)",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}
      >
        {e.title}
      </span>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ ...H_PANEL, fontSize: 9, letterSpacing: ".08em", color: "var(--t3)" }}>{e.category}</span>
        {ageOf(e.publishedAt) && (
          <span style={{ ...NUM, fontSize: 9, color: "var(--t3)" }}>{ageOf(e.publishedAt)}</span>
        )}
        <span style={{ flex: 1, height: 2, borderRadius: 999, background: "var(--line)", position: "relative", overflow: "hidden" }}>
          <span
            style={{
              position: "absolute",
              inset: 0,
              width: `${pct}%`,
              background: "var(--t2)",
              opacity: 0.7,
              borderRadius: 999,
            }}
          />
        </span>
        <span style={{ ...NUM, fontSize: 9, color: "var(--t3)" }}>{pct}</span>
      </div>
    </a>
  );
}

function FinanceWire({ items }: { items: ScoredEvent[] }) {
  return (
    <div
      data-testid="finance-wire"
      style={{
        background: PANEL_BG,
        border: "1px solid var(--glass-border)",
        borderRadius: 10,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--line)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={H_PANEL}>Finance Wire</span>
        <span style={{ ...NUM, fontSize: 9, color: "var(--t3)" }}>{items.length}</span>
      </div>
      <div style={{ overflowY: "auto", minHeight: 0 }} className="loom-scroll">
        {items.length === 0 ? (
          <div style={{ padding: 16, ...H_PANEL, fontSize: 10, color: "var(--t3)", lineHeight: 1.5 }}>
            THE WIRE IS QUIET — no finance stories yet.
          </div>
        ) : (
          items.map((e) => <WireRow key={e.id} e={e} />)
        )}
      </div>
    </div>
  );
}

// ── Empty / offline state (equities area — states its reason, never blank) ───

function QuietTape({ stale }: { stale: boolean }) {
  return (
    <div
      data-testid="terminal-quiet"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        opacity: 0.6,
        minHeight: 0,
      }}
    >
      <span style={{ ...H_PANEL, fontSize: 12, color: "var(--t3)", letterSpacing: ".1em" }}>
        {stale ? "THE TAPE IS DARK — the source did not answer." : "THE TAPE IS QUIET — waiting on the first pull."}
      </span>
    </div>
  );
}

// ── Deck ─────────────────────────────────────────────────────────────────────

export default function TerminalDeck() {
  const reduced = useReducedMotion() ?? false;
  const [snap, setSnap] = useState<QuotesSnapshot>(() => getQuotes());
  const [wire, setWire] = useState<ScoredEvent[]>([]);
  const [entered, setEntered] = useState(reduced);
  const [watchlist, setWatchlist] = useState<string[]>(() => getWatchlist());
  const [detail, setDetail] = useState<string | null>(null);
  // The floor overlay's product — null means closed (and zero floor polls).
  const [floor, setFloor] = useState<string | null>(null);
  const [crypto, setCrypto] = useState<SourceState<MarketCrypto[]>>({ data: null, updatedAt: 0, error: false });
  const [fx, setFx] = useState<SourceState<MarketFx>>({ data: null, updatedAt: 0, error: false });

  // Drive the quotes poller by mount lifecycle — no background burn.
  useEffect(() => {
    startQuotes();
    setSnap(getQuotes());
    const onQuotes = (ev: Event) => setSnap((ev as CustomEvent<QuotesSnapshot>).detail ?? getQuotes());
    window.addEventListener("loom-quotes", onQuotes);
    return () => {
      window.removeEventListener("loom-quotes", onQuotes);
      stopQuotes();
    };
  }, []);

  // The owner's tape: re-read on any terminal.symbols change (the quotes
  // poller refreshes itself on the same event — see quotes.ts).
  useEffect(() => {
    const onSettings = (ev: Event) => {
      const d = (ev as CustomEvent<{ key?: string }>).detail;
      if (d?.key === "terminal.symbols") setWatchlist(getWatchlist());
    };
    window.addEventListener("loom-settings-changed", onSettings);
    return () => window.removeEventListener("loom-settings-changed", onSettings);
  }, []);

  // CRYPTO strip: BTC/ETH/SOL spot + 24h, 30s cadence.
  const tickCrypto = useCallback(async (signal: AbortSignal) => {
    const settled = await Promise.allSettled(CRYPTO_PRODUCTS.map((p) => getCrypto(p, signal)));
    if (signal.aborted) return;
    const rows = settled
      .filter((r): r is PromiseFulfilledResult<MarketCrypto> => r.status === "fulfilled")
      .map((r) => r.value);
    if (rows.length > 0) {
      setCrypto({ data: rows, updatedAt: Date.now(), error: false });
    } else {
      setCrypto((c) => ({ ...c, error: true }));
    }
  }, []);
  usePoll(tickCrypto, CRYPTO_POLL_MS);

  // FX strip: EUR/GBP/JPY vs USD — Frankfurter is DAILY, 10min cadence.
  const tickFx = useCallback(async (signal: AbortSignal) => {
    try {
      const data = await getFx("USD", [...FX_CODES], signal);
      if (signal.aborted) return;
      setFx({ data, updatedAt: Date.now(), error: false });
    } catch {
      if (signal.aborted) return;
      setFx((f) => ({ ...f, error: true }));
    }
  }, []);
  usePoll(tickFx, FX_POLL_MS);

  // Pull finance/geo salience for the wire (initial + on salience change).
  useEffect(() => {
    const pull = () => {
      const items = getSalient(60).filter((e) => e.category === "finance" || e.category === "geo").slice(0, 24);
      setWire(items);
    };
    pull();
    window.addEventListener("loom-salience", pull);
    return () => window.removeEventListener("loom-salience", pull);
  }, []);

  // Entrance fade.
  useEffect(() => {
    if (reduced) return;
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, [reduced]);

  const bySym = useMemo(() => {
    const m = new Map<string, Quote>();
    for (const q of snap.quotes) m.set(q.symbol, q);
    return m;
  }, [snap.quotes]);

  const indexCards = INDEX_SYMBOLS.map((s) => bySym.get(s)).filter((q): q is Quote => !!q);
  const macro = MACRO_SYMBOLS.map((s) => bySym.get(s)).filter((q): q is Quote => !!q);
  // Movers = the watchlist: rows with data sorted by |Δ%|, just-added symbols
  // still awaiting their first quote pinned below (visible, honest).
  const movers = useMemo<MoverRow[]>(() => {
    const withData: MoverRow[] = [];
    const awaiting: MoverRow[] = [];
    for (const s of watchlist) {
      const q = bySym.get(s) ?? null;
      (q ? withData : awaiting).push({ symbol: s, q });
    }
    withData.sort((a, b) => Math.abs(b.q!.chgPct) - Math.abs(a.q!.chgPct));
    return [...withData, ...awaiting];
  }, [bySym, watchlist]);

  const hasData = snap.quotes.length > 0;
  // Health derives at render time; every poll landing re-renders, so the ages
  // stay honest at each source's own cadence without an extra ticking timer.
  const now = Date.now();
  const eqHealth = healthOf(snap.updatedAt, snap.stale, EQUITIES_POLL_MS, now);
  const cryptoHealth = healthOf(crypto.updatedAt, crypto.error, CRYPTO_POLL_MS, now);
  const fxHealth = healthOf(fx.updatedAt, fx.error, FX_POLL_MS, now);

  return (
    <div
      data-testid="terminal-deck"
      style={{
        position: "absolute",
        inset: 0,
        background: "linear-gradient(180deg, rgba(6,11,24,0.92), rgba(6,11,24,0.98))",
        pointerEvents: "auto",
        opacity: entered ? (snap.stale ? 0.72 : 1) : 0,
        transition: reduced ? "none" : "opacity .3s var(--ease-out)",
        overflow: "hidden",
      }}
    >
      <style>{`
        @keyframes loom-tape { from { transform: translateX(0); } to { transform: translateX(-50%); } }
        .loom-tape-track { animation: loom-tape 60s linear infinite; }
        .loom-mover-row:hover, .loom-wire-row:hover { background: rgba(255,255,255,.04); }
        .loom-mover-row, .loom-wire-row { transition: background var(--dur-fast) var(--ease-out); }
        .loom-click-card { transition: border-color var(--dur-fast) var(--ease-out); }
        .loom-click-card:hover { border-color: rgba(255,255,255,.16); }
        .loom-mover-x { opacity: 0; transition: opacity var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out); }
        .loom-mover-row:hover .loom-mover-x, .loom-mover-x:focus-visible { opacity: 1; }
        .loom-mover-x:hover { background: rgba(255,255,255,.08); color: var(--t1); }
        .loom-add-btn:hover { background: rgba(255,255,255,.08); }
        .loom-add-btn:active { background: rgba(255,255,255,.12); }
        .loom-scroll::-webkit-scrollbar { width: 8px; }
        .loom-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,.08); border-radius: 999px; }
        @media (prefers-reduced-motion: reduce) { .loom-tape-track { animation: none; } }
      `}</style>

      {/* Ticker tape (always spans full width). */}
      {hasData && <TickerTape quotes={snap.quotes} reduced={reduced} />}

      <div
        style={{
          display: "grid",
          gridTemplateRows: hasData ? "auto auto minmax(0, 1fr) auto auto" : "auto minmax(0, 1fr) auto",
          gap: hasData ? 12 : 16,
          // 24px top clears the shell top-bar's right pill cluster (glass
          // chrome overlays the deck's first ~46px — the tape scrolls under it
          // by design, but the health chips must stay readable).
          padding: "24px 16px 16px",
          height: hasData ? "calc(100% - 28px)" : "100%",
          minHeight: 0,
        }}
      >
        {/* Health chrome: per-source dots + the STALE chip — the deck's header row. */}
        <div
          data-testid="health-chips"
          style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "flex-end" }}
        >
          {snap.stale && hasData && (
            <span
              data-testid="stale-chip"
              style={{
                ...H_PANEL,
                fontSize: 9,
                letterSpacing: ".14em",
                color: "var(--warn)",
                background: "rgba(249,115,22,.12)",
                border: "1px solid rgba(249,115,22,.3)",
                borderRadius: 999,
                padding: "3px 8px",
              }}
            >
              STALE
            </span>
          )}
          <HealthChip id="equities" label="Equities" tone={eqHealth.tone} age={eqHealth.age} />
          <HealthChip id="crypto" label="Crypto" tone={cryptoHealth.tone} age={cryptoHealth.age} />
          <HealthChip id="fx" label="FX" tone={fxHealth.tone} age={fxHealth.age} />
        </div>

        {hasData ? (
          <>
            {/* Top: index hero cards, full-width. */}
            <div
              data-testid="index-cards"
              style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}
            >
              {indexCards.map((q) => (
                <IndexCard key={q.symbol} q={q} onSelect={setDetail} />
              ))}
            </div>

            {/* Middle: movers (left) — orb spine (center, empty) — wire (right). */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) minmax(220px, 0.9fr) minmax(280px, 1fr)",
                gap: 16,
                minHeight: 0,
              }}
            >
              <MoversTable rows={movers} stale={snap.stale} onSelect={setDetail} />
              {/* Center spine kept clear for the orb hero (z10). */}
              <div data-testid="orb-spine" aria-hidden />
              <FinanceWire items={wire} />
            </div>

            {/* Macro strip, full-width. */}
            <MacroStrip quotes={macro} />
          </>
        ) : (
          <QuietTape stale={snap.stale} />
        )}

        {/* Bottom: crypto (30s) and FX (daily, 10min) — independent sources,
            alive even when the equities tape is dark. */}
        <div style={{ display: "flex", gap: 16 }}>
          <CryptoStrip state={crypto} onSelect={setFloor} />
          <FxStrip state={fx} />
        </div>
      </div>

      {/* Symbol detail overlay. */}
      {detail && <DetailPanel symbol={detail} onClose={() => setDetail(null)} />}

      {/* Crypto floor overlay — mounted only while open, so its polls are too. */}
      {floor && <FloorPanel product={floor} onClose={() => setFloor(null)} />}
    </div>
  );
}
