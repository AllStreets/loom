/**
 * WatchPanel.tsx
 *
 * Collapsible right-side glass panel showing the salience feed.
 * Opened/closed by the WATCH button in the top bar.
 *
 * Props:
 *   open: boolean — controlled by Shell's WATCH toggle
 *   onClose: () => void — called when panel requests close
 *
 * Sizing:
 *   - Fixed right, top below header (top: 64px), maxWidth 380
 *   - z 900: below dock (1000), above desktop plane (100)
 *   - pointerEvents auto only on the panel element itself
 *
 * Data flow:
 *   - Subscribes to loom-salience CustomEvent to update the list
 *   - Reads getSalient() on mount for initial state
 *   - Engagement: recordEngagement writes to store; open = clipboard copy
 *     (no Tauri opener plugin required — clipboard is safe in WebView)
 *
 * No per-frame React state — list updates are coarse (loom-salience fires only
 * when top-10 ordering changes, ~120s interval).
 */

import { useState, useEffect, useCallback } from "react";
import type { ScoredEvent } from "../lib/watch/types";
import type { WatchlistEntry } from "../lib/watch/store";
import { getSalient } from "../lib/watch/runtime";
import {
  recordEngagement,
  addWatchlistEntry,
  removeWatchlistEntry,
  getWatchlist,
} from "../lib/watch/store";

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

  return (
    <div
      data-testid="watch-row"
      data-item-id={item.id}
      style={{
        padding: "10px 12px",
        borderBottom: "1px solid rgba(255,255,255,0.04)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      {/* Title row */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, minWidth: 0 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            title={item.title}
            style={{
              fontFamily: "var(--f-mono, monospace)",
              fontSize: 11,
              color: "var(--t1, #e2e8f0)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              lineHeight: 1.4,
            }}
          >
            {item.title}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
            <span
              style={{
                fontFamily: "var(--f-mono, monospace)",
                fontSize: 9,
                color: "var(--t3, #64748b)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}
            >
              {item.source}
            </span>
            <span
              style={{
                fontFamily: "var(--f-mono, monospace)",
                fontSize: 9,
                color: "var(--t3, #64748b)",
              }}
            >
              {relAge(item.publishedAt)}
            </span>
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
          {item.url && (
            <button
              data-testid="watch-open-btn"
              onClick={handleOpen}
              title="Copy URL"
              style={actionBtnStyle("#22d3ee")}
            >
              URL
            </button>
          )}
          <button
            data-testid="watch-plus-btn"
            onClick={handleWatchPlus}
            title="Add to watchlist"
            style={actionBtnStyle("#4ade80")}
          >
            +W
          </button>
          <button
            data-testid="watch-dismiss-btn"
            onClick={handleDismiss}
            title="Dismiss"
            style={actionBtnStyle("#64748b")}
          >
            X
          </button>
        </div>
      </div>

      {/* Score bar */}
      <div
        data-testid="score-bar"
        style={{
          height: 2,
          background: "rgba(255,255,255,0.06)",
          borderRadius: 1,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${scoreBarPct}%`,
            background: "var(--accent, #22d3ee)",
            borderRadius: 1,
            transition: "width 0.4s ease",
          }}
        />
      </div>

      {/* Expandable reasons */}
      {item.reasons.length > 0 && (
        <div>
          <button
            data-testid="watch-expand-btn"
            onClick={() => setExpanded((p) => !p)}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              fontFamily: "var(--f-mono, monospace)",
              fontSize: 9,
              color: "var(--t3, #64748b)",
              padding: 0,
              letterSpacing: "0.06em",
            }}
          >
            {expanded ? "- reasons" : "+ reasons"}
          </button>
          {expanded && (
            <ul
              data-testid="watch-reasons-list"
              style={{ margin: "4px 0 0", padding: "0 0 0 12px", listStyle: "disc" }}
            >
              {item.reasons.map((r, i) => (
                <li
                  key={i}
                  style={{
                    fontFamily: "var(--f-mono, monospace)",
                    fontSize: 9,
                    color: "var(--t3, #64748b)",
                    lineHeight: 1.6,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {r}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function actionBtnStyle(color: string): React.CSSProperties {
  return {
    fontFamily: "var(--f-mono, monospace)",
    fontSize: 8,
    letterSpacing: "0.06em",
    color,
    background: `${color}14`,
    border: `1px solid ${color}30`,
    borderRadius: 4,
    cursor: "pointer",
    padding: "2px 5px",
    lineHeight: 1.4,
  };
}

// ── Watchlist chips ────────────────────────────────────────────────────────────

type Kind = WatchlistEntry["kind"];

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
        padding: "8px 12px",
        borderBottom: "1px solid rgba(255,255,255,0.06)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      {/* Add row */}
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <select
          data-testid="watchlist-kind-select"
          value={kind}
          onChange={(e) => setKind(e.target.value as Kind)}
          style={{
            fontFamily: "var(--f-mono, monospace)",
            fontSize: 9,
            color: "var(--t3, #64748b)",
            background: "rgba(6,11,24,0.8)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 4,
            padding: "2px 4px",
            cursor: "pointer",
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
          placeholder="add to watch..."
          style={{
            flex: 1,
            minWidth: 0,
            fontFamily: "var(--f-mono, monospace)",
            fontSize: 9,
            color: "var(--t1, #e2e8f0)",
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 4,
            padding: "3px 6px",
            outline: "none",
          }}
        />
        <button
          data-testid="watchlist-add-btn"
          onClick={handleAdd}
          style={{
            fontFamily: "var(--f-mono, monospace)",
            fontSize: 9,
            color: "var(--accent, #22d3ee)",
            background: "rgba(34,211,238,0.08)",
            border: "1px solid rgba(34,211,238,0.2)",
            borderRadius: 4,
            cursor: "pointer",
            padding: "3px 6px",
          }}
        >
          +
        </button>
      </div>

      {/* Chips */}
      {entries.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {entries.map((entry) => (
            <div
              key={`${entry.kind}:${entry.value}`}
              data-testid="watchlist-chip"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 3,
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 999,
                padding: "2px 7px",
                maxWidth: 140,
              }}
            >
              <span
                style={{
                  fontFamily: "var(--f-mono, monospace)",
                  fontSize: 8,
                  color: "var(--t3, #64748b)",
                  flexShrink: 0,
                }}
              >
                {entry.kind[0]}:
              </span>
              <span
                title={entry.value}
                style={{
                  fontFamily: "var(--f-mono, monospace)",
                  fontSize: 8,
                  color: "var(--t2, #94a3b8)",
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
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--t3, #64748b)",
                  fontSize: 9,
                  lineHeight: 1,
                  padding: 0,
                  flexShrink: 0,
                }}
              >
                x
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

  // Subscribe to salience events
  useEffect(() => {
    function onSalience(ev: Event) {
      const detail = (ev as CustomEvent<{ items: ScoredEvent[] }>).detail;
      if (!detail?.items) return;
      setItems(detail.items.slice(0, 20));
    }
    window.addEventListener("loom-salience", onSalience);
    return () => window.removeEventListener("loom-salience", onSalience);
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
        top: 64,
        right: 0,
        width: 340,
        maxWidth: "90vw",
        maxHeight: "calc(100vh - 80px)",
        display: "flex",
        flexDirection: "column",
        // z 900: below dock (1000), above desktop plane (100)
        zIndex: 900,
        background: "rgba(6,11,24,0.92)",
        backdropFilter: "blur(18px)",
        WebkitBackdropFilter: "blur(18px)",
        border: "1px solid rgba(255,255,255,0.07)",
        borderRight: "none",
        borderRadius: "12px 0 0 12px",
        boxShadow: "-8px 0 32px rgba(0,0,0,0.4)",
        overflow: "hidden",
        pointerEvents: "auto",
        opacity: 0.97,
      }}
    >
      {/* Panel header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 12px 8px",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontFamily: "var(--f-mono, monospace)",
            fontSize: 10,
            letterSpacing: "0.1em",
            color: "var(--accent, #22d3ee)",
            textTransform: "uppercase",
          }}
        >
          Watch Feed
        </span>
        <button
          data-testid="watch-panel-close"
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--t3, #64748b)",
            fontFamily: "var(--f-mono, monospace)",
            fontSize: 11,
            padding: "2px 4px",
          }}
        >
          X
        </button>
      </div>

      {/* Watchlist chips */}
      <WatchlistChips />

      {/* Feed list */}
      <div
        data-testid="watch-feed"
        style={{
          flex: 1,
          overflowY: "auto",
          scrollbarWidth: "thin",
          scrollbarColor: "rgba(255,255,255,0.08) transparent",
        }}
      >
        {visibleItems.length === 0 ? (
          <div
            data-testid="watch-empty-state"
            style={{
              padding: "32px 16px",
              textAlign: "center",
              fontFamily: "var(--f-mono, monospace)",
              fontSize: 11,
              color: "var(--t3, #64748b)",
              letterSpacing: "0.06em",
            }}
          >
            the watch is quiet
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
