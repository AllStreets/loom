/**
 * Shuttle.tsx — the Cmd+K palette. One grammar for voice and hand.
 *
 * The shuttle carries the owner's intent through the machine: a glass overlay
 * listing every command LOOM understands (from src/lib/shuttle/catalog.ts —
 * the same catalog voice discoverability reads), fuzzy-filtered as you type.
 *
 * Execution routes through the EXACT seam voice transcripts take: a
 * `loom-utterance` CustomEvent (spoken: false) that Companion's runTurn
 * consumes — so the orb pulses, confirmations land in the conversation, and
 * free text with no catalog match falls through to companion chat naturally.
 *
 * Keyboard: Cmd+K / Ctrl+K toggles (window CAPTURE phase so it wins over deck
 * iframes while the shell has focus; nothing else is intercepted, so Space
 * PTT and other inputs are untouched). Arrows move, Enter executes, Esc
 * closes, Tab is trapped, click-outside closes. Reduced motion: fade only.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";
import { organList } from "../lib/core";
import {
  buildCatalog,
  fuzzyFilter,
  GROUP_ORDER,
  type CatalogEntry,
  type CatalogGroup,
} from "../lib/shuttle/catalog";

const GROUP_LABELS: Record<CatalogGroup, string> = {
  decks: "DECKS",
  watch: "WATCH",
  build: "BUILD",
  organs: "ORGANS",
  system: "SYSTEM",
};

/** Dispatch a phrase through the same seam voice transcripts take. */
function dispatchUtterance(text: string) {
  window.dispatchEvent(
    new CustomEvent("loom-utterance", { detail: { text, spoken: false } })
  );
}

