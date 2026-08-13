import { useEffect, useRef, useState } from "react";
import { type OrganState, mountOrgan } from "../../lib/organs/host";

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
  initial: { x: number; y: number; w: number; h: number };
};

function persistPos(id: string, pos: WinPos) {
  try {
    localStorage.setItem(`loom.win.${id}`, JSON.stringify(pos));
  } catch {
    // ignore storage errors
  }
}

function loadPos(id: string, initial: { x: number; y: number; w: number; h: number }): WinPos {
  try {
    const raw = localStorage.getItem(`loom.win.${id}`);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<WinPos>;
      return {
        x: saved.x ?? initial.x,
        y: saved.y ?? initial.y,
        w: saved.w ?? initial.w,
        h: saved.h ?? initial.h,
        collapsed: saved.collapsed ?? false,
      };
    }
  } catch {
    // ignore parse errors
  }
  return { x: initial.x, y: initial.y, w: initial.w, h: initial.h, collapsed: false };
}

export default function OrganWindow({ state, focused, onFocus, onMinimize, initial }: Props) {
  const id = state.entry.id;
  const [pos, setPos] = useState<WinPos>(() => loadPos(id, initial));
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

  // Drag logic
  function handleTitlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).closest("[data-action]")) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const origX = pos.x;
    const origY = pos.y;
    e.currentTarget.setPointerCapture?.(e.pointerId);

    function onMove(ev: PointerEvent) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      setPos((p) => ({
        ...p,
        x: Math.max(0, origX + dx),
        y: Math.max(0, origY + dy),
      }));
    }

    function onUp(ev: PointerEvent) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const newPos = {
        ...pos,
        x: Math.max(0, origX + dx),
        y: Math.max(0, origY + dy),
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
    const origW = pos.w;
    const origH = pos.h;
    (e.currentTarget as HTMLDivElement).setPointerCapture?.(e.pointerId);

    function onMove(ev: PointerEvent) {
      const dw = ev.clientX - startX;
      const dh = ev.clientY - startY;
      setPos((p) => ({
        ...p,
        w: Math.max(260, origW + dw),
        h: Math.max(180, origH + dh),
      }));
    }

    function onUp(ev: PointerEvent) {
      const dw = ev.clientX - startX;
      const dh = ev.clientY - startY;
      const newPos = {
        ...pos,
        w: Math.max(260, origW + dw),
        h: Math.max(180, origH + dh),
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

  const windowStyle: React.CSSProperties = {
    position: "absolute",
    left: pos.x,
    top: pos.y,
    width: pos.w,
    boxShadow: focused
      ? "0 0 0 1px rgba(34,211,238,.35), 0 8px 32px rgba(0,0,0,.4)"
      : "0 4px 16px rgba(0,0,0,.3)",
    userSelect: "none",
    background: "var(--glass)",
    backdropFilter: "blur(var(--blur))",
    WebkitBackdropFilter: "blur(var(--blur))",
    border: "1px solid var(--glass-border)",
    borderRadius: 14,
    overflow: "hidden",
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
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--t1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {state.manifest.name}
        </span>
        <button
          data-action="win-min"
          style={minimizeButtonStyle}
          onClick={(e) => { e.stopPropagation(); onMinimize(); }}
          title="Minimize"
        >
          -
        </button>
      </div>
      <div style={bodyStyle}>
        <div ref={mountRef} style={{ minHeight: "100%", padding: "8px" }} />
      </div>
      {!pos.collapsed && (
        <div
          onPointerDown={handleResizePointerDown}
          style={{
            position: "absolute",
            right: 0,
            bottom: 0,
            width: 14,
            height: 14,
            cursor: "se-resize",
            background: "transparent",
          }}
        />
      )}
    </div>
  );
}
