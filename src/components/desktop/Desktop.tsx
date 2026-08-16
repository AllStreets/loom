import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { useOrgans, type OrganState } from "../../lib/organs/host";
import OrganWindow from "./OrganWindow";
import Dock from "./Dock";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Clearance below the desktop plane reserved for the dock (px). */
const DOCK_CLEARANCE = 72;

/** Default window size for any organ not listed in ORGAN_SIZES. */
const DEFAULT_WIN_SIZE = { w: 420, h: 360 };

/** Per-organ default sizes keyed by manifest id. */
const ORGAN_SIZES: Record<string, { w: number; h: number }> = {
  settings: { w: 640, h: 560 },
};

/** z-index for the desktop plane overlay — above orb band (10) but below Dock (1000) and modals (2000). */
const PLANE_Z = 100;

type WindowInfo = {
  minimized: boolean;
  focused: boolean;
};

export default function Desktop() {
  const rm = useReducedMotion() ?? false;
  const { organs, approve, reload } = useOrgans();
  const [windowStates, setWindowStates] = useState<Record<string, WindowInfo>>({});
  const [zOrder, setZOrder] = useState<string[]>([]);
  const [modalOrganId, setModalOrganId] = useState<string | null>(null);
  const windowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const flashTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const dismissedRef = useRef<Set<string>>(new Set());

  // Listen for organs-changed and organ-focus
  useEffect(() => {
    function onOrganChanged() {
      reload();
    }

    function onOrganFocus(ev: Event) {
      const detail = (ev as CustomEvent<{ id: string }>).detail;
      if (!detail?.id) return;
      const id = detail.id;
      setWindowStates((prev) => ({
        ...prev,
        [id]: { minimized: false, focused: true },
      }));
      setZOrder((prev) => {
        const next = prev.filter((x) => x !== id);
        next.push(id);
        return next;
      });
      // Flash outline
      const winEl = windowRefs.current[id];
      if (winEl) {
        winEl.style.outline = "2px solid var(--accent)";
        if (flashTimers.current[id]) clearTimeout(flashTimers.current[id]);
        flashTimers.current[id] = setTimeout(() => {
          if (winEl) winEl.style.outline = "";
        }, 2000);
      }
    }

    window.addEventListener("organs-changed", onOrganChanged);
    window.addEventListener("organ-focus", onOrganFocus);
    return () => {
      window.removeEventListener("organs-changed", onOrganChanged);
      window.removeEventListener("organ-focus", onOrganFocus);
      // Clear any pending flash timers on unmount
      for (const id of Object.keys(flashTimers.current)) {
        clearTimeout(flashTimers.current[id]);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-open modal for first unapproved organ (skips session-dismissed ids)
  useEffect(() => {
    if (organs.length === 0) return;
    const firstPending = organs.find(
      (o) => !o.approved && !dismissedRef.current.has(o.entry.id),
    );
    if (firstPending && modalOrganId === null) {
      setModalOrganId(firstPending.entry.id);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organs]);

  // Initialize window states for new organs
  useEffect(() => {
    setWindowStates((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const organ of organs) {
        if (!(organ.entry.id in next)) {
          next[organ.entry.id] = { minimized: false, focused: false };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    setZOrder((prev) => {
      const ids = organs.map((o) => o.entry.id);
      const added = ids.filter((id) => !prev.includes(id));
      if (added.length === 0) return prev;
      return [...prev, ...added];
    });
  }, [organs]);

  function handleFocus(id: string) {
    setWindowStates((prev) => {
      const next: Record<string, WindowInfo> = {};
      for (const [k, v] of Object.entries(prev)) {
        next[k] = { ...v, focused: k === id };
      }
      return next;
    });
    setZOrder((prev) => {
      const next = prev.filter((x) => x !== id);
      next.push(id);
      return next;
    });
  }

  function handleMinimize(id: string) {
    setWindowStates((prev) => ({
      ...prev,
      [id]: { ...prev[id], minimized: true, focused: false },
    }));
  }

  function handleDockClick(id: string) {
    const organ = organs.find((o) => o.entry.id === id);
    if (!organ) return;
    if (!organ.approved) {
      setModalOrganId(id);
      return;
    }
    // Un-minimize and focus
    setWindowStates((prev) => ({
      ...prev,
      [id]: { minimized: false, focused: true },
    }));
    setZOrder((prev) => {
      const next = prev.filter((x) => x !== id);
      next.push(id);
      return next;
    });
  }

  async function handleApprove(id: string) {
    await approve(id);
    setModalOrganId(null);
  }

  const modalOrgan: OrganState | undefined =
    modalOrganId ? organs.find((o) => o.entry.id === modalOrganId) : undefined;

  const approvedOrgans = organs.filter((o) => o.approved);

  const planeRef = useRef<HTMLDivElement | null>(null);

  // Single viewport-resize listener: re-clamp all open windows and persist corrections.
  useEffect(() => {
    function onResize() {
      const planeEl = planeRef.current;
      const planeW = planeEl?.offsetWidth ?? 0;
      const planeH = planeEl?.offsetHeight ?? 0;
      if (planeW <= 0 || planeH <= 0) return;

      // Dispatch a custom event that OrganWindow instances can listen to.
      // We carry the new plane dims so each window can self-clamp.
      window.dispatchEvent(new CustomEvent("desktop-plane-resize", {
        detail: { planeW, planeH },
      }));
    }

    window.addEventListener("resize", onResize, { passive: true });
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return (
    <div
      ref={planeRef}
      data-desktop-plane=""
      data-testid="desktop-plane"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: PLANE_Z,
        pointerEvents: "none",
      }}
    >
      {approvedOrgans.map((organ, i) => {
        const id = organ.entry.id;
        const ws = windowStates[id] ?? { minimized: false, focused: false };
        const zIndex = zOrder.indexOf(id) + 1;
        const size = ORGAN_SIZES[id] ?? DEFAULT_WIN_SIZE;
        // Clamp spawn y so title bar never starts below plane bottom minus dock clearance.
        // offsetHeight returns 0 in jsdom (no layout engine) — treat 0 as "unavailable" and skip clamping.
        const planeH = planeRef.current?.offsetHeight ?? 0;
        const rawY = 40 + i * 36;
        const maxY = planeH > 0 ? Math.max(0, planeH - DOCK_CLEARANCE - 28) : rawY;
        const clampedY = Math.min(rawY, maxY);
        const initial = { x: 40 + i * 36, y: clampedY, ...size };

        return (
          <div
            key={id}
            ref={(el) => { windowRefs.current[id] = el; }}
            style={{
              display: ws.minimized ? "none" : "block",
              position: "absolute",
              top: 0,
              left: 0,
              zIndex,
              pointerEvents: "auto",
            }}
          >
            <OrganWindow
              state={organ}
              focused={ws.focused}
              onFocus={() => handleFocus(id)}
              onMinimize={() => handleMinimize(id)}
              initial={initial}
            />
          </div>
        );
      })}

      {/* Permission modal */}
      <AnimatePresence>
      {modalOrgan && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 2000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,.55)",
            pointerEvents: "auto",
          }}
          onClick={(e) => { if (e.target === e.currentTarget) setModalOrganId(null); }}
        >
          <motion.div
            initial={rm ? false : { opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={rm ? false : { opacity: 0, scale: 0.96, y: 12 }}
            transition={rm ? {} : { type: "spring", stiffness: 400, damping: 30 }}
            style={{
              background: "var(--glass)",
              backdropFilter: "blur(var(--blur))",
              WebkitBackdropFilter: "blur(var(--blur))",
              border: "1px solid var(--glass-border)",
              borderRadius: 14,
              padding: "24px 28px",
              minWidth: 320,
              maxWidth: 440,
              position: "relative",
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 16, color: "var(--t1)", marginBottom: 6 }}>
              {modalOrgan.manifest.name}
            </div>
            <div
              style={{
                color: "var(--t2)",
                fontSize: 13,
                marginBottom: 16,
                maxHeight: 160,
                overflowY: "auto",
                overflowWrap: "break-word",
              }}
            >
              {modalOrgan.manifest.description}
            </div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ color: "var(--t3)", fontSize: 12, marginBottom: 6 }}>
                Requested permissions:
              </div>
              <div style={{ maxHeight: 140, overflowY: "auto" }}>
                {modalOrgan.manifest.permissions.map((p) => (
                  <div
                    key={p}
                    style={{
                      fontFamily: "var(--f-mono)",
                      fontSize: 12,
                      color: "var(--t2)",
                      padding: "2px 0",
                      overflowWrap: "break-word",
                    }}
                  >
                    {p}
                  </div>
                ))}
              </div>
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button
                onClick={() => handleApprove(modalOrgan.entry.id)}
                style={{
                  background: "var(--accent)",
                  color: "#000",
                  border: "none",
                  borderRadius: 4,
                  padding: "7px 18px",
                  fontWeight: 700,
                  cursor: "pointer",
                  fontSize: 13,
                }}
              >
                Approve
              </button>
              <button
                onClick={() => {
                  if (modalOrgan) dismissedRef.current.add(modalOrgan.entry.id);
                  setModalOrganId(null);
                }}
                style={{
                  background: "rgba(255,255,255,.06)",
                  color: "var(--t2)",
                  border: "1px solid var(--glass-border)",
                  borderRadius: 4,
                  padding: "7px 18px",
                  cursor: "pointer",
                  fontSize: 13,
                }}
              >
                Not now
              </button>
            </div>
          </motion.div>
        </div>
      )}
      </AnimatePresence>

      <Dock organs={organs} windowStates={windowStates} onTileClick={handleDockClick} />
    </div>
  );
}
