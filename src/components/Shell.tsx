import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Orb } from "./orb/Orb";
import Companion from "./Companion";
import Desktop from "./desktop/Desktop";
import { fleetStatus, timelineInit, timelineLog, type RoleStatus, type Commit } from "../lib/core";
import { MOOD_TARGETS, type OrbMood } from "../lib/orb/state";
import { organList, organWrite } from "../lib/core";
import { installSeeds } from "../organs/seeds/install";

// Active turn moods — fleet-offline cannot override these
const ACTIVE_MOODS: ReadonlySet<OrbMood> = new Set([
  "listening",
  "thinking",
  "building",
  "speaking",
]);

const SPRING = { type: "spring" as const, stiffness: 260, damping: 24 };

export default function Shell() {
  const [mood, setMood] = useState<OrbMood>("idle");
  const [roles, setRoles] = useState<RoleStatus[]>([]);
  const [commits, setCommits] = useState<Commit[]>([]);
  const reducedMotion = useReducedMotion() ?? false;

  // Track mood from loom-mood events so fleet offline doesn't override active turns
  const lastEventMoodRef = useRef<OrbMood | null>(null);

  // ----- seed install (originally in App) -----
  useEffect(() => {
    installSeeds({ list: organList, write: organWrite })
      .then((ids) => {
        if (ids.length) window.dispatchEvent(new CustomEvent("organs-changed"));
      })
      .catch((err) => {
        console.warn("[Shell] installSeeds failed:", err);
      });
  }, []);

  // ----- loom-mood event listener -----
  useEffect(() => {
    function onMood(ev: Event) {
      const detail = (ev as CustomEvent<{ mood: OrbMood }>).detail;
      if (!detail?.mood) return;
      lastEventMoodRef.current = detail.mood;
      setMood(detail.mood);
    }
    window.addEventListener("loom-mood", onMood);
    return () => window.removeEventListener("loom-mood", onMood);
  }, []);

  // ----- fleet poll -----
  useEffect(() => {
    async function poll() {
      try {
        const r = await fleetStatus();
        setRoles(r);

        const allAbsent = r.length > 0 && r.every((role) => !role.present);
        const activeMood = lastEventMoodRef.current;
        const hasActiveTurn = activeMood !== null && ACTIVE_MOODS.has(activeMood);

        if (allAbsent && !hasActiveTurn) {
          setMood("offline");
        } else if (!allAbsent && !hasActiveTurn) {
          setMood((prev) => (prev === "offline" ? "idle" : prev));
        }

        try {
          const c = await timelineLog(5);
          setCommits(c);
        } catch {
          // timeline may not be ready; ignore
        }
      } catch {
        // fleet not available; stay on current mood
      }
    }

    timelineInit().catch(() => {
      // error tolerance as-is
    });
    poll();
    const id = setInterval(poll, 30_000);
    return () => clearInterval(id);
  }, []);

  // ----- cursor spotlight (rAF throttled, passive, disabled on reducedMotion) -----
  const shellRef = useRef<HTMLDivElement | null>(null);
  const spotlightRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (reducedMotion) return;

    const shell = shellRef.current;
    if (!shell) return;

    function onPointerMove(e: PointerEvent) {
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        shell!.style.setProperty("--mx", `${e.clientX}px`);
        shell!.style.setProperty("--my", `${e.clientY}px`);
      });
    }

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [reducedMotion]);

  // ----- ambient glow color -----
  const moodColor = MOOD_TARGETS[mood].color;
  // 0x12 ≈ 7% alpha — the room shifts with the orb's mood, subtly
  const ambientBg = `radial-gradient(900px at 50% 220px, ${moodColor}12, transparent 70%)`;

  // ----- panel animation props -----
  const motionProps = reducedMotion
    ? {}
    : {
        initial: { y: 14, opacity: 0 },
        animate: { y: 0, opacity: 1 },
        transition: SPRING,
      };

  const PanelTag = reducedMotion ? "div" : motion.div;

  return (
    <div
      ref={shellRef}
      data-testid="loom-shell"
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        position: "relative",
        overflow: "hidden",
        padding: "0 24px 40px",
        "--mx": "50%",
        "--my": "30%",
      } as React.CSSProperties}
    >
      {/* Ambient mood glow — behind everything */}
      <div
        aria-hidden
        style={{
          position: "fixed",
          inset: 0,
          background: ambientBg,
          transition: "background 1.2s ease",
          pointerEvents: "none",
          zIndex: 0,
        }}
      />

      {/* Cursor spotlight */}
      {!reducedMotion && (
        <div
          ref={spotlightRef}
          data-testid="spotlight"
          aria-hidden
          style={{
            position: "fixed",
            inset: 0,
            background:
              "radial-gradient(600px at var(--mx, 50%) var(--my, 30%), rgba(34,211,238,.05), transparent)",
            pointerEvents: "none",
            zIndex: 1,
          }}
        />
      )}

      {/* Grain overlay */}
      <div aria-hidden className="shell-grain" />

      {/* Top bar */}
      <header
        style={{
          width: "100%",
          maxWidth: 720,
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          padding: "20px 0 16px",
          position: "relative",
          zIndex: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <b style={{ letterSpacing: ".4em", fontSize: 20, color: "var(--t1)" }}>LOOM</b>
          <small style={{ color: "var(--t3)", fontFamily: "var(--f-mono)" }}>sovereign console</small>
        </div>

        {/* Fleet role dots */}
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {roles.map((r) => (
            <div key={r.role} style={{ display: "flex", gap: 5, alignItems: "center" }}>
              <span
                title={`${r.role}: ${r.model || "absent"}`}
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: r.present ? "var(--go)" : "var(--danger)",
                  flexShrink: 0,
                }}
              />
              <span style={{ fontFamily: "var(--f-mono)", fontSize: 11, color: "var(--t3)" }}>
                {r.role}
              </span>
            </div>
          ))}
        </div>
      </header>

      {/* Orb hero */}
      <div
        data-testid="orb-hero"
        style={{
          display: "flex",
          justifyContent: "center",
          margin: "12px 0 24px",
          position: "relative",
          zIndex: 10,
        }}
      >
        <Orb mood={mood} size={180} />
      </div>

      {/* Main column */}
      <div
        style={{
          width: "100%",
          maxWidth: 720,
          display: "flex",
          flexDirection: "column",
          gap: 16,
          position: "relative",
          zIndex: 10,
        }}
      >
        {/* Companion panel */}
        <PanelTag
          {...(motionProps as object)}
          style={{
            background: "var(--glass)",
            backdropFilter: "blur(var(--blur))",
            WebkitBackdropFilter: "blur(var(--blur))",
            border: "1px solid var(--glass-border)",
            borderRadius: 14,
          }}
        >
          <Companion />
        </PanelTag>

        {/* Organs panel */}
        <div
          data-testid="organs-region"
          style={{ width: "100%", maxWidth: 1100, position: "relative", zIndex: 10 }}
        >
          <Desktop />
        </div>

        {/* Timeline collapsible footer */}
        <details
          className="glass"
          style={{ padding: "12px 16px", cursor: "pointer" }}
        >
          <summary
            style={{
              fontFamily: "var(--f-mono)",
              color: "var(--t3)",
              fontSize: 12,
              textTransform: "uppercase",
              letterSpacing: ".08em",
              userSelect: "none",
              listStyle: "none",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span style={{ fontSize: 10, opacity: 0.6 }}>+</span>
            Timeline
          </summary>
          <div style={{ marginTop: 10 }}>
            {commits.length === 0 && (
              <div style={{ color: "var(--t3)", fontSize: 13 }}>No commits yet.</div>
            )}
            {commits.map((c) => (
              <div key={c.sha} style={{ fontSize: 13, padding: "3px 0" }}>
                <span style={{ fontFamily: "var(--f-mono)", color: "var(--t3)" }}>
                  {c.sha.slice(0, 7)}
                </span>{" "}
                <span style={{ color: "var(--t1)" }}>{c.message}</span>
              </div>
            ))}
          </div>
        </details>
      </div>
    </div>
  );
}
