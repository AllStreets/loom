import { useEffect, useRef, useState } from "react";
import { type OrganState, mountOrgan } from "../../lib/organs/host";
import { windowRegistry } from "../../lib/ambient/windowRegistry";
import { organDelete } from "../../lib/core";
import { addOrganTombstone, purgeOrganStorage } from "../../lib/organs/api";
import { IconTrash } from "../chrome/icons";

type WinPos = {
  x: number;
  y: number;
  w: number;
  h: number;
  collapsed: boolean;
};

type Props = {
  state: OrganState;
  focused: boolean;
  onFocus: () => void;
  onMinimize: () => void;
  onDelete: () => void;
  initial: { x: number; y: number; w: number; h: number };
};

function persistPos(id: string, pos: WinPos) {
  try {
    localStorage.setItem(`loom.win.${id}`, JSON.stringify(pos));
  } catch {
    // ignore storage errors
  }
}

/** Dock clearance reserved at the bottom of the viewport (px). */
const DOCK_CLEARANCE_PX = 72;

/** Title bar height (px) — minimum visible region. */
const TITLE_BAR_H = 28;

/**
 * Clamp x AND y against the current viewport so no window can be loaded off-screen.
 * Also clamps w/h to the viewport so oversized windows shrink to fit.
 * Falls back gracefully when viewport dimensions are unavailable (e.g. jsdom).
 */
function clampToViewport(pos: WinPos): WinPos {
  const vw = typeof window !== "undefined" ? window.innerWidth : 0;
  const vh = typeof window !== "undefined" ? window.innerHeight : 0;
  if (vw <= 0 || vh <= 0) return pos; // can't clamp without layout info

  // Clamp dimensions first so position clamping uses the effective size.
  const w = Math.min(pos.w, vw);
  const h = Math.min(pos.h, vh - DOCK_CLEARANCE_PX);

  // Clamp position: title bar must stay fully inside [0, vw-w] x [0, vh-DOCK_CLEARANCE-TITLE_BAR_H].
  const maxX = Math.max(0, vw - w);
  const maxY = Math.max(0, vh - DOCK_CLEARANCE_PX - TITLE_BAR_H);
  const x = Math.max(0, Math.min(pos.x, maxX));
  const y = Math.max(0, Math.min(pos.y, maxY));

  return { ...pos, x, y, w, h };
}

function loadPos(id: string, initial: { x: number; y: number; w: number; h: number }): WinPos {
  try {
    const raw = localStorage.getItem(`loom.win.${id}`);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<WinPos>;
      const raw_pos: WinPos = {
        x: saved.x ?? initial.x,
        y: saved.y ?? initial.y,
        w: saved.w ?? initial.w,
        h: saved.h ?? initial.h,
        collapsed: saved.collapsed ?? false,
      };
      return clampToViewport(raw_pos);
    }
  } catch {
    // ignore parse errors
  }
  return clampToViewport({ x: initial.x, y: initial.y, w: initial.w, h: initial.h, collapsed: false });
}

