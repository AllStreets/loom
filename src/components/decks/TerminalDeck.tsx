/**
 * TerminalDeck.tsx — the Terminal deck: a Bloomberg-grade markets surface.
 *
 * A KERNEL deck (not an organ). Full-bleed dark surface under the orb band,
 * mounted by DeckLayer when cockpit.deck === "terminal". It drives the quotes
 * poller by its own lifecycle: startQuotes() on mount, stopQuotes() on unmount
 * — so there is NO background market polling while another deck is active.
 *
 * Composition (CSS grid, everything on the 4px grid):
 *   ┌──────────────────────────── TICKER TAPE (marquee) ───────────────────────┐
 *   │  INDEX HERO CARDS row (SPY QQQ DIA IWM)          │  FINANCE WIRE column   │
 *   │  MOVERS table (all equities, |chgPct| desc)      │  (getSalient finance)  │
 *   │  MACRO strip (VIX 10Y GOLD OIL BTC)              │                        │
 *   └──────────────────────────────────────────────────────────────────────────┘
 *
 * Accent discipline: cyan = live/selected only; #4ade80 / --danger = deltas only.
 * All numbers use fontVariantNumeric: tabular-nums.
 */
import { useEffect, useMemo, useState } from "react";
import { useReducedMotion } from "framer-motion";
import {
  startQuotes,
  stopQuotes,
  getQuotes,
  type Quote,
  type QuotesSnapshot,
  INDEX_SYMBOLS,
  EQUITY_SYMBOLS,
  MACRO_SYMBOLS,
  SYMBOL_LABELS,
} from "../../lib/terminal/quotes";
import { getSalient } from "../../lib/watch/runtime";
import type { ScoredEvent } from "../../lib/watch/types";

const POS = "#4ade80";
const NEG = "var(--danger)";
// Near-opaque navy — this is a full-bleed DATA surface, not floating chrome, so
// panels are solid enough that the orb band's screen-blend glow (z10) doesn't
// wash out the tabular numbers underneath.
const PANEL_BG = "rgba(9,15,29,0.96)";

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
function color(v: number): string {
  return v >= 0 ? POS : NEG;
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
  const stroke = up ? POS : "#f87171";
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

// ── Ticker tape ──────────────────────────────────────────────────────────────

function TickerTape({ quotes, reduced }: { quotes: Quote[]; reduced: boolean }) {
  const cells = quotes.map((q) => (
    <span key={q.symbol} style={{ display: "inline-flex", alignItems: "baseline", gap: 6, marginRight: 28 }}>
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

// ── Index hero card ──────────────────────────────────────────────────────────

function IndexCard({ q }: { q: Quote }) {
  const up = q.chgPct >= 0;
  return (
    <div
      data-testid={`index-card-${q.symbol}`}
      style={{
        background: PANEL_BG,
        border: "1px solid var(--glass-border)",
        borderRadius: 10,
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        minWidth: 0,
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

// ── Movers table ─────────────────────────────────────────────────────────────

function MoversTable({ quotes }: { quotes: Quote[] }) {
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
      <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--line)", display: "flex", justifyContent: "space-between" }}>
        <span style={H_PANEL}>Movers</span>
        <span style={{ ...H_PANEL, fontSize: 9, color: "var(--t3)" }}>by |Δ%|</span>
      </div>
      {/* Column header */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 88px 88px 76px",
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
      </div>
      <div style={{ overflowY: "auto", minHeight: 0 }} className="loom-scroll">
        {quotes.map((q) => (
          <div
            key={q.symbol}
            data-testid={`mover-row-${q.symbol}`}
            className="loom-mover-row"
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 88px 88px 76px",
              padding: "7px 12px",
              borderBottom: "1px solid var(--line)",
              ...NUM,
              fontSize: 12,
            }}
          >
            <span style={{ color: "var(--t1)", letterSpacing: ".03em" }}>{q.symbol}</span>
            <span style={{ textAlign: "right", color: "var(--t1)" }}>{fmtPrice(q.price)}</span>
            <span style={{ textAlign: "right", color: color(q.chgPct) }}>{fmtChg(q.chg)}</span>
            <span style={{ textAlign: "right", color: color(q.chgPct) }}>{fmtPct(q.chgPct)}</span>
          </div>
        ))}
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
        gap: 5,
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
              background: "var(--accent)",
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

// ── Empty / offline state ────────────────────────────────────────────────────

function QuietTape() {
  return (
    <div
      data-testid="terminal-quiet"
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        opacity: 0.5,
      }}
    >
      <span style={{ ...H_PANEL, fontSize: 12, color: "var(--t3)", letterSpacing: ".1em" }}>
        THE TAPE IS QUIET — no market data reachable.
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
  const movers = useMemo(
    () =>
      EQUITY_SYMBOLS.map((s) => bySym.get(s))
        .filter((q): q is Quote => !!q)
        .sort((a, b) => Math.abs(b.chgPct) - Math.abs(a.chgPct)),
    [bySym]
  );

  const hasData = snap.quotes.length > 0;

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
        .loom-scroll::-webkit-scrollbar { width: 8px; }
        .loom-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,.08); border-radius: 999px; }
        @media (prefers-reduced-motion: reduce) { .loom-tape-track { animation: none; } }
      `}</style>

      {/* Ticker tape (always spans full width). */}
      {hasData && <TickerTape quotes={snap.quotes} reduced={reduced} />}

      {hasData ? (
        <div
          style={{
            display: "grid",
            gridTemplateRows: "auto minmax(0, 1fr) auto",
            gap: 16,
            padding: 16,
            height: "calc(100% - 28px)",
            minHeight: 0,
          }}
        >
          {/* Top: index hero cards, full-width. */}
          <div
            data-testid="index-cards"
            style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}
          >
            {indexCards.map((q) => (
              <IndexCard key={q.symbol} q={q} />
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
            <MoversTable quotes={movers} />
            {/* Center spine kept clear for the orb hero (z10). */}
            <div data-testid="orb-spine" aria-hidden />
            <FinanceWire items={wire} />
          </div>

          {/* Bottom: macro strip, full-width. */}
          <MacroStrip quotes={macro} />
        </div>
      ) : (
        <QuietTape />
      )}

      {/* STALE chip (only when serving last-known data). */}
      {snap.stale && hasData && (
        <div
          data-testid="stale-chip"
          style={{
            position: "absolute",
            top: 36,
            right: 16,
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
        </div>
      )}
    </div>
  );
}
