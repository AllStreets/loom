import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { useOrgans, type OrganState } from "../../lib/organs/host";
import { organGrant } from "../../lib/core";
import OrganWindow from "./OrganWindow";
import PermissionCard from "./PermissionCard";
import Dock from "./Dock";
import { windowRegistry } from "../../lib/ambient/windowRegistry";

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
  const [windowStates, setWindowStates] = useState<Record<string, WindowInfo>>(() => {
    try {
      const raw = localStorage.getItem("loom.minimized");
      if (raw) {
        const ids: string[] = JSON.parse(raw);
        const init: Record<string, WindowInfo> = {};
        for (const id of ids) {
          init[id] = { minimized: true, focused: false };
        }
        return init;
      }
    } catch { /* ignore */ }
    return {};
  });
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
      // Re-add to registry using persisted position
      try {
        const raw = localStorage.getItem(`loom.win.${id}`);
        if (raw) {
          const p = JSON.parse(raw);
          windowRegistry.set(id, { x: p.x ?? 0, y: p.y ?? 0, w: p.w ?? 420, h: p.h ?? 360 });
        }
      } catch { /* ignore */ }
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
    setWindowStates((prev) => {
      const next = {
        ...prev,
        [id]: { ...prev[id], minimized: true, focused: false },
      };
      // Persist minimized set
      const minimizedIds = Object.entries(next)
        .filter(([, v]) => v.minimized)
        .map(([k]) => k);
      try { localStorage.setItem("loom.minimized", JSON.stringify(minimizedIds)); } catch { /* ignore */ }
      return next;
    });
    windowRegistry.delete(id);
  }

  function handleDelete(id: string) {
    setWindowStates((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setZOrder((prev) => prev.filter((x) => x !== id));
  }

  function handleDockClick(id: string) {
    const organ = organs.find((o) => o.entry.id === id);
    if (!organ) return;
    if (!organ.approved) {
      setModalOrganId(id);
      return;
    }
    // Un-minimize and focus
    setWindowStates((prev) => {
      const next = {
        ...prev,
        [id]: { minimized: false, focused: true },
      };
      // Update persisted minimized set
      const minimizedIds = Object.entries(next)
        .filter(([, v]) => v.minimized)
        .map(([k]) => k);
      try { localStorage.setItem("loom.minimized", JSON.stringify(minimizedIds)); } catch { /* ignore */ }
      return next;
    });
    setZOrder((prev) => {
      const next = prev.filter((x) => x !== id);
      next.push(id);
      return next;
    });
    // Re-add to registry using persisted position
    try {
      const raw = localStorage.getItem(`loom.win.${id}`);
      if (raw) {
        const p = JSON.parse(raw);
        windowRegistry.set(id, { x: p.x ?? 0, y: p.y ?? 0, w: p.w ?? 420, h: p.h ?? 360 });
      }
    } catch { /* ignore */ }
  }

  // After approving, a short-lived "Undo" lets the owner take the grant back.
  const [justApproved, setJustApproved] = useState<{ id: string; name: string } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function handleApprove(id: string) {
    const name = organs.find((o) => o.entry.id === id)?.manifest.name ?? id;
    await approve(id);
    setModalOrganId(null);
    setJustApproved({ id, name });
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setJustApproved(null), 12000);
  }

  async function handleUndoApprove() {
    if (!justApproved) return;
    const { id } = justApproved;
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setJustApproved(null);
    dismissedRef.current.add(id);          // don't pop the card straight back up
    await organGrant(id, "[]");
    reload();
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
              minimized={ws.minimized}
              onFocus={() => handleFocus(id)}
              onMinimize={() => handleMinimize(id)}
              onDelete={() => handleDelete(id)}
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
          <PermissionCard
            key={modalOrgan.entry.id}
            organ={modalOrgan}
            onApprove={() => handleApprove(modalOrgan.entry.id)}
            onDismiss={() => {
              dismissedRef.current.add(modalOrgan.entry.id);
              setModalOrganId(null);
            }}
          />
        </div>
      )}
      </AnimatePresence>

      <AnimatePresence>
        {justApproved && (
          <motion.div
            role="status"
            data-testid="approve-undo"
            initial={rm ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={rm ? undefined : { opacity: 0, y: 8 }}
            style={{
              position: "fixed",
              left: "50%",
              bottom: DOCK_CLEARANCE + 16,
              transform: "translateX(-50%)",
              zIndex: 1500,
              display: "flex",
              alignItems: "center",
              gap: 14,
              padding: "10px 12px 10px 16px",
              background: "var(--glass-raised)",
              backdropFilter: "blur(var(--blur))",
              WebkitBackdropFilter: "blur(var(--blur))",
              border: "1px solid var(--glass-border)",
              borderRadius: 10,
              boxShadow: "var(--shadow-2)",
              fontSize: 13,
              color: "var(--t1)",
              pointerEvents: "auto",
            }}
          >
            <span>{justApproved.name} is approved and running.</span>
            <button
              type="button"
              onClick={handleUndoApprove}
              style={{ background: "none", border: "1px solid var(--glass-border)", borderRadius: 6, padding: "5px 10px", color: "var(--accent)", fontSize: 12.5, cursor: "pointer" }}
            >
              Undo approval
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <Dock organs={organs} windowStates={windowStates} onTileClick={handleDockClick} />
    </div>
  );
}
