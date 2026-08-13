import { useEffect, useRef, useState } from "react";
import { useOrgans, type OrganState } from "../../lib/organs/host";
import OrganWindow from "./OrganWindow";
import Dock from "./Dock";

type WindowInfo = {
  minimized: boolean;
  focused: boolean;
};

export default function Desktop() {
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

  return (
    <div data-desktop-plane="" style={{ position: "relative", minHeight: "60vh", width: "100%" }}>
      {approvedOrgans.map((organ, i) => {
        const id = organ.entry.id;
        const ws = windowStates[id] ?? { minimized: false, focused: false };
        const zIndex = zOrder.indexOf(id) + 1;
        const initial = { x: 40 + i * 36, y: 40 + i * 36, w: 420, h: 320 };

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
          }}
          onClick={(e) => { if (e.target === e.currentTarget) setModalOrganId(null); }}
        >
          <div
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
            <div style={{ color: "var(--t2)", fontSize: 13, marginBottom: 16 }}>
              {modalOrgan.manifest.description}
            </div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ color: "var(--t3)", fontSize: 12, marginBottom: 6 }}>
                Requested permissions:
              </div>
              {modalOrgan.manifest.permissions.map((p) => (
                <div
                  key={p}
                  style={{
                    fontFamily: "var(--f-mono)",
                    fontSize: 12,
                    color: "var(--t2)",
                    padding: "2px 0",
                  }}
                >
                  {p}
                </div>
              ))}
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
          </div>
        </div>
      )}

      <Dock organs={organs} windowStates={windowStates} onTileClick={handleDockClick} />
    </div>
  );
}