export default function OrganWindow({ state, focused, onFocus, onMinimize, onDelete, initial }: Props) {
  const id = state.entry.id;
  const [pos, setPos] = useState<WinPos>(() => loadPos(id, initial));
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  // Keep a ref always in sync with the latest pos so drag/resize onUp closures
  // read the live value rather than the stale capture from pointerdown.
  const posRef = useRef(pos);
  posRef.current = pos;

  const mountRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    const el = mountRef.current;
    if (!el || mountedRef.current) return;
    mountedRef.current = true;
    mountOrgan(el, state).then((err) => {
      if (err) {
        el.textContent = err;
        el.style.color = "var(--danger)";
        el.style.fontSize = "12px";
        el.style.fontFamily = "var(--f-mono)";
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Register window position in ambient registry on mount/pos change
  useEffect(() => {
    windowRegistry.set(id, { x: pos.x, y: pos.y, w: pos.w, h: pos.h });
  }, [id, pos.x, pos.y, pos.w, pos.h]);

  // Clean up registry on unmount
  useEffect(() => {
    return () => {
      windowRegistry.delete(id);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Viewport-resize re-clamp: listen for Desktop's single resize dispatcher.
  // Re-clamps this window's position and persists any corrections.
  useEffect(() => {
    function onPlaneResize(ev: Event) {
      const detail = (ev as CustomEvent<{ planeW: number; planeH: number }>).detail;
      if (!detail || detail.planeW <= 0 || detail.planeH <= 0) return;
      const { planeW, planeH } = detail;
      setPos((p) => {
        const w = Math.min(p.w, planeW);
        const h = Math.min(p.h, planeH - DOCK_CLEARANCE_PX);
        const maxX = Math.max(0, planeW - w);
        const maxY = Math.max(0, planeH - DOCK_CLEARANCE_PX - TITLE_BAR_H);
        const x = Math.max(0, Math.min(p.x, maxX));
        const y = Math.max(0, Math.min(p.y, maxY));
        const corrected: WinPos = { ...p, x, y, w, h };
        // Persist only if something actually changed.
        if (corrected.x !== p.x || corrected.y !== p.y || corrected.w !== p.w || corrected.h !== p.h) {
          windowRegistry.set(id, { x: corrected.x, y: corrected.y, w: corrected.w, h: corrected.h });
          persistPos(id, corrected);
        }
        return corrected;
      });
    }

    window.addEventListener("desktop-plane-resize", onPlaneResize);
    return () => window.removeEventListener("desktop-plane-resize", onPlaneResize);
  }, [id]);

  // Drag logic
  function handleTitlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).closest("[data-action]")) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const origX = posRef.current.x;
    const origY = posRef.current.y;
    e.currentTarget.setPointerCapture?.(e.pointerId);

    // Capture parent bounds at pointerdown for clamping.
    // offsetWidth/offsetHeight return 0 in jsdom (no layout engine) — treat 0 as "unavailable"
    // so we fall back to only >= 0 clamping, preserving full drag freedom in tests.
    const parentEl = (e.currentTarget as HTMLElement).closest("[data-desktop-plane]") as HTMLElement | null;
    const rawParentW = parentEl?.offsetWidth ?? 0;
    const rawParentH = parentEl?.offsetHeight ?? 0;
    const parentW = rawParentW > 0 ? rawParentW : null;
    const parentH = rawParentH > 0 ? rawParentH : null;

    function clampX(x: number, w: number): number {
      const lo = 0;
      if (parentW === null) return Math.max(lo, x);
      const hi = Math.max(lo, parentW - w);
      return Math.max(lo, Math.min(x, hi));
    }

    function clampY(y: number, h: number): number {
      const lo = 0;
      if (parentH === null) return Math.max(lo, y);
      const hi = Math.max(lo, parentH - h);
      return Math.max(lo, Math.min(y, hi));
    }

    function onMove(ev: PointerEvent) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      setPos((p) => {
        const next = {
          ...p,
          x: clampX(origX + dx, p.w),
          y: clampY(origY + dy, p.h),
        };
        windowRegistry.set(id, { x: next.x, y: next.y, w: next.w, h: next.h });
        return next;
      });
    }

    function onUp(ev: PointerEvent) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const live = posRef.current;
      const newPos: WinPos = {
        ...live,
        x: clampX(origX + dx, live.w),
        y: clampY(origY + dy, live.h),
      };
      setPos(newPos);
      persistPos(id, newPos);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // Resize logic
  function handleResizePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const origW = posRef.current.w;
    const origH = posRef.current.h;
    const origX = posRef.current.x;
    const origY = posRef.current.y;
    (e.currentTarget as HTMLDivElement).setPointerCapture?.(e.pointerId);

    // Capture parent bounds at pointerdown for clamping.
    // offsetWidth/offsetHeight return 0 in jsdom (no layout engine) — treat 0 as "unavailable"
    // so we fall back to only >= 0 clamping, preserving full resize freedom in tests.
    const parentEl = (e.currentTarget as HTMLElement).closest("[data-desktop-plane]") as HTMLElement | null;
    const rawParentW = parentEl?.offsetWidth ?? 0;
    const rawParentH = parentEl?.offsetHeight ?? 0;
    const parentW = rawParentW > 0 ? rawParentW : null;
    const parentH = rawParentH > 0 ? rawParentH : null;

    function clampW(w: number): number {
      const minW = 260;
      if (parentW === null) return Math.max(minW, w);
      const maxW = Math.max(minW, parentW - origX);
      return Math.max(minW, Math.min(w, maxW));
    }

    function clampH(h: number): number {
      const minH = 180;
      if (parentH === null) return Math.max(minH, h);
      const maxH = Math.max(minH, parentH - origY - TITLE_BAR_H);
      return Math.max(minH, Math.min(h, maxH));
    }

    function onMove(ev: PointerEvent) {
      const dw = ev.clientX - startX;
      const dh = ev.clientY - startY;
      setPos((p) => ({
        ...p,
        w: clampW(origW + dw),
        h: clampH(origH + dh),
      }));
    }

    function onUp(ev: PointerEvent) {
      const dw = ev.clientX - startX;
      const dh = ev.clientY - startY;
      const live = posRef.current;
      const newPos: WinPos = {
        ...live,
        w: clampW(origW + dw),
        h: clampH(origH + dh),
      };
      setPos(newPos);
      persistPos(id, newPos);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // Collapse toggle on title bar double-click
  function handleTitleDoubleClick() {
    setPos((p) => {
      const next = { ...p, collapsed: !p.collapsed };
      persistPos(id, next);
      return next;
    });
  }

  async function handleDelete() {
    addOrganTombstone(id);
    await organDelete(id);
    purgeOrganStorage(id);
    windowRegistry.delete(id);
    window.dispatchEvent(new CustomEvent("organs-changed"));
    onDelete();
  }

  const windowStyle: React.CSSProperties = {
    position: "absolute",
    left: pos.x,
    top: pos.y,
    width: Math.min(pos.w, typeof window !== "undefined" && window.innerWidth > 0 ? window.innerWidth : pos.w),
    boxShadow: focused
      ? "var(--shadow-3), var(--shadow-2)"
      : "var(--shadow-1)",
    transition: "box-shadow var(--dur-fast) var(--ease-out)",
    userSelect: "none",
    background: "var(--glass)",
    backdropFilter: "blur(var(--blur))",
    WebkitBackdropFilter: "blur(var(--blur))",
    border: "1px solid var(--glass-border)",
    borderRadius: 14,
    overflow: "hidden",
    pointerEvents: "auto",
  };

  const titleBarStyle: React.CSSProperties = {
    height: 28,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 8px 0 12px",
    cursor: "move",
    flexShrink: 0,
    borderBottom: pos.collapsed ? "none" : "1px solid var(--glass-border)",
  };

  const bodyStyle: React.CSSProperties = {
    display: pos.collapsed ? "none" : "block",
    overflow: "auto",
    height: pos.h,
  };

  const minimizeButtonStyle: React.CSSProperties = {
    background: "none",
    border: "none",
    cursor: "pointer",
    color: "var(--t3)",
    fontSize: 14,
    lineHeight: 1,
    padding: "2px 4px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 3,
    flexShrink: 0,
  };

  return (
    <div
      className="glass"
      style={windowStyle}
      onPointerDown={onFocus}
    >
      <div
        data-testid={`title-bar-${id}`}
        style={titleBarStyle}
        onPointerDown={handleTitlePointerDown}
        onDoubleClick={handleTitleDoubleClick}
      >
        {showDeleteConfirm ? (
          <div
            data-testid={`delete-confirm-${id}`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flex: 1,
              background: "var(--glass-raised, rgba(255,255,255,.06))",
              borderRadius: 6,
              padding: "0 6px",
            }}
          >
            <span style={{ fontSize: 12, color: "var(--t2)", flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              Delete {state.manifest.name}? This removes its code and data.
            </span>
            <button
              data-action="delete-confirm-yes"
              onClick={(e) => { e.stopPropagation(); void handleDelete(); }}
              style={{
                background: "var(--danger)",
                color: "#fff",
                border: "none",
                borderRadius: 4,
                padding: "2px 10px",
                fontSize: 12,
                fontWeight: 700,
                cursor: "pointer",
                flexShrink: 0,
              }}
            >
              DELETE
            </button>
            <button
              data-action="delete-confirm-no"
              onClick={(e) => { e.stopPropagation(); setShowDeleteConfirm(false); }}
              style={{
                background: "none",
                color: "var(--t2)",
                border: "1px solid var(--glass-border)",
                borderRadius: 4,
                padding: "2px 8px",
                fontSize: 12,
                cursor: "pointer",
                flexShrink: 0,
              }}
            >
              KEEP
            </button>
          </div>
        ) : (
          <>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--t1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
              {state.manifest.name}
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }} className="win-title-actions">
              <button
                data-action="win-delete"
                title="Delete organ"
                onClick={(e) => { e.stopPropagation(); setShowDeleteConfirm(true); }}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--t3)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 22,
                  height: 22,
                  borderRadius: 3,
                  padding: 0,
                  opacity: 0,
                  transition: "opacity var(--dur-fast, 150ms) ease",
                  flexShrink: 0,
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = "1"; (e.currentTarget as HTMLElement).style.color = "var(--danger)"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = "0"; (e.currentTarget as HTMLElement).style.color = "var(--t3)"; }}
              >
                <IconTrash size={12} />
              </button>
              <button
                data-action="win-min"
                style={minimizeButtonStyle}
                onClick={(e) => { e.stopPropagation(); onMinimize(); }}
                title="Minimize"
              >
                -
              </button>
            </div>
          </>
        )}
      </div>
      <div style={bodyStyle}>
        <div ref={mountRef} style={{ minHeight: "100%", padding: "8px" }} />
      </div>
      {!pos.collapsed && (
        <div
          onPointerDown={handleResizePointerDown}
          data-testid="resize-grip"
          style={{
            position: "absolute",
            right: 4,
            bottom: 4,
            width: 14,
            height: 14,
            cursor: "se-resize",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            opacity: 0.4,
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
            {[0, 1, 2].map((i) => (
              <span key={i} style={{ width: 2, height: 2, borderRadius: "50%", background: "var(--t3)", display: "block" }} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
