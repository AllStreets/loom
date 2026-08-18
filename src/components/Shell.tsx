import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Orb } from "./orb/Orb";
import FleetHUD from "./FleetHUD";
import Companion from "./Companion";
import Desktop from "./desktop/Desktop";
import Field from "./ambient/Field";
import Threads from "./ambient/Threads";
import { fleetStatus, timelineInit, timelineLog, voiceStatus, type RoleStatus, type Commit } from "../lib/core";
import { MOOD_TARGETS, type OrbMood } from "../lib/orb/state";
import { organList, organWrite } from "../lib/core";
import { installSeeds } from "../organs/seeds/install";
import { useVoice, makeSpacePttHandlers } from "../lib/voice/useVoice";
import { audioLevel } from "../lib/orb/audioLevel";
import { getSetting, setSetting } from '../lib/voice/settings';
import DeckLayer from './decks/DeckLayer';
import type { DeckId } from './decks/DeckLayer';
import { startWatch, stopWatch } from '../lib/watch/runtime';
import Constellation from './Constellation';
import WatchPanel from './WatchPanel';

// Active turn moods — fleet-offline cannot override these
const ACTIVE_MOODS: ReadonlySet<OrbMood> = new Set([
  "listening",
  "thinking",
  "building",
  "speaking",
]);

const SPRING = { type: "spring" as const, stiffness: 260, damping: 24 };

const IGNITION_KEY = "loom.ignited";

type IgnitionPhase = "igniting" | "done";

