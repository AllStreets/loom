/**
 * AgoraDeck.tsx — AGORA exchange dock iframe deck + THE FLOOR.
 *
 * AGORA is a locally-run Next.js app (web :3000 + engine ws :8080 + Postgres).
 * This deck is a DOCK: probes the configured local URL on mount/activation and
 * on RETRY; renders an iframe when reachable. When AGORA is NOT reachable the
 * deck is never an empty card again — it renders THE FLOOR: LOOM's own native
 * exchange surface on keyless Coinbase data (order-book ladder, trades tape,
 * spot readout), with the old offline card compressed into a launch strip
 * docked at the top. The floor is LOOM's own — not a copy of AGORA.
 *
 * URL: read from settings key "deck.agora.url" (default http://localhost:3000).
 * Path: read from settings key "deck.agora.path" (default empty → Rust uses ~/Downloads/AGORA).
 * Product: read from settings key "deck.agora.product" (default BTC-USD;
 *   whitelist BTC-USD / ETH-USD / SOL-USD — the floor's product chips persist it).
 *
 * Probe: fetch(url, { mode: "no-cors", signal: AbortSignal.timeout(2000) }).
 *   Resolves (even opaque response) → reachable → show iframe.
 *   Rejects/timeout → unreachable → show THE FLOOR with the launch strip.
 *
 * START button: calls agora_start(path) → strip shows "igniting" with log lines.
 *   Auto-probes every 2s, up to 45s (22 attempts). If reachable → show iframe.
 *   After 45s → "still dark" strip with RETRY + STOP.
 *   If agora_start REJECTS (bad path, no package.json, ...) nothing spawned —
 *   skip the probe loop entirely and surface the reason on the strip.
 * STOP chip: calls agora_stop() → re-probes.
 *
 * Floor poll discipline (usePoll — shared with the Terminal): every poll is
 * mount-bound, pauses while document.hidden, and dies with the floor — the
 * moment AGORA becomes reachable the floor unmounts and ALL polls stop.
 * Per-panel failures state themselves calmly and keep polling (the poll IS
 * the retry) — the deck is never blank.
 *
 * sandbox="allow-scripts allow-same-origin allow-forms"
 * interact prop: controls iframe pointer events.
 * 400ms fade entrance + reduced-motion guard.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { CSSProperties } from "react";
import { useReducedMotion } from "framer-motion";
import {
  getSetting,
  setSetting,
  AGORA_PRODUCTS,
  type AgoraProduct,
} from "../../lib/voice/settings";
import { timeoutSignal } from "../../lib/util/timeoutSignal";
import { usePoll } from "../../lib/util/usePoll";
import { agoraStart, agoraStop, agoraLogs } from "../../lib/core";
import { getBook, getCrypto, getTrades } from "../../lib/market/source";
import type { BookLevel, MarketBook, MarketCrypto, MarketTrade } from "../../lib/core";

interface AgoraDeckProps {
  interact: boolean;
}

type ProbeState = "probing" | "reachable" | "unreachable";
type LaunchState = "idle" | "igniting" | "still-dark" | "spawn-failed";

function getAgoraUrl(): string {
  try {
    const v = getSetting("deck.agora.url");
    return v || "http://localhost:3000";
  } catch {
    return "http://localhost:3000";
  }
}

function getAgoraPath(): string {
  try {
    return getSetting("deck.agora.path") || "";
  } catch {
    return "";
  }
}

/** The persisted floor product, hardened to the whitelist (default BTC-USD). */
function getFloorProduct(): AgoraProduct {
  try {
    const v = getSetting("deck.agora.product");
    if ((AGORA_PRODUCTS as readonly string[]).includes(v)) return v as AgoraProduct;
  } catch {
    // settings unavailable — fall through to the default
  }
  return "BTC-USD";
}

/**
 * Extract a human-readable reason from a rejected agora_start invoke.
 * Rust rejections arrive as { kind, message }; Error covers shell-side throws.
 */
function startErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

// ── THE FLOOR — constants + pure helpers (exported for tests) ────────────────

