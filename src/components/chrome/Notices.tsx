/**
 * Notices.tsx — the notify power's surface.
 *
 * A calm glass toast stack, top-right under the top bar, listening on the
 * `loom-notify` CustomEvent (detail: { id?, title, body? }). Each notice shows
 * its title + body with a ✕ to dismiss, and dims on its own after 12s —
 * present, not insistent. Reduced motion: static, no auto-dim animation.
 * At most 3 notices are visible; the rest wait behind a "+N more" chip.
 */

import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";
import { IconX } from "./icons";

type Notice = {
  key: number;
  organId?: string;
  title: string;
  body?: string;
  dimmed: boolean;
};

/** How long a notice stays bright before dimming (ms). */
const DIM_AFTER_MS = 12_000;

/** How many notices render at once — the rest are counted, not shown. */
const MAX_VISIBLE = 3;

/** Hard cap on kept notices — the stack is a surface, not a log. */
const MAX_KEPT = 12;

export default function Notices() {
  const rm = useReducedMotion() ?? false;
  const [notices, setNotices] = useState<Notice[]>([]);
  const nextKey = useRef(0);
  const dimTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  // The dim timer callback must see the CURRENT reduced-motion value, not the
  // one captured when the listener mounted.
  const rmRef = useRef(rm);
  rmRef.current = rm;

  useEffect(() => {
    function onNotify(ev: Event) {
      const detail = (ev as CustomEvent<{ id?: string; title?: string; body?: string }>).detail;
      if (!detail || !detail.title) return;
      const key = nextKey.current++;
      setNotices((prev) => {
        const next = [...prev, { key, organId: detail.id, title: String(detail.title), body: detail.body === undefined ? undefined : String(detail.body), dimmed: false }];
        // Drop the oldest beyond the cap — and cancel their dim timers.
        while (next.length > MAX_KEPT) {
          const dropped = next.shift()!;
          const t = dimTimers.current.get(dropped.key);
          if (t) { clearTimeout(t); dimTimers.current.delete(dropped.key); }
        }
        return next;
      });
      // Auto-dim — skipped entirely under reduced motion (static, no animation).
      if (!rmRef.current) {
        dimTimers.current.set(key, setTimeout(() => {
          dimTimers.current.delete(key);
          setNotices((prev) => prev.map((n) => (n.key === key ? { ...n, dimmed: true } : n)));
        }, DIM_AFTER_MS));
      }
    }
    window.addEventListener("loom-notify", onNotify);
    const timers = dimTimers.current;
    return () => {
      window.removeEventListener("loom-notify", onNotify);
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  function dismiss(key: number) {
    const t = dimTimers.current.get(key);
    if (t) { clearTimeout(t); dimTimers.current.delete(key); }
    setNotices((prev) => prev.filter((n) => n.key !== key));
  }

  if (notices.length === 0) return null;

  // Newest first; only the latest MAX_VISIBLE render.
  const visible = notices.slice(-MAX_VISIBLE).reverse();
  const hidden = notices.length - visible.length;

  return (
    <div
      data-testid="notices-stack"
      style={{
        position: "fixed",
        // Under the top bar (its height ≈ 62px), clear of the deck controls.
        top: 68,
        right: 24,
        zIndex: 1500, // above windows/dock (≤1000), below modals (2000)
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        gap: 8,
        width: 300,
        pointerEvents: "none",
      }}
    >
      {!rm && (
        <style>{`
          @keyframes loom-notice-in { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }
        `}</style>
      )}
      {visible.map((n) => (
        <div
          key={n.key}
          data-testid="notice"
          data-dimmed={n.dimmed ? "true" : undefined}
          style={{
            width: "100%",
            background: "var(--glass)",
            backdropFilter: "blur(var(--blur))",
            WebkitBackdropFilter: "blur(var(--blur))",
            border: "1px solid var(--glass-border)",
            borderRadius: 12,
            padding: "10px 12px",
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            pointerEvents: "auto",
            opacity: n.dimmed ? 0.45 : 1,
            transition: rm ? undefined : "opacity 0.8s ease",
            animation: rm ? undefined : "loom-notice-in 0.25s ease both",
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: "var(--t1)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {n.title}
            </div>
            {n.body !== undefined && (
              <div style={{ fontSize: 12, color: "var(--t2)", marginTop: 2, overflowWrap: "break-word" }}>
                {n.body}
              </div>
            )}
          </div>
          <button
            data-testid="notice-dismiss"
            title="dismiss"
            onClick={() => dismiss(n.key)}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "var(--t3)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 18,
              height: 18,
              borderRadius: 3,
              padding: 0,
              flexShrink: 0,
            }}
          >
            <IconX size={11} />
          </button>
        </div>
      ))}
      {hidden > 0 && (
        <div
          data-testid="notices-overflow-chip"
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 10,
            letterSpacing: ".08em",
            color: "var(--t3)",
            background: "var(--glass)",
            border: "1px solid var(--glass-border)",
            borderRadius: 999,
            padding: "2px 10px",
            pointerEvents: "none",
          }}
        >
          +{hidden} more
        </div>
      )}
    </div>
  );
}