export default function Shell() {
  const [mood, setMood] = useState<OrbMood>("idle");
  const [roles, setRoles] = useState<RoleStatus[]>([]);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [voiceReady, setVoiceReady] = useState(false);
  const reducedMotion = useReducedMotion() ?? false;

  const [deck, setDeck] = useState<DeckId>(() => getSetting('cockpit.deck') as DeckId);
  const [interactMode, setInteractMode] = useState(false);
  const [watchOpen, setWatchOpen] = useState(false);
  const [watchUnseen, setWatchUnseen] = useState(0);

  // ----- Ignition sequence state -----
  const alreadyIgnited = typeof localStorage !== "undefined"
    ? !!localStorage.getItem(IGNITION_KEY)
    : true;
  const [ignitionPhase, setIgnitionPhase] = useState<IgnitionPhase>(
    alreadyIgnited ? "done" : "igniting"
  );
  const [ignitionOpacity, setIgnitionOpacity] = useState(0);
  const [orbScale, setOrbScale] = useState(alreadyIgnited ? 1 : 0.6);
  // First-boot stagger: top bar + content spring in after orb bloom starts (~0.3s delay)
  const [staggerVisible, setStaggerVisible] = useState(alreadyIgnited);
  // First-boot glow surge: orb hero gets a transient glow peak as scale reaches 1
  const [glowSurge, setGlowSurge] = useState(false);
  const ignitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Voice state machine
  const voice = useVoice();

  // Track mood from loom-mood events so fleet offline doesn't override active turns
  const lastEventMoodRef = useRef<OrbMood | null>(null);

  // Refs for the listening ring animation
  const ringRef = useRef<HTMLDivElement | null>(null);
  const ringRafRef = useRef<number | null>(null);

  // ----- Watch runtime — start with shell, stop on unmount -----
  useEffect(() => {
    startWatch();
    return () => stopWatch();
  }, []);

  // ----- loom-salience — increment unseen badge when panel is closed -----
  useEffect(() => {
    function onSalience() {
      if (!watchOpen) {
        setWatchUnseen((n) => n + 1);
      }
    }
    window.addEventListener("loom-salience", onSalience);
    return () => window.removeEventListener("loom-salience", onSalience);
  }, [watchOpen]);

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

  // ----- loom-deck event listener -----
  useEffect(() => {
    function onDeck(ev: Event) {
      const detail = (ev as CustomEvent<{ deck: DeckId }>).detail;
      if (!detail?.deck) return;
      setDeck(detail.deck);
      setSetting('cockpit.deck', detail.deck);
    }
    window.addEventListener('loom-deck', onDeck);
    return () => window.removeEventListener('loom-deck', onDeck);
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

  // ----- voiceReady poll (once on mount, then every 60s) -----
  useEffect(() => {
    async function checkVoice() {
      try {
        const s = await voiceStatus();
        setVoiceReady(s.ready);
      } catch {
        // leave voiceReady false on error
      }
    }
    checkVoice();
    const id = setInterval(checkVoice, 60_000);
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

  // ----- Listening ring rAF loop -----
  useEffect(() => {
    if (voice.state !== "listening") {
      if (ringRafRef.current !== null) {
        cancelAnimationFrame(ringRafRef.current);
        ringRafRef.current = null;
      }
      return;
    }
    function tick() {
      if (ringRef.current) {
        const scale = 1 + audioLevel.current * 0.3;
        ringRef.current.style.transform = `scale(${scale})`;
      }
      ringRafRef.current = requestAnimationFrame(tick);
    }
    ringRafRef.current = requestAnimationFrame(tick);
    return () => {
      if (ringRafRef.current !== null) {
        cancelAnimationFrame(ringRafRef.current);
        ringRafRef.current = null;
      }
    };
  }, [voice.state]);

  // ----- Window blur — cancel voice -----
  useEffect(() => {
    function onBlur() { voice.cancel(); }
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [voice]);

  // ----- Space PTT keyboard handler -----
  useEffect(() => {
    const { onKeyDown, onKeyUp } = makeSpacePttHandlers(voice);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [voice]);

  // ----- Ignition sequence -----
  useEffect(() => {
    if (ignitionPhase === "done") {
      setIgnitionOpacity(1);
      return;
    }

    // First boot: 1.8s bloom sequence
    // Phase 1 (50ms): Fade in shell + orb begins blooming (scale 0.6→1)
    const t1 = setTimeout(() => {
      setIgnitionOpacity(1);
      setOrbScale(1);
      // Trigger glow surge as orb starts blooming
      if (!reducedMotion) setGlowSurge(true);
    }, 50);

    // Phase 1b (350ms): Stagger — top bar + content spring in with ~0.3s delay after orb bloom starts
    const t1b = setTimeout(() => {
      setStaggerVisible(true);
    }, 350);

    // Phase 1c (900ms): Glow surge decays — remove the peak filter
    const t1c = setTimeout(() => {
      setGlowSurge(false);
    }, 900);

    // Phase 2: After 1.8s, mark ignition done
    const t2 = setTimeout(() => {
      setIgnitionPhase("done");
      try { localStorage.setItem(IGNITION_KEY, "1"); } catch { /* ignore */ }
    }, 1800);

    ignitionTimerRef.current = t2;

    return () => {
      clearTimeout(t1);
      clearTimeout(t1b);
      clearTimeout(t1c);
      clearTimeout(t2);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function skipIgnition() {
    if (ignitionPhase === "done") return;
    if (ignitionTimerRef.current) clearTimeout(ignitionTimerRef.current);
    setIgnitionOpacity(1);
    setOrbScale(1);
    setStaggerVisible(true);
    setGlowSurge(false);
    setIgnitionPhase("done");
    try { localStorage.setItem(IGNITION_KEY, "1"); } catch { /* ignore */ }
  }

  // ----- ambient glow color -----
  const moodColor = MOOD_TARGETS[mood].color;
  // 0x1e ≈ 12% alpha (idle), 0x2a ≈ 16% alpha (active) — the room shifts with the orb's mood
  const isActiveMood = ACTIVE_MOODS.has(mood);
  const glowAlpha = isActiveMood ? "2a" : "1e";
  const ambientBg = `radial-gradient(900px at 50% 220px, ${moodColor}${glowAlpha}, transparent 70%)`;

  // ----- panel animation props -----
  const motionProps = reducedMotion
    ? {}
    : {
        initial: { y: 14, opacity: 0 },
        animate: { y: 0, opacity: 1 },
        transition: SPRING,
      };

  const PanelTag = reducedMotion ? "div" : motion.div;

  // Ignition animation timing
  const ignitionDuration = reducedMotion ? "0.3s" : alreadyIgnited ? "0.9s" : "1.8s";
  // First-boot stagger entrance: top bar and content region spring in after orb bloom
  const staggerStyle = (!reducedMotion && !alreadyIgnited)
    ? {
        opacity: staggerVisible ? 1 : 0,
        transform: staggerVisible ? "translateY(0)" : "translateY(10px)",
        transition: "opacity 0.5s ease, transform 0.5s cubic-bezier(0.34,1.56,0.64,1)",
      }
    : {};

  return (
    <div
      ref={shellRef}
      data-testid="loom-shell"
      onClick={ignitionPhase === "igniting" ? skipIgnition : undefined}
      style={{
        height: "100vh",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        position: "relative",
        "--mx": "50%",
        "--my": "30%",
        opacity: ignitionOpacity,
        transition: `opacity ${ignitionDuration} ease`,
      } as React.CSSProperties}
    >
      {/* Shell micro-interaction styles */}
      <style>{`
        details[open] .loom-timeline-chevron { transform: rotate(90deg); }
        @keyframes loom-row-fade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
        @media (prefers-reduced-motion: reduce) {
          .loom-timeline-chevron { transition: none !important; }
        }
      `}</style>

      {/* Ambient particle field — behind everything, zIndex:1 */}
      <Field dim={deck === 'globe'} />

      {/* Deck layer — between ambient Field (z1) and orb-band (z10) */}
      <DeckLayer deck={deck} interactMode={interactMode} />

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
              "radial-gradient(600px at var(--mx, 50%) var(--my, 30%), rgba(34,211,238,.08), transparent)",
            pointerEvents: "none",
            zIndex: 1,
          }}
        />
      )}

      {/* Grain overlay */}
      <div aria-hidden className="shell-grain" />

      {/* ── Zone A: Top bar (fixed height, never scrolls) ── */}
      <header
        data-testid="shell-top-bar"
        style={{
          flexShrink: 0,
          width: "100%",
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          padding: "20px 24px 16px",
          position: "relative",
          zIndex: 10,
          borderBottom: reducedMotion ? undefined : `1px solid ${moodColor}20`,
          transition: reducedMotion ? undefined : "border-color 1.2s ease",
          ...staggerStyle,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 10,
            ...(deck === 'globe' ? {
              background: 'var(--glass)',
              border: '1px solid var(--glass-border)',
              borderRadius: 999,
              padding: '2px 12px',
              backdropFilter: 'blur(var(--blur))',
              WebkitBackdropFilter: 'blur(var(--blur))',
            } : {}),
          }}
        >
          <b style={{ letterSpacing: ".4em", fontSize: 20, color: "var(--t1)", textShadow: reducedMotion ? undefined : `0 0 12px ${moodColor}80`, transition: reducedMotion ? undefined : "text-shadow 1.2s ease" }}>LOOM</b>
          <small style={{ color: "var(--t3)", fontFamily: "var(--f-mono)" }}>sovereign console</small>
        </div>

        {/* Fleet HUD — persistent role strip (uses Shell's already-polled roles) */}
        <div
          style={{
            ...(deck === 'globe' ? {
              background: 'var(--glass)',
              border: '1px solid var(--glass-border)',
              borderRadius: 999,
              padding: '2px 8px',
              backdropFilter: 'blur(var(--blur))',
              WebkitBackdropFilter: 'blur(var(--blur))',
            } : {}),
          }}
        >
          <FleetHUD roles={roles} />
        </div>

        {/* Deck controls */}
        {/* Glass pill keeps the controls legible over bright deck content */}
        <div
          data-testid="deck-controls"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            background: 'var(--glass)',
            border: '1px solid var(--glass-border)',
            borderRadius: 999,
            padding: '2px 8px',
            backdropFilter: 'blur(var(--blur))',
            WebkitBackdropFilter: 'blur(var(--blur))',
          }}
        >
          <button
            data-testid="deck-void-btn"
            onClick={() => window.dispatchEvent(new CustomEvent('loom-deck', { detail: { deck: 'void' } }))}
            style={{
              fontFamily: 'var(--f-mono)',
              fontSize: 10,
              letterSpacing: '.08em',
              color: deck === 'void' ? 'var(--accent)' : 'var(--t3)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '2px 6px',
            }}
          >
            VOID
          </button>
          <button
            data-testid="deck-globe-btn"
            onClick={() => window.dispatchEvent(new CustomEvent('loom-deck', { detail: { deck: 'globe' } }))}
            style={{
              fontFamily: 'var(--f-mono)',
              fontSize: 10,
              letterSpacing: '.08em',
              color: deck === 'globe' ? 'var(--accent)' : 'var(--t3)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '2px 6px',
            }}
          >
            GLOBE
          </button>
          {deck === 'globe' && (
            <button
              data-testid="deck-interact-btn"
              onClick={() => setInteractMode(p => !p)}
              style={{
                fontFamily: 'var(--f-mono)',
                fontSize: 10,
                letterSpacing: '.08em',
                color: interactMode ? 'var(--accent)' : 'var(--t3)',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '2px 6px',
              }}
            >
              {interactMode ? 'INTERACTING' : 'INTERACT'}
            </button>
          )}
          {/* WATCH toggle */}
          <button
            data-testid="watch-toggle-btn"
            onClick={() => {
              setWatchOpen((p) => !p);
              setWatchUnseen(0);
            }}
            style={{
              position: 'relative',
              fontFamily: 'var(--f-mono)',
              fontSize: 10,
              letterSpacing: '.08em',
              color: watchOpen ? 'var(--accent)' : 'var(--t3)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '2px 6px',
            }}
          >
            WATCH
            {watchUnseen > 0 && !watchOpen && (
              <span
                data-testid="watch-badge"
                style={{
                  position: 'absolute',
                  top: -2,
                  right: -2,
                  minWidth: 14,
                  height: 14,
                  borderRadius: 999,
                  background: 'var(--accent, #22d3ee)',
                  color: '#060b18',
                  fontFamily: 'var(--f-mono)',
                  fontSize: 8,
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '0 2px',
                  pointerEvents: 'none',
                }}
              >
                {watchUnseen > 9 ? '9+' : watchUnseen}
              </span>
            )}
          </button>
        </div>
      </header>

      {/* ── Zone B: Orb band (fixed height, always visible, never scrolls) ── */}
      <div
        data-testid="orb-band"
        style={{
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          padding: "0 24px 8px",
          position: "relative",
          zIndex: 10,
          // Composites the orb canvas's black clear as pure light over the page
          // backdrop (see OrbGL.tsx) — must live at band level: orb-hero's transform
          // and this band's z-index isolate any deeper blend from the backdrop.
          mixBlendMode: "screen",
        }}
      >
        {/* Orb hero */}
        <div
          data-testid="orb-hero"
          onPointerDown={(e) => { (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId); void voice.start(); }}
          onPointerUp={() => { void voice.stop(); }}
          onPointerCancel={() => { void voice.stop(); }}
          style={{
            display: "flex",
            justifyContent: "center",
            margin: "12px 0 24px",
            position: "relative",
            cursor: "pointer",
            transform: `scale(${orbScale})`,
            transition: reducedMotion
              ? "opacity 0.3s ease"
              : `opacity ${ignitionDuration} ease, transform 1.8s cubic-bezier(0.34,1.56,0.64,1), filter 0.85s ease`,
            filter: (!reducedMotion && glowSurge)
              ? "drop-shadow(0 0 32px #22d3ee) drop-shadow(0 0 64px rgba(34,211,238,0.4))"
              : "drop-shadow(0 0 0px transparent)",
          }}
        >
          <Orb mood={mood} size={180} />
          {voice.state === "listening" && (
            <div
              data-testid="listening-ring"
              ref={ringRef}
              aria-hidden
              style={{
                position: "absolute",
                inset: -6,
                borderRadius: "50%",
                border: "2px solid var(--accent)",
                pointerEvents: "none",
                transform: "scale(1)",
              }}
            />
          )}
        </div>

        {/* Voice status line */}
        <div
          data-testid="voice-status-line"
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 11,
            color: "var(--t3)",
            textAlign: "center",
            minHeight: 16,
            marginBottom: 4,
          }}
        >
          {voice.state === "listening" && "listening..."}
          {voice.state === "transcribing" && "transcribing..."}
          {voice.state === "speaking" && "speaking..."}
          {voice.state === "unavailable" && `${voice.error ?? "Voice unavailable"} — open Settings`}
          {voice.state === "idle" && voice.error && voice.error}
          {voice.state === "idle" && !voice.error && voiceReady && "hold the orb or Space to talk"}
        </div>
      </div>

      {/* ── Zone C: Content region (scrolls internally) ── */}
      <div
        data-testid="shell-content-region"
        style={{
          flex: 1,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          padding: "0 24px 40px",
          position: "relative",
          zIndex: 10,
          ...(!reducedMotion && !alreadyIgnited
            ? {
                opacity: staggerVisible ? 1 : 0,
                transform: staggerVisible ? "translateY(0)" : "translateY(10px)",
                transition: "opacity 0.5s ease 0.15s, transform 0.5s cubic-bezier(0.34,1.56,0.64,1) 0.15s",
              }
            : {}),
        }}
      >
        {/* Main column */}
        <div
          style={{
            width: "100%",
            maxWidth: 720,
            display: "flex",
            flexDirection: "column",
            gap: 16,
          }}
        >
          {/* Companion panel */}
          <PanelTag
            {...(motionProps as object)}
            data-deck-active={deck === 'globe' ? 'true' : undefined}
            style={{
              background: "var(--glass)",
              backdropFilter: "blur(var(--blur))",
              WebkitBackdropFilter: "blur(var(--blur))",
              border: "1px solid var(--glass-border)",
              borderRadius: 14,
              ...(deck === 'globe' ? {
                maxHeight: '33vh',
                overflowY: 'auto' as const,
                background: 'rgba(6,11,24,0.7)',
              } : {}),
            }}
          >
            <Companion />
          </PanelTag>

          {/* Organs region marker — Desktop plane is now a shell-level overlay */}
          <div
            data-testid="organs-region"
            style={{ width: "100%", maxWidth: 1100, position: "relative", zIndex: 10 }}
          />

          {/* Timeline collapsible footer — hidden when AUSPEX globe is active (it has its own timeline bar) */}
          <details
            data-testid="timeline-details"
            className="glass"
            style={{ padding: "12px 16px", cursor: "pointer", display: deck === 'globe' ? 'none' : undefined }}
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
              <span className="loom-timeline-chevron" aria-hidden style={{ fontSize: 10, opacity: 0.6, display: "inline-block", transition: "transform 0.2s ease" }}>›</span>
              Timeline
            </summary>
            <div style={{ marginTop: 10 }}>
              {commits.length === 0 && (
                <div style={{ color: "var(--t3)", fontSize: 13 }}>No commits yet.</div>
              )}
              {commits.map((c) => (
                <div
                  key={c.sha}
                  style={{
                    fontSize: 13,
                    padding: "3px 0",
                    display: "flex",
                    gap: 6,
                    minWidth: 0,
                    animation: reducedMotion ? undefined : "loom-row-fade 0.25s ease both",
                  }}
                >
                  <span
                    style={{ fontFamily: "var(--f-mono)", color: "var(--t3)", flexShrink: 0 }}
                  >
                    {c.sha.slice(0, 7)}
                  </span>
                  <span
                    title={c.message}
                    style={{
                      color: "var(--t1)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      minWidth: 0,
                    }}
                  >
                    {c.message}
                  </span>
                </div>
              ))}
            </div>
          </details>
        </div>
      </div>

      {/* ── Shell-level overlay: Threads bezier canvas (same coordinate space as Desktop plane) ── */}
      <Threads />

      {/* ── Shell-level overlay: Desktop plane — absolute inset 0, windows float above orb band ── */}
      <Desktop />

      {/* ── Constellation: living agent ring around the orb (z 8, OUTSIDE orb-band screen-blend) ── */}
      <Constellation />

      {/* ── Watch panel: collapsible salience feed (z 900, right side) ── */}
      <WatchPanel open={watchOpen} onClose={() => { setWatchOpen(false); setWatchUnseen(0); }} />
    </div>
  );
}