export default function Shuttle() {
  const reducedMotion = useReducedMotion() ?? false;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selIdx, setSelIdx] = useState(0);
  const [organs, setOrgans] = useState<{ id: string; title: string }[] | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const closingRef = useRef(false);

  // ----- catalog: static entries immediately, organs merged when loaded -----
  const entries = useMemo<CatalogEntry[]>(
    () => buildCatalog(organs ? { organs } : {}),
    [organs]
  );
  const filtered = useMemo(() => fuzzyFilter(query, entries), [query, entries]);

  const close = useCallback(() => {
    closingRef.current = true;
    setOpen(false);
    setQuery("");
    setSelIdx(0);
  }, []);

  const openPalette = useCallback(() => {
    closingRef.current = false;
    setQuery("");
    setSelIdx(0);
    setOpen(true);
  }, []);

  // ----- organ list on open (act path organs; tolerant outside the shell) ----
  useEffect(() => {
    if (!open) return;
    let alive = true;
    organList()
      .then((list) => {
        if (!alive) return;
        const parsed = list
          .map((e) => {
            try {
              const m = JSON.parse(e.manifest) as { id?: string; name?: string };
              return m.id ? { id: m.id, title: m.name ?? m.id } : null;
            } catch {
              return null;
            }
          })
          .filter((o): o is { id: string; title: string } => o !== null);
        setOrgans(parsed);
      })
      .catch(() => {
        // outside the desktop shell (browser dev) — static catalog only
      });
    return () => {
      alive = false;
    };
  }, [open]);

  // ----- global toggle: Cmd/Ctrl+K at window CAPTURE phase ------------------
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        e.stopPropagation();
        setOpen((prev) => {
          if (prev) {
            setQuery("");
            setSelIdx(0);
            return false;
          }
          closingRef.current = false;
          setQuery("");
          setSelIdx(0);
          return true;
        });
      }
    }
    function onOpenEvent() {
      openPalette();
    }
    // CAPTURE phase: the toggle wins over deck iframes / focused panels while
    // the shell document has focus. Only Cmd/Ctrl+K is intercepted — Space
    // PTT and normal typing pass through untouched.
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("loom-shuttle-open", onOpenEvent);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("loom-shuttle-open", onOpenEvent);
    };
  }, [openPalette]);

  // ----- focus the input on open --------------------------------------------
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // ----- selection clamp when the filtered list changes ---------------------
  useEffect(() => {
    setSelIdx((i) => (filtered.length === 0 ? 0 : Math.min(i, filtered.length - 1)));
  }, [filtered.length]);

  // ----- execute ------------------------------------------------------------
  const execute = useCallback(
    (entry: CatalogEntry) => {
      if (entry.kind === "template") {
        // pre-fill the input with the template prefix; the completed text
        // executes as an utterance on the next Enter
        const prefix = entry.phrase.replace(/…\s*$/, "");
        setQuery(prefix);
        setSelIdx(0);
        inputRef.current?.focus();
        return;
      }
      dispatchUtterance(entry.phrase);
      close();
    },
    [close]
  );

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "Tab") {
      // focus trap — the palette is a single-field surface
      e.preventDefault();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filtered.length > 0) setSelIdx((i) => (i + 1) % filtered.length);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filtered.length > 0) setSelIdx((i) => (i - 1 + filtered.length) % filtered.length);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const selected = filtered[selIdx];
      if (selected) {
        execute(selected);
      } else if (query.trim().length > 0) {
        // free text with no catalog match — same seam; it falls through to
        // companion chat naturally
        dispatchUtterance(query.trim());
        close();
      }
      return;
    }
  }

  // keep the selected row visible (jsdom lacks scrollIntoView — guard)
  const selectedRowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    selectedRowRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [selIdx, query]);

  if (!open) return null;

  // group the filtered entries preserving GROUP_ORDER
  const groups = GROUP_ORDER.map((g) => ({
    group: g,
    items: filtered.filter((e) => e.group === g),
  })).filter((g) => g.items.length > 0);

  const headerStyle: React.CSSProperties = {
    fontFamily: "var(--f-mono)",
    color: "var(--t3)",
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: ".08em",
    padding: "10px 14px 4px",
    userSelect: "none",
  };

  return (
    <div
      data-testid="shuttle-palette"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 3000, // above desktop windows (2000), dock (1000), watch panel (900)
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
      }}
    >
      {/* fade-only entrance; reduced motion renders static */}
      <style>{`
        @keyframes loom-shuttle-fade { from { opacity: 0; } to { opacity: 1; } }
        .loom-shuttle-fade { animation: loom-shuttle-fade var(--dur-fast) var(--ease-out) both; }
        @media (prefers-reduced-motion: reduce) { .loom-shuttle-fade { animation: none } }
        .loom-shuttle-row { transition: background var(--dur-fast) var(--ease-out); }
        @media (prefers-reduced-motion: reduce) { .loom-shuttle-row { transition: none } }
      `}</style>

      {/* backdrop — click outside closes */}
      <div
        data-testid="shuttle-backdrop"
        className={reducedMotion ? undefined : "loom-shuttle-fade"}
        onMouseDown={() => {
          // native blur fires before React's synthetic mousedown — flag the
          // close first so the input's focus trap doesn't re-grab focus
          closingRef.current = true;
          close();
        }}
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(6,11,24,.55)",
        }}
      />

      {/* panel */}
      <div
        data-testid="shuttle-panel"
        className={`glass${reducedMotion ? "" : " loom-shuttle-fade"}`}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          position: "relative",
          marginTop: "16vh",
          width: "min(560px, 92vw)",
          maxHeight: "56vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          boxShadow: "var(--shadow-2), var(--shadow-3)",
          background: "var(--glass-raised)",
        }}
      >
        {/* input */}
        <input
          ref={inputRef}
          data-testid="shuttle-input"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelIdx(0);
          }}
          onKeyDown={onInputKeyDown}
          onBlur={() => {
            // focus trap: the input is the only focusable surface while open
            if (!closingRef.current) inputRef.current?.focus();
          }}
          placeholder="type a command — or anything for the companion"
          aria-label="shuttle command input"
          spellCheck={false}
          autoComplete="off"
          style={{
            flexShrink: 0,
            width: "100%",
            background: "transparent",
            border: "none",
            borderBottom: "1px solid var(--glass-border)",
            outline: "none",
            color: "var(--t1)",
            fontFamily: "var(--f-mono)",
            fontSize: 14,
            padding: "14px 16px",
          }}
        />

        {/* grouped, fuzzy-filtered list */}
        <div style={{ overflowY: "auto", padding: "2px 0 6px" }}>
          {groups.map(({ group, items }) => (
            <div key={group}>
              <div data-testid={`shuttle-group-${group}`} style={headerStyle}>
                {GROUP_LABELS[group]}
              </div>
              {items.map((entry) => {
                const idx = filtered.indexOf(entry);
                const selected = idx === selIdx;
                return (
                  <div
                    key={entry.id}
                    ref={selected ? selectedRowRef : undefined}
                    data-testid={`shuttle-entry-${entry.id}`}
                    data-selected={selected ? "true" : "false"}
                    className="loom-shuttle-row"
                    onClick={() => execute(entry)}
                    onMouseEnter={() => setSelIdx(idx)}
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      justifyContent: "space-between",
                      gap: 12,
                      padding: "6px 14px",
                      cursor: "pointer",
                      background: selected ? "var(--accent-soft)" : "transparent",
                      borderLeft: selected
                        ? "2px solid var(--accent)"
                        : "2px solid transparent",
                    }}
                  >
                    <span
                      style={{
                        color: selected ? "var(--t1)" : "var(--t2)",
                        fontSize: 13,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {entry.phrase}
                    </span>
                    <span
                      style={{
                        color: "var(--t3)",
                        fontFamily: "var(--f-mono)",
                        fontSize: 10,
                        letterSpacing: ".02em",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        flexShrink: 1,
                      }}
                    >
                      {entry.hint}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}

          {filtered.length === 0 && (
            <div
              data-testid="shuttle-freetext-hint"
              style={{
                padding: "14px 16px",
                color: "var(--t3)",
                fontSize: 12,
                fontFamily: "var(--f-mono)",
              }}
            >
              no command matches — Enter sends it to the companion
            </div>
          )}
        </div>

        {/* footer hint */}
        <div
          style={{
            flexShrink: 0,
            borderTop: "1px solid var(--glass-border)",
            padding: "6px 14px",
            display: "flex",
            gap: 14,
            color: "var(--t3)",
            fontFamily: "var(--f-mono)",
            fontSize: 10,
            letterSpacing: ".06em",
          }}
        >
          <span>↑↓ select</span>
          <span>↩ run</span>
          <span>esc close</span>
          <span style={{ marginLeft: "auto" }}>one grammar — say it or type it</span>
        </div>
      </div>
    </div>
  );
}