// Poll cadences. Coinbase's public rate limit is ~10 req/s/IP. Worst case
// here: book 1/2s (0.50 req/s) + trades 1/3s (0.33 req/s) + spot 1/30s
// (ticker + stats = 2 requests on the browser path → 0.07 req/s) ≈ 0.9 req/s
// — an order of magnitude under the limit, and every poll stops the moment
// the floor unmounts or the document hides (usePoll discipline).
const BOOK_POLL_MS = 2_000;
const TRADES_POLL_MS = 3_000;
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

// ── Floor styles (tokens only) ───────────────────────────────────────────────

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

// ── Floor sub-surfaces ───────────────────────────────────────────────────────

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
      data-testid={`agora-floor-${side}-row`}
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
  product: AgoraProduct;
  onProduct: (p: AgoraProduct) => void;
}

/**
 * THE FLOOR — order-book ladder + trades tape + spot readout for one product.
 * The parent keys this component by product, so switching chips REMOUNTS the
 * floor: every poll stops (usePoll cleanup) and restarts against the new
 * product with no stale data and no overlap.
 */
function Floor({ product, onProduct }: FloorProps) {
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
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      {/* Header: product chips + spot / mid / spread readout */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", gap: 6 }}>
          {AGORA_PRODUCTS.map((p) => {
            const selected = p === product;
            return (
              <button
                key={p}
                data-testid={`agora-floor-chip-${p}`}
                data-selected={selected}
                onClick={() => onProduct(p)}
                style={{
                  background: selected ? "var(--accent-soft)" : "transparent",
                  border: selected
                    ? "1px solid color-mix(in srgb, var(--accent) 45%, transparent)"
                    : "1px solid var(--glass-border, rgba(255,255,255,0.1))",
                  borderRadius: 999,
                  color: selected ? "var(--accent)" : "var(--t3)",
                  fontFamily: "var(--f-mono, monospace)",
                  fontSize: 10,
                  letterSpacing: "0.1em",
                  padding: "3px 10px",
                  cursor: "pointer",
                  transition: "color var(--dur-fast, 120ms) var(--ease-out, ease-out)",
                }}
              >
                {p}
              </button>
            );
          })}
        </div>
        <div style={{ display: "flex", gap: 16, alignItems: "baseline", flexWrap: "wrap" }}>
          <span style={MONO_LABEL}>SPOT</span>
          <span
            data-testid="agora-floor-spot"
            style={{ ...NUM, fontSize: 14, color: "var(--t1)" }}
          >
            {spot.data ? fmtFloorPrice(spot.data.price) : "—"}
          </span>
          <span
            data-testid="agora-floor-delta"
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
          <span data-testid="agora-floor-mid" style={{ ...NUM, fontSize: 12, color: "var(--t1)" }}>
            {stats ? fmtFloorPrice(stats.mid) : "—"}
          </span>
          <span style={MONO_LABEL}>SPREAD</span>
          <span data-testid="agora-floor-spread" style={{ ...NUM, fontSize: 12, color: "var(--t2)" }}>
            {stats ? `${fmtFloorPrice(stats.spreadAbs)} · ${stats.spreadBps.toFixed(1)}bps` : "—"}
          </span>
          {spot.error && <PanelCopy id="agora-floor-spot-copy">the ticker is dark — retrying</PanelCopy>}
        </div>
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
        <div data-testid="agora-floor-book" style={FLOOR_PANEL}>
          <div style={MONO_LABEL}>THE BOOK — {product}</div>
          {book.error && <PanelCopy id="agora-floor-book-copy">the book is dark — retrying</PanelCopy>}
          {!book.error && !book.data && (
            <PanelCopy id="agora-floor-book-copy">waiting for the book</PanelCopy>
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
        <div data-testid="agora-floor-tape" style={FLOOR_PANEL}>
          <div style={MONO_LABEL}>THE TAPE — {product}</div>
          {trades.error && <PanelCopy id="agora-floor-tape-copy">the tape is dark — retrying</PanelCopy>}
          {!trades.error && !trades.data && (
            <PanelCopy id="agora-floor-tape-copy">waiting for the tape</PanelCopy>
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
                    data-testid="agora-floor-trade-row"
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

// ── Launch-strip button styles (the old card's buttons, re-laid) ─────────────

const STRIP_BTN: CSSProperties = {
  background: "rgba(255,255,255,0.08)",
  border: "1px solid rgba(255,255,255,0.25)",
  borderRadius: 6,
  color: "var(--t1, rgba(255,255,255,0.85))",
  fontFamily: "var(--f-mono, monospace)",
  fontSize: 11,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  padding: "6px 12px",
  cursor: "pointer",
  transition: "background var(--dur-fast, 120ms) var(--ease-out, ease-out)",
  pointerEvents: "auto",
};

export default function AgoraDeck({ interact }: AgoraDeckProps) {
  const reducedMotion = useReducedMotion() ?? false;
  const [opacity, setOpacity] = useState(reducedMotion ? 1 : 0);
  const [probeState, setProbeState] = useState<ProbeState>("probing");
  const [launchState, setLaunchState] = useState<LaunchState>("idle");
  const [startError, setStartError] = useState<string | null>(null);
  const [engineHealth, setEngineHealth] = useState<"probing" | "healthy" | "down">("probing");
  const [logs, setLogs] = useState<string[]>([]);
  const [product, setProduct] = useState<AgoraProduct>(() => getFloorProduct());
  const agoraUrl = getAgoraUrl();

  // Monotonic probe id: a settled probe only writes state if it is still the
  // LATEST probe AND the component is mounted.
  const probeSeq = useRef(0);
  const mountedRef = useRef(true);
  const ignitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ignitionIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const logIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const probe = useCallback(async () => {
    const seq = ++probeSeq.current;
    setProbeState("probing");
    try {
      await fetch(agoraUrl, {
        mode: "no-cors",
        signal: timeoutSignal(2000),
      });
      if (mountedRef.current && seq === probeSeq.current) setProbeState("reachable");
    } catch {
      if (mountedRef.current && seq === probeSeq.current) setProbeState("unreachable");
    }
  }, [agoraUrl]);

  const probeEngine = useCallback(async () => {
    try {
      const res = await fetch("http://localhost:8080/health", { signal: timeoutSignal(2000) });
      const json = await res.json();
      if (mountedRef.current) setEngineHealth(json.ok === true ? "healthy" : "down");
    } catch {
      if (mountedRef.current) setEngineHealth("down");
    }
  }, []);

  // Clear ignition timers helper
  const clearIgnitionTimers = useCallback(() => {
    if (ignitionTimerRef.current) {
      clearTimeout(ignitionTimerRef.current);
      ignitionTimerRef.current = null;
    }
    if (ignitionIntervalRef.current) {
      clearInterval(ignitionIntervalRef.current);
      ignitionIntervalRef.current = null;
    }
    if (logIntervalRef.current) {
      clearInterval(logIntervalRef.current);
      logIntervalRef.current = null;
    }
  }, []);

  // Probe on mount (and re-probe when deck re-activates via key change)
  useEffect(() => {
    mountedRef.current = true;
    probe();
    return () => {
      mountedRef.current = false;
      clearIgnitionTimers();
    };
  }, [probe, clearIgnitionTimers]);

  // Engine health interval — only while reachable
  useEffect(() => {
    if (probeState !== "reachable") return;
    probeEngine();
    const id = setInterval(probeEngine, 60_000);
    return () => clearInterval(id);
  }, [probeState, probeEngine]);

  // Reset engine health when leaving reachable
  useEffect(() => {
    if (probeState !== "reachable") setEngineHealth("probing");
  }, [probeState]);

  // Fade entrance
  useEffect(() => {
    if (reducedMotion || probeState !== "reachable") return;
    const raf = requestAnimationFrame(() => setOpacity(1));
    return () => cancelAnimationFrame(raf);
  }, [reducedMotion, probeState]);

  // Reset opacity when we transition back to probing
  useEffect(() => {
    if (probeState === "probing" || probeState === "unreachable") {
      if (!reducedMotion) setOpacity(0);
    }
  }, [probeState, reducedMotion]);

  // When igniting becomes reachable, clear ignition state
  useEffect(() => {
    if (probeState === "reachable" && launchState === "igniting") {
      clearIgnitionTimers();
      setLaunchState("idle");
    }
  }, [probeState, launchState, clearIgnitionTimers]);

  const handleStart = useCallback(async () => {
    setLaunchState("igniting");
    setStartError(null);
    setLogs([]);

    const path = getAgoraPath();

    try {
      await agoraStart(path);
    } catch (err) {
      // A rejected agora_start means nothing spawned — skip the probe loop
      // entirely and surface the reason instead of 45s of false hope.
      if (mountedRef.current) {
        setStartError(startErrorMessage(err));
        setLaunchState("spawn-failed");
        setProbeState("unreachable");
      }
      return;
    }

    // Poll logs every 2s
    logIntervalRef.current = setInterval(async () => {
      try {
        const lines = await agoraLogs();
        if (mountedRef.current) setLogs(lines);
      } catch {
        // Ignore log fetch errors
      }
    }, 2000);

    // Auto-probe every 2s while igniting
    ignitionIntervalRef.current = setInterval(async () => {
      const seq = ++probeSeq.current;
      try {
        await fetch(agoraUrl, {
          mode: "no-cors",
          signal: timeoutSignal(2000),
        });
        if (mountedRef.current && seq === probeSeq.current) {
          clearIgnitionTimers();
          setProbeState("reachable");
          setLaunchState("idle");
        }
      } catch {
        // Not reachable yet — keep igniting
      }
    }, 2000);

    // 45s timeout → still dark
    ignitionTimerRef.current = setTimeout(() => {
      if (mountedRef.current) {
        clearIgnitionTimers();
        setLaunchState("still-dark");
        setProbeState("unreachable");
      }
    }, 45_000);
  }, [agoraUrl, clearIgnitionTimers]);

  const handleStop = useCallback(async () => {
    clearIgnitionTimers();
    setLaunchState("idle");
    try {
      await agoraStop();
    } catch {
      // Ignore stop errors
    }
    // Re-probe — will land at unreachable
    probe();
  }, [probe, clearIgnitionTimers]);

  const handleRetry = useCallback(() => {
    setLaunchState("idle");
    setStartError(null);
    probe();
  }, [probe]);

  const handleProduct = useCallback((p: AgoraProduct) => {
    setProduct(p);
    try {
      setSetting("deck.agora.product", p);
    } catch {
      // settings unavailable — the floor still switches for this session
    }
  }, []);

  // ── Render helpers ──────────────────────────────────────────────────────────

  const lastThreeLogs = logs.slice(-3);

  return (
    <div
      data-testid="agora-deck"
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
      }}
    >
      {probeState === "probing" && launchState === "idle" && (
        <div
          data-testid="agora-probing"
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "center",
            paddingBottom: "26vh",
            pointerEvents: "none",
          }}
        >
          <span
            style={{
              fontFamily: "var(--f-mono, monospace)",
              fontSize: 11,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: "var(--t3, rgba(255,255,255,0.35))",
            }}
          >
            PROBING...
          </span>
        </div>
      )}

      {/* THE FLOOR — LOOM's native exchange surface whenever AGORA is dark.
          The launch strip (the old offline card, compressed) docks at the top;
          while igniting, the strip carries the ignition state over the live floor. */}
      {probeState === "unreachable" && (
        <div
          data-testid="agora-floor"
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "auto",
            background: "linear-gradient(180deg, rgba(6,11,24,0.92), rgba(6,11,24,0.98))",
            display: "flex",
            flexDirection: "column",
            gap: 10,
            // 52px top clears the shell top-bar's pill cluster (~48px of glass
            // chrome) — the launch strip carries buttons and must stay hittable.
            padding: "52px 16px 16px",
          }}
        >
          {launchState === "igniting" ? (
            <div
              data-testid="agora-igniting"
              style={{
                background: "var(--glass-raised, rgba(255,255,255,0.06))",
                border: "1px solid var(--glass-border, rgba(255,255,255,0.1))",
                boxShadow: "var(--shadow-1, 0 4px 16px rgba(0,0,0,0.3))",
                borderRadius: 10,
                padding: "10px 14px",
                display: "flex",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <div
                style={{
                  fontFamily: "var(--f-mono, monospace)",
                  fontSize: 11,
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  color: "var(--t2, rgba(255,255,255,0.6))",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  flexShrink: 0,
                }}
              >
                <span
                  style={{
                    display: "inline-block",
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: "rgba(255,255,255,0.4)",
                    animation: "pulse 1s ease-in-out infinite",
                  }}
                />
                IGNITING THE EXCHANGE
              </div>
              {lastThreeLogs.length > 0 && (
                <div
                  style={{
                    fontFamily: "var(--f-mono, monospace)",
                    fontSize: 10,
                    color: "rgba(255,255,255,0.35)",
                    lineHeight: 1.6,
                    display: "flex",
                    flexDirection: "column",
                    gap: 2,
                    minWidth: 0,
                    flex: 1,
                  }}
                >
                  {lastThreeLogs.map((line, i) => (
                    <div
                      key={i}
                      style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    >
                      {line}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div
              data-testid="agora-offline-card"
              style={{
                background: "var(--glass-raised, rgba(255,255,255,0.06))",
                border: "1px solid var(--glass-border, rgba(255,255,255,0.1))",
                boxShadow: "var(--shadow-1, 0 4px 16px rgba(0,0,0,0.3))",
                borderRadius: 10,
                padding: "10px 14px",
                display: "flex",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <div
                style={{
                  fontFamily: "var(--f-mono, monospace)",
                  fontSize: 11,
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  color: "var(--t2, rgba(255,255,255,0.6))",
                  flexShrink: 0,
                }}
              >
                THE EXCHANGE IS DARK
              </div>
              <div
                style={{
                  fontFamily: "var(--f-mono, monospace)",
                  fontSize: 12,
                  color: "var(--t1, rgba(255,255,255,0.85))",
                  lineHeight: 1.5,
                }}
              >
                AGORA is not running.
              </div>
              <div
                style={{
                  fontFamily: "var(--f-mono, monospace)",
                  fontSize: 10,
                  color: "var(--t3, rgba(255,255,255,0.35))",
                  lineHeight: 1.5,
                }}
              >
                Postgres must be running (Postgres.app).
              </div>
              {launchState === "still-dark" && (
                <div
                  style={{
                    fontFamily: "var(--f-mono, monospace)",
                    fontSize: 11,
                    color: "var(--danger, #ef4444)",
                    letterSpacing: "0.08em",
                  }}
                >
                  STILL DARK — exchange did not come up in 45s.
                </div>
              )}
              {launchState === "spawn-failed" && startError && (
                <div
                  data-testid="agora-spawn-error"
                  style={{
                    fontFamily: "var(--f-mono, monospace)",
                    fontSize: 11,
                    color: "var(--danger, #ef4444)",
                    letterSpacing: "0.08em",
                    lineHeight: 1.5,
                    wordBreak: "break-word",
                  }}
                >
                  COULD NOT IGNITE — {startError}
                </div>
              )}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginLeft: "auto" }}>
                <button
                  data-testid="agora-start-btn"
                  onClick={handleStart}
                  style={STRIP_BTN}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.14)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.08)";
                  }}
                >
                  START
                </button>
                <button
                  data-testid="agora-retry-btn"
                  onClick={handleRetry}
                  style={{
                    ...STRIP_BTN,
                    background: "transparent",
                    border: "1px solid rgba(255,255,255,0.18)",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.08)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                  }}
                  onMouseDown={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.12)";
                  }}
                  onMouseUp={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.08)";
                  }}
                >
                  RETRY
                </button>
                {launchState === "still-dark" && (
                  <button
                    data-testid="agora-stop-btn-still-dark"
                    onClick={handleStop}
                    style={{
                      ...STRIP_BTN,
                      background: "transparent",
                      border: "1px solid rgba(239,68,68,0.4)",
                      color: "var(--danger, #ef4444)",
                    }}
                  >
                    STOP
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Keyed by product: chip switches remount the floor — clean poll restart. */}
          <Floor key={product} product={product} onProduct={handleProduct} />
        </div>
      )}

      {probeState === "reachable" && (
        <>
          <div
            data-testid="agora-health-strip"
            style={{
              position: "absolute",
              top: 8,
              right: 12,
              zIndex: 2,
              display: "flex",
              gap: 4,
              alignItems: "center",
              pointerEvents: "auto",
            }}
          >
            {/* WEB chip */}
            <div
              data-testid="agora-health-web"
              style={{
                background: "var(--glass, rgba(255,255,255,0.05))",
                border: "1px solid var(--glass-border, rgba(255,255,255,0.1))",
                borderRadius: 999,
                padding: "2px 8px 2px 6px",
                display: "flex",
                alignItems: "center",
                gap: 4,
                backdropFilter: "blur(8px)",
                WebkitBackdropFilter: "blur(8px)",
                pointerEvents: "none",
              }}
            >
              <div style={{ width: 6, height: 6, borderRadius: 999, background: "#4ade80", flexShrink: 0 }} />
              <span style={{ fontFamily: "var(--f-mono, monospace)", fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--t2, rgba(255,255,255,0.6))" }}>WEB</span>
            </div>
            {/* ENGINE chip */}
            <div
              data-testid="agora-health-engine"
              style={{
                background: "var(--glass, rgba(255,255,255,0.05))",
                border: "1px solid var(--glass-border, rgba(255,255,255,0.1))",
                borderRadius: 999,
                padding: "2px 8px 2px 6px",
                display: "flex",
                alignItems: "center",
                gap: 4,
                backdropFilter: "blur(8px)",
                WebkitBackdropFilter: "blur(8px)",
                pointerEvents: "none",
              }}
            >
              <div
                data-health={engineHealth}
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 999,
                  background:
                    engineHealth === "healthy"
                      ? "#4ade80"
                      : engineHealth === "down"
                      ? "var(--danger, #ef4444)"
                      : "rgba(255,255,255,0.2)",
                  flexShrink: 0,
                }}
              />
              <span style={{ fontFamily: "var(--f-mono, monospace)", fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--t2, rgba(255,255,255,0.6))" }}>ENGINE</span>
            </div>
            {/* STOP chip */}
            <button
              data-testid="agora-stop-btn"
              onClick={handleStop}
              title="Stop AGORA"
              style={{
                background: "var(--glass, rgba(255,255,255,0.05))",
                border: "1px solid var(--glass-border, rgba(255,255,255,0.1))",
                borderRadius: 999,
                padding: "2px 10px",
                display: "flex",
                alignItems: "center",
                gap: 4,
                backdropFilter: "blur(8px)",
                WebkitBackdropFilter: "blur(8px)",
                cursor: "pointer",
                fontFamily: "var(--f-mono, monospace)",
                fontSize: 9,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: "var(--t2, rgba(255,255,255,0.6))",
                transition: "background var(--dur-fast, 120ms) var(--ease-out, ease-out)",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.1)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = "var(--glass, rgba(255,255,255,0.05))";
              }}
            >
              STOP
            </button>
          </div>
          <iframe
            src={agoraUrl}
            sandbox="allow-scripts allow-same-origin allow-forms"
            title="AGORA Exchange"
            data-testid="agora-deck-iframe"
            style={{
              width: "100%",
              height: "100%",
              border: "none",
              display: "block",
              opacity: reducedMotion ? 1 : opacity,
              transition: reducedMotion ? "none" : "opacity 400ms ease",
              pointerEvents: interact ? "auto" : "none",
              transform: "translateZ(0)",
            }}
          />
        </>
      )}
    </div>
  );
}
