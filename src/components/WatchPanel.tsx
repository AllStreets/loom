/**
 * WatchPanel.tsx — "THE WATCH"
 *
 * Floating right-side glass-raised panel showing the salience feed. Redesigned
 * against LOOM's micro design language: 4px grid, mono-for-data type hierarchy,
 * accent discipline (cyan = live/selected only), hover-revealed icon actions.
 *
 * Opened/closed by the WATCH segment in the top bar.
 *
 * Props:
 *   open: boolean — controlled by Shell's WATCH toggle
 *   onClose: () => void — called when panel requests close
 *
 * Sizing:
 *   - Fixed, width 360, inset right/bottom 16, top 72 (breathing room — NOT flush)
 *   - z 900: below dock (1000), above desktop plane (100)
 *   - pointerEvents auto only on the panel element itself
 *
 * Data flow:
 *   - Subscribes to loom-salience CustomEvent to update the list
 *   - Reads getSalient() on mount for initial state
 *   - Engagement: recordEngagement writes to store; open = clipboard copy
 *     (no Tauri opener plugin required — clipboard is safe in WebView)
 *   - The live dot pulses on fresh salience (reduced-motion → static)
 *
 * No per-frame React state — list updates are coarse (loom-salience fires only
 * when top-10 ordering changes, ~120s interval).
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type { ScoredEvent } from "../lib/watch/types";
import type { WatchlistEntry } from "../lib/watch/store";
import { getSalient } from "../lib/watch/runtime";
import {
  recordEngagement,
  addWatchlistEntry,
  removeWatchlistEntry,
  getWatchlist,
} from "../lib/watch/store";
import { IconX, IconPlus, IconCopy, IconChevron, IconWatch } from "./chrome/icons";

// ── Style-injection: hover reveals, thin scrollbar, live-dot pulse ──────────────

const STYLE_ID = "loom-watch-panel-style";

function ensureStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .loom-watch-scroll::-webkit-scrollbar { width: 8px; }
    .loom-watch-scroll::-webkit-scrollbar-track { background: transparent; }
    .loom-watch-scroll::-webkit-scrollbar-thumb {
      background: rgba(255,255,255,.08);
      border-radius: 999px;
      border: 2px solid transparent;
      background-clip: padding-box;
    }
    .loom-watch-scroll::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,.16); background-clip: padding-box; }

    .loom-watch-row { transition: background var(--dur-fast, .15s) var(--ease-out, ease); }
    .loom-watch-row:hover { background: rgba(255,255,255,.03); }
    .loom-watch-row .loom-row-actions { opacity: 0; transition: opacity var(--dur-fast, .15s) var(--ease-out, ease); }
    .loom-watch-row:hover .loom-row-actions,
    .loom-watch-row:focus-within .loom-row-actions { opacity: 1; }

    .loom-icon-btn {
      display: inline-flex; align-items: center; justify-content: center;
      width: 22px; height: 22px; border-radius: 6px;
      background: transparent; border: 1px solid transparent;
      color: var(--t3, #5f6f8c); cursor: pointer; padding: 0;
      transition: background var(--dur-fast, .15s) var(--ease-out, ease),
                  color var(--dur-fast, .15s) var(--ease-out, ease),
                  border-color var(--dur-fast, .15s) var(--ease-out, ease);
    }
    .loom-icon-btn:hover { background: rgba(255,255,255,.06); color: var(--t1, #e8edf7); border-color: var(--glass-border, rgba(255,255,255,.08)); }
    .loom-icon-btn.is-accent:hover { color: var(--accent, #22d3ee); }
    .loom-icon-btn.is-go:hover { color: var(--go, #4ade80); }

    .loom-watch-chevron { transition: transform var(--dur-fast, .15s) var(--ease-out, ease); }
    .loom-watch-chevron.is-open { transform: rotate(90deg); }

    .loom-watch-livedot { animation: loom-watch-pulse 2.4s var(--ease-out, ease) infinite; }
    @keyframes loom-watch-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(34,211,238,.5); opacity: 1; }
      50% { box-shadow: 0 0 0 4px rgba(34,211,238,0); opacity: .55; }
    }
    .loom-watch-livedot.is-fresh { animation-duration: .9s; }

    @media (prefers-reduced-motion: reduce) {
      .loom-watch-row, .loom-watch-row .loom-row-actions,
      .loom-icon-btn, .loom-watch-chevron { transition: none !important; }
      .loom-watch-livedot { animation: none !important; }
      .loom-watch-row .loom-row-actions { opacity: 1 !important; }
    }
  `;
  document.head.appendChild(style);
}

// ── Time formatting ────────────────────────────────────────────────────────────

function relAge(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "<1m";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

// ── Category → tint (accent discipline: neutral hues, no yellow) ────────────────

function categoryTint(category: string): string {
  const c = category.toLowerCase();
  if (c.startsWith("seismic")) return "#f87171"; // danger family — quakes
  if (c === "finance") return "#4ade80";
  if (c === "military" || c === "cyber") return "#f97316";
  if (c === "space" || c === "launch") return "#a78bfa";
  if (c === "climate" || c === "fire" || c === "flood" || c === "drought")
    return "#22d3ee";
  if (c === "tech" || c === "science" || c === "physics") return "#7dd3fc";
  return "#9fb0cc"; // t2 neutral
}

// ── Row component ─────────────────────────────────────────────────────────────

interface RowProps {
  item: ScoredEvent;
  onDismiss: (id: string) => void;
  onWatchPlus: (item: ScoredEvent) => void;
}

function WatchRow({ item, onDismiss, onWatchPlus }: RowProps) {
  const [expanded, setExpanded] = useState(false);

  function handleOpen() {
    recordEngagement({ eventKey: item.id, action: "open", ts: Date.now() });
    if (item.url) {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        navigator.clipboard.writeText(item.url).catch(() => {});
      }
    }
  }

  function handleDismiss() {
    recordEngagement({ eventKey: item.id, action: "dismiss", ts: Date.now() });
    onDismiss(item.id);
  }

  function handleWatchPlus() {
    onWatchPlus(item);
  }

  const scoreBarPct = Math.round(item.score * 100);
  const tint = categoryTint(item.category);
  const hasReasons = item.reasons.length > 0;

  return (
    <div
      data-testid="watch-row"
      data-item-id={item.id}
      className="loom-watch-row"
      style={{
        padding: "12px 16px",
        borderBottom: "1px solid var(--line, rgba(255,255,255,.06))",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      {/* Title + actions */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, minWidth: 0 }}>
        <div
          title={item.title}
          style={{
            flex: 1,
            minWidth: 0,
            fontFamily: "var(--f-mono, monospace)",
            fontSize: 13,
            lineHeight: 1.38,
            color: "var(--t1, #e8edf7)",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {item.title}
        </div>

        <div
          className="loom-row-actions"
          style={{ display: "flex", gap: 2, flexShrink: 0, marginTop: -2 }}
        >
          {item.url && (
            <button
              data-testid="watch-open-btn"
              onClick={handleOpen}
              title="Copy link"
              aria-label="Copy link"
              className="loom-icon-btn is-accent"
            >
              <IconCopy size={13} strokeWidth={1.75} />
            </button>
          )}
          <button
            data-testid="watch-plus-btn"
            onClick={handleWatchPlus}
            title="Add to watchlist"
            aria-label="Add to watchlist"
            className="loom-icon-btn is-go"
          >
            <IconWatch size={13} strokeWidth={1.6} />
          </button>
          <button
            data-testid="watch-dismiss-btn"
            onClick={handleDismiss}
            title="Dismiss"
            aria-label="Dismiss"
            className="loom-icon-btn"
          >
            <IconX size={13} strokeWidth={1.75} />
          </button>
        </div>
      </div>

      {/* Meta row: source badge · age · category tint */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <span
          style={{
            fontFamily: "var(--f-mono, monospace)",
            fontSize: 9,
            letterSpacing: ".08em",
            textTransform: "uppercase",
            color: "var(--t2, #9fb0cc)",
            background: "rgba(255,255,255,.05)",
            border: "1px solid var(--glass-border, rgba(255,255,255,.08))",
            borderRadius: 4,
            padding: "1px 6px",
            flexShrink: 0,
          }}
        >
          {item.source}
        </span>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontFamily: "var(--f-mono, monospace)",
            fontSize: 10,
            letterSpacing: ".04em",
            color: "var(--t3, #5f6f8c)",
            fontVariantNumeric: "tabular-nums",
          }}
          title={item.category}
        >
          <span
            aria-hidden
            style={{
              width: 5,
              height: 5,
              borderRadius: "50%",
              background: tint,
              boxShadow: `0 0 5px ${tint}80`,
              flexShrink: 0,
            }}
          />
          {relAge(item.publishedAt)}
        </span>
      </div>

      {/* Score bar + tabular pct */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div
          data-testid="score-bar"
          style={{
            flex: 1,
            height: 2,
            background: "rgba(255,255,255,.06)",
            borderRadius: 999,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${scoreBarPct}%`,
              background: "var(--accent, #22d3ee)",
              borderRadius: 999,
              transition: "width var(--dur-slow, .4s) var(--ease-out, ease)",
            }}
          />
        </div>
        <span
          style={{
            fontFamily: "var(--f-mono, monospace)",
            fontSize: 10,
            color: "var(--t2, #9fb0cc)",
            fontVariantNumeric: "tabular-nums",
            width: 34,
            textAlign: "right",
            flexShrink: 0,
          }}
        >
          {scoreBarPct}%
        </span>
      </div>

      {/* Expandable reasons */}
      {hasReasons && (
        <div>
          <button
            data-testid="watch-expand-btn"
            onClick={() => setExpanded((p) => !p)}
            aria-expanded={expanded}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              background: "none",
              border: "none",
              cursor: "pointer",
              fontFamily: "var(--f-mono, monospace)",
              fontSize: 10,
              color: "var(--t3, #5f6f8c)",
              padding: 0,
              letterSpacing: ".06em",
              textTransform: "uppercase",
            }}
          >
            <IconChevron
              size={11}
              strokeWidth={2}
              className={`loom-watch-chevron${expanded ? " is-open" : ""}`}
            />
            {item.reasons.length} {item.reasons.length === 1 ? "reason" : "reasons"}
          </button>
          {expanded && (
            <ul
              data-testid="watch-reasons-list"
              style={{
                margin: "6px 0 0",
                padding: 0,
                listStyle: "none",
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              {item.reasons.map((r, i) => (
                <li
                  key={i}
                  style={{
                    display: "flex",
                    gap: 6,
                    fontFamily: "var(--f-mono, monospace)",
                    fontSize: 10,
                    color: "var(--t3, #5f6f8c)",
                    lineHeight: 1.5,
                  }}
                >
                  <span aria-hidden style={{ color: "var(--accent, #22d3ee)", opacity: 0.55 }}>
                    ·
                  </span>
                  <span style={{ minWidth: 0 }}>{r}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ── Watchlist chips ────────────────────────────────────────────────────────────

type Kind = WatchlistEntry["kind"];

const KIND_GLYPH: Record<Kind, string> = {
  topic: "#",
  place: "@",
  entity: "&",
  source: "/",
};

function WatchlistChips() {
  const [entries, setEntries] = useState<WatchlistEntry[]>(() => {
    try { return getWatchlist(); } catch { return []; }
  });
  const [inputVal, setInputVal] = useState("");
  const [kind, setKind] = useState<Kind>("topic");

  function handleAdd() {
    const val = inputVal.trim();
    if (!val) return;
    const updated = addWatchlistEntry({ kind, value: val });
    setEntries(updated);
    setInputVal("");
  }

  function handleRemove(entry: WatchlistEntry) {
    const updated = removeWatchlistEntry(entry.kind, entry.value);
    setEntries(updated);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") handleAdd();
  }

  return (
    <div
      data-testid="watchlist-chips"
      style={{
        padding: "12px 16px",
        borderBottom: "1px solid var(--line, rgba(255,255,255,.06))",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <span
        style={{
          fontFamily: "var(--f-mono, monospace)",
          fontSize: 10,
          letterSpacing: ".12em",
          textTransform: "uppercase",
          color: "var(--t3, #5f6f8c)",
        }}
      >
        Watchlist
      </span>

      {/* Add row */}
      <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
        <select
          data-testid="watchlist-kind-select"
          value={kind}
          onChange={(e) => setKind(e.target.value as Kind)}
          aria-label="Watchlist entry kind"
          style={{
            fontFamily: "var(--f-mono, monospace)",
            fontSize: 10,
            color: "var(--t2, #9fb0cc)",
            background: "rgba(6,11,24,.6)",
            border: "1px solid var(--glass-border, rgba(255,255,255,.08))",
            borderRadius: 6,
            padding: "0 4px",
            cursor: "pointer",
            outline: "none",
          }}
        >
          <option value="topic">topic</option>
          <option value="place">place</option>
          <option value="entity">entity</option>
          <option value="source">source</option>
        </select>
        <input
          data-testid="watchlist-input"
          type="text"
          value={inputVal}
          onChange={(e) => setInputVal(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="add to watch…"
          style={{
            flex: 1,
            minWidth: 0,
            fontFamily: "var(--f-mono, monospace)",
            fontSize: 11,
            color: "var(--t1, #e8edf7)",
            background: "rgba(255,255,255,.04)",
            border: "1px solid var(--glass-border, rgba(255,255,255,.08))",
            borderRadius: 6,
            padding: "5px 8px",
            outline: "none",
          }}
        />
        <button
          data-testid="watchlist-add-btn"
          onClick={handleAdd}
          aria-label="Add watchlist entry"
          className="loom-icon-btn is-accent"
          style={{ width: 28, flexShrink: 0 }}
        >
          <IconPlus size={14} strokeWidth={2} />
        </button>
      </div>

      {/* Chips */}
      {entries.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {entries.map((entry) => (
            <div
              key={`${entry.kind}:${entry.value}`}
              data-testid="watchlist-chip"
              className="loom-chip"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                background: "rgba(255,255,255,.04)",
                border: "1px solid var(--glass-border, rgba(255,255,255,.08))",
                borderRadius: 999,
                padding: "3px 6px 3px 9px",
                maxWidth: 150,
              }}
            >
              <span
                aria-hidden
                style={{
                  fontFamily: "var(--f-mono, monospace)",
                  fontSize: 10,
                  color: "var(--accent, #22d3ee)",
                  opacity: 0.7,
                  flexShrink: 0,
                }}
                title={entry.kind}
              >
                {KIND_GLYPH[entry.kind]}
              </span>
              <span
                title={`${entry.kind}: ${entry.value}`}
                style={{
                  fontFamily: "var(--f-mono, monospace)",
                  fontSize: 10,
                  color: "var(--t2, #9fb0cc)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  minWidth: 0,
                }}
              >
                {entry.value}
              </span>
              <button
                data-testid="watchlist-chip-remove"
                onClick={() => handleRemove(entry)}
                aria-label={`Remove ${entry.value}`}
                title="Remove"
                className="loom-icon-btn"
                style={{ width: 16, height: 16, flexShrink: 0 }}
              >
                <IconX size={10} strokeWidth={2} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main WatchPanel ────────────────────────────────────────────────────────────

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function WatchPanel({ open, onClose }: Props) {
  const [items, setItems] = useState<ScoredEvent[]>(() => {
    try { return getSalient(20); } catch { return []; }
  });
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [fresh, setFresh] = useState(false);
  const freshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    ensureStyles();
  }, []);

  // Subscribe to salience events
  useEffect(() => {
    function onSalience(ev: Event) {
      const detail = (ev as CustomEvent<{ items: ScoredEvent[] }>).detail;
      if (!detail?.items) return;
      setItems(detail.items.slice(0, 20));
      // Flash the live dot on fresh salience
      setFresh(true);
      if (freshTimer.current) clearTimeout(freshTimer.current);
      freshTimer.current = setTimeout(() => setFresh(false), 2400);
    }
    window.addEventListener("loom-salience", onSalience);
    return () => {
      window.removeEventListener("loom-salience", onSalience);
      if (freshTimer.current) clearTimeout(freshTimer.current);
    };
  }, []);

  const handleDismiss = useCallback((id: string) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const handleWatchPlus = useCallback((item: ScoredEvent) => {
    recordEngagement({ eventKey: item.id, action: "act", ts: Date.now() });
    // Extract a topic from the title (first 3 words)
    const topic = item.title.split(/\s+/).slice(0, 3).join(" ");
    addWatchlistEntry({ kind: "topic", value: topic });
  }, []);

  const visibleItems = items.filter((item) => !dismissed.has(item.id));

  if (!open) return null;

  return (
    <div
      data-testid="watch-panel"
      style={{
        position: "fixed",
        top: 72,
        right: 16,
        bottom: 16,
        width: 360,
        maxWidth: "calc(100vw - 32px)",
        display: "flex",
        flexDirection: "column",
        // z 900: below dock (1000), above desktop plane (100)
        zIndex: 900,
        background: "var(--glass-raised, rgba(16,24,43,.85))",
        backdropFilter: "blur(var(--blur, 18px))",
        WebkitBackdropFilter: "blur(var(--blur, 18px))",
        border: "1px solid var(--glass-border, rgba(255,255,255,.08))",
        borderRadius: 10,
        boxShadow: "var(--shadow-2, 0 8px 32px rgba(0,0,0,.4))",
        overflow: "hidden",
        pointerEvents: "auto",
      }}
    >
      {/* Panel header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "14px 16px",
          borderBottom: "1px solid var(--line, rgba(255,255,255,.06))",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
          <span
            aria-hidden
            className={`loom-watch-livedot${fresh ? " is-fresh" : ""}`}
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: "var(--accent, #22d3ee)",
              flexShrink: 0,
            }}
          />
          <span
            style={{
              fontFamily: "var(--f-mono, monospace)",
              fontSize: 11,
              letterSpacing: ".12em",
              color: "var(--t2, #9fb0cc)",
              textTransform: "uppercase",
            }}
          >
            The Watch
          </span>
        </div>
        <button
          data-testid="watch-panel-close"
          onClick={onClose}
          title="Close"
          aria-label="Close the watch"
          className="loom-icon-btn"
        >
          <IconX size={14} strokeWidth={1.75} />
        </button>
      </div>

      {/* Watchlist chips */}
      <WatchlistChips />

      {/* Feed list */}
      <div
        data-testid="watch-feed"
        className="loom-watch-scroll"
        style={{
          flex: 1,
          overflowY: "auto",
          scrollbarWidth: "thin",
          scrollbarColor: "rgba(255,255,255,.08) transparent",
        }}
      >
        {visibleItems.length === 0 ? (
          <div
            data-testid="watch-empty-state"
            style={{
              height: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              padding: "40px 24px",
              textAlign: "center",
            }}
          >
            <span
              style={{
                fontFamily: "var(--f-mono, monospace)",
                fontSize: 11,
                letterSpacing: ".14em",
                textTransform: "uppercase",
                color: "var(--t2, #9fb0cc)",
              }}
            >
              the watch is quiet
            </span>
            <span
              style={{
                fontFamily: "var(--f-mono, monospace)",
                fontSize: 10,
                lineHeight: 1.55,
                color: "var(--t3, #5f6f8c)",
                maxWidth: 220,
              }}
            >
              The sensors are listening. Salient world events will surface here as they break.
            </span>
          </div>
        ) : (
          visibleItems.map((item) => (
            <WatchRow
              key={item.id}
              item={item}
              onDismiss={handleDismiss}
              onWatchPlus={handleWatchPlus}
            />
          ))
        )}
      </div>
    </div>
  );
}
