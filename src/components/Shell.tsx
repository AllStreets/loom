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
import { getSetting, setSetting, migrateSettings } from '../lib/voice/settings';
import Tapestry from './Tapestry';
import LoomGlyph from './chrome/LoomGlyph';
import Notices from './chrome/Notices';
import Proposal from './chrome/Proposal';
import KernelDiff from './chrome/KernelDiff';
import RecoveryNotice from './chrome/recoveryNotice';
import { runBootCheck, markBootOk } from '../lib/loom/recovery';
import { mountInitiative } from '../lib/initiative/runtime';
import Shuttle from './Shuttle';
import ErrorBoundary from './ErrorBoundary';

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

  // Boot migration MUST precede the useState initializers below — they read
  // settings synchronously on first render, before any effect fires, and the
  // retired keys must already be gone.
  // Idempotent: only localStorage.removeItem calls, safe on every render.
  migrateSettings();

  const [chatMin, setChatMin] = useState(() => getSetting('cockpit.chatMin') === 'on');

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

  // ----- Recovery boot (fifth wall) — check early, confirm once settled -----
  // On boot: runBootCheck asks Rust whether a prior self-edit failed to confirm
  // a good boot; if so Rust already rolled the source tree back and this reports
  // the sha (recovery.ts dispatches the notice event). Then, once this shell has
  // mounted and first paint settled, markBootOk clears the pending sentinel —
  // THIS boot held, so the last applied edit is confirmed good. Fires once.
  const bootBeaconFired = useRef(false);
  useEffect(() => {
    if (bootBeaconFired.current) return;
    bootBeaconFired.current = true;
    // Early check — the RecoveryNotice card renders whatever it reports.
    void runBootCheck();
    // Confirm after first paint settles (two rAFs → after layout+paint).
    let t: ReturnType<typeof setTimeout> | null = null;
    const raf1 = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        t = setTimeout(() => { void markBootOk(); }, 400);
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (t) clearTimeout(t);
    };
  }, []);

  // ----- Boot migration — idempotent: deletes stored values for retired
  // settings keys (e.g. cockpit.constellation, the Cockpit's deck keys). -----
  useEffect(() => {
    migrateSettings();
  }, []);

  // ----- Initiative runtime — the passive observer + the rules engine.
  // Mounts the usage observer and evaluates (debounced, event-driven) whether
  // LOOM has earned an idea; emits loom-proposal for the Proposal card. Unmounts
  // every listener/timer on Shell unmount. -----
  useEffect(() => {
    const unmount = mountInitiative();
    return unmount;
  }, []);

  // ----- seed install (originally in App) -----
  useEffect(() => {
    installSeeds({ list: organList, write: organWrite })
      .then((ids) => {
        if (ids.length) window.dispatchEvent(new CustomEvent("organs-changed"));
      })
      .catch((err) => {
        console.debug("[Shell] installSeeds failed:", err);
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

  // ----- loom-settings-changed: live-update the chat fold -----
  useEffect(() => {
    function onSettingsChanged(ev: Event) {
      const detail = (ev as CustomEvent<{ key: string; value: string }>).detail;
      if (!detail) return;
      if (detail.key === 'cockpit.chatMin') {
        setChatMin(detail.value === 'on');
      }
    }
    window.addEventListener('loom-settings-changed', onSettingsChanged);
    return () => window.removeEventListener('loom-settings-changed', onSettingsChanged);
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
    // Spotlight repaints on every mouse move.
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

  // ----- Minimized typing box: auto-restore when an utterance arrives -----
  // Voice PTT and Shuttle free-text both send through `loom-utterance`, and
  // every utterance runs a Companion turn whose reply renders inside the
  // (hidden, still-mounted) companion panel — replies render nowhere else, so
  // the surface must return to show them. Typed sends can't happen while
  // minimized (the textarea is folded away), so this is exactly "the user sent
  // via Shuttle free-text or voice and a reply bubble needs the surface".
  useEffect(() => {
    if (!chatMin) return;
    function onUtterance(ev: Event) {
      // An initiative "weave it" dispatches loom-utterance too, but the user
      // didn't type it — respect their minimize and don't reveal a synthetic
      // bubble. The proposal card + permission modal carry that flow.
      if ((ev as CustomEvent).detail?.initiative === true) return;
      setChatMin(false);
      setSetting('cockpit.chatMin', 'off');
    }
    window.addEventListener('loom-utterance', onUtterance);
    return () => window.removeEventListener('loom-utterance', onUtterance);
  }, [chatMin]);

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
        // Once visible, the transform must be REMOVED (undefined), not left as
        // translateY(0): any transform on these containers turns them into the
        // containing block for position:fixed descendants (the dock),
        // silently re-anchoring viewport chrome.
        transform: staggerVisible ? undefined : "translateY(10px)",
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
        .loom-seg-btn { transition: color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out); }
        .loom-seg-btn:hover:not(.is-selected) { color: var(--t2); background: rgba(255,255,255,.05); }
        .loom-seg-btn:active { transform: translateY(.5px); }
        /* Chat minimize — hover-reveal, same language as organ window controls */
        .loom-chat-min-btn { opacity: 0; transition: opacity var(--dur-fast, 150ms) ease; }
        .loom-chat-panel:hover .loom-chat-min-btn,
        .loom-chat-min-btn:focus-visible { opacity: 1; }
        @media (prefers-reduced-motion: reduce) {
          .loom-timeline-chevron { transition: none !important; }
          .loom-seg-btn { transition: none !important; }
          .loom-seg-btn:active { transform: none !important; }
          .loom-chat-min-btn { transition: none !important; }
        }
      `}</style>

      {/* Ambient particle field — behind everything, zIndex:1 */}
      <Field />

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
      <ErrorBoundary zone="top-bar">
        <header
          data-testid="shell-top-bar"
          style={{
            flexShrink: 0,
            // No explicit width: as a flex-column child the header stretches to the
            // container; width:100% + padding overflows (no global border-box) and
            // clips the right-edge controls.
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
            padding: "16px 24px",
            position: "relative",
            zIndex: 10,
            borderBottom: reducedMotion ? undefined : `1px solid ${moodColor}20`,
            transition: reducedMotion ? undefined : "border-color 1.2s ease",
            ...staggerStyle,
          }}
        >
          {/* Brand — glyph + baseline-aligned wordmark + subtitle */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexShrink: 0,
            }}
          >
            {/* The mark shares the wordmark's mood glow (drop-shadow ≈ text-shadow)
                and draws its weft once at boot — ignition made visible. */}
            <LoomGlyph
              size={18}
              draw={!reducedMotion}
              style={{
                filter: reducedMotion ? undefined : `drop-shadow(0 0 6px ${moodColor}80)`,
                transition: reducedMotion ? undefined : "filter 1.2s ease",
              }}
            />
            <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
              <b style={{ letterSpacing: ".4em", fontSize: 19, lineHeight: 1, color: "var(--t1)", textShadow: reducedMotion ? undefined : `0 0 12px ${moodColor}80`, transition: reducedMotion ? undefined : "text-shadow 1.2s ease" }}>LOOM</b>
              <small style={{ color: "var(--t3)", fontFamily: "var(--f-mono)", fontSize: 11, letterSpacing: ".04em" }}>sovereign console</small>
            </div>
          </div>

          {/* Right cluster — shuttle chip + fleet HUD, same height, baseline row */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0, flexShrink: 1 }}>
            {/* Shuttle affordance — the ⌘K hint chip (same glass language as its neighbors) */}
            <button
              data-testid="shuttle-hint-chip"
              title="the shuttle — command palette"
              onClick={() => window.dispatchEvent(new CustomEvent("loom-shuttle-open"))}
              style={{
                display: "inline-flex",
                alignItems: "center",
                height: 30,
                padding: "0 11px",
                flexShrink: 0,
                background: "var(--glass)",
                border: "1px solid var(--glass-border)",
                borderRadius: 999,
                backdropFilter: "blur(var(--blur))",
                WebkitBackdropFilter: "blur(var(--blur))",
                fontFamily: "var(--f-mono)",
                fontSize: 10,
                letterSpacing: ".1em",
                color: "var(--t3)",
                cursor: "pointer",
              }}
            >
              ⌘K
            </button>

            {/* Fleet HUD — persistent role strip (uses Shell's already-polled roles) */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                height: 30,
                padding: "0 12px",
                minWidth: 0,
                background: "var(--glass)",
                border: "1px solid var(--glass-border)",
                borderRadius: 999,
                backdropFilter: "blur(var(--blur))",
                WebkitBackdropFilter: "blur(var(--blur))",
              }}
            >
              <FleetHUD roles={roles} />
            </div>

          </div>
        </header>
      </ErrorBoundary>

      {/* ── Zone B: Orb band (fixed height, always visible, never scrolls) ── */}
      <ErrorBoundary zone="orb-band">
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
          // Empty flanks pass clicks through; the orb hero re-enables its own.
          pointerEvents: "none",
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
            pointerEvents: "auto",
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
      </ErrorBoundary>

      {/* ── Zone C: Content region (scrolls internally) ── */}
      <ErrorBoundary zone="content">
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
          // The zone shell spans the full width but must NOT swallow clicks in its
          // empty flanks. Real content re-enables pointer events on the column below.
          pointerEvents: "none",
          ...(!reducedMotion && !alreadyIgnited
            ? {
                opacity: staggerVisible ? 1 : 0,
                // undefined once visible — a lingering transform would re-anchor
                // fixed descendants (same hazard fixed in the header staggerStyle)
                transform: staggerVisible ? undefined : "translateY(10px)",
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
            pointerEvents: "auto",
          }}
        >
          {/* Companion panel — while minimized it is HIDDEN, never unmounted:
              Companion owns the conversation state and the loom-utterance
              listener, so voice/Shuttle turns keep running behind the fold. */}
          <PanelTag
            {...(motionProps as object)}
            data-testid="companion-panel"
            className="loom-chat-panel"
            style={{
              position: "relative",
              display: chatMin ? "none" : undefined,
              background: "var(--glass)",
              backdropFilter: "blur(var(--blur))",
              WebkitBackdropFilter: "blur(var(--blur))",
              border: "1px solid var(--glass-border)",
              borderRadius: 14,
            }}
          >
            <Companion />
          </PanelTag>

          {/* Organs region marker — Desktop plane is now a shell-level overlay */}
          <div
            data-testid="organs-region"
            style={{ width: "100%", maxWidth: 1100, position: "relative", zIndex: 10 }}
          />

          {/* Timeline collapsible footer */}
          <details
            data-testid="timeline-details"
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
      </ErrorBoundary>

      {/* ── Shell-level overlay: Threads bezier canvas (same coordinate space as Desktop plane) ── */}
      {/* Fallback renders inline (not absolute inset-0) — correct: better than a crash */}
      <ErrorBoundary zone="threads">
        <Threads />
      </ErrorBoundary>

      {/* ── Shell-level overlay: Desktop plane — absolute inset 0, windows float above orb band ── */}
      {/* Fallback renders inline (not absolute inset-0) — correct: better than a crash */}
      <ErrorBoundary zone="desktop">
        <Desktop />
      </ErrorBoundary>

      {/* ── Tapestry: LOOM's history woven — horizontal band behind the orb
          (z 8: above the ambient field z 1, below chrome/orb-band z 10; OUTSIDE
          the orb-band screen-blend so threads stay legible) ── */}
      <ErrorBoundary zone="tapestry">
        <Tapestry />
      </ErrorBoundary>

      {/* ── Notices: the notify power's glass toast stack (z 1500, top-right
          under the top bar — above windows/dock, below modals) ── */}
      <ErrorBoundary zone="notices">
        <Notices />
      </ErrorBoundary>

      {/* ── Proposal: the initiative surface (z 1600 — above notices, below the
          permission modal; lower-center, non-blocking). LOOM floats one earned
          idea; weave it flows through the normal loom-utterance build seam. ── */}
      <ErrorBoundary zone="proposal">
        <Proposal />
      </ErrorBoundary>

      {/* ── The Shuttle: Cmd+K palette (z 3000 — above every panel; executes
          through the same loom-utterance seam voice transcripts take) ── */}
      <ErrorBoundary zone="shuttle">
        <Shuttle />
      </ErrorBoundary>

      {/* ── Recovery notice: "an edit didn't hold — LOOM came home to <sha>"
          (z 1550 — above notices, below the permission modal). One-shot,
          listens on the recovery event runBootCheck dispatched. ── */}
      <ErrorBoundary zone="recovery-notice">
        <RecoveryNotice />
      </ErrorBoundary>

      {/* ── KernelDiff: the self-edit review card — the third wall made visible
          (z 2000 — the permission-modal tier; the only surface that may block).
          Appears ONLY on a validated loom-kernel-review event; Approve is the
          ONLY live-tree write in the whole self-edit surface. ── */}
      <ErrorBoundary zone="kernel-diff">
        <KernelDiff />
      </ErrorBoundary>

      {/* ── Minimized typing box: bottom-center glass pill — the mark and the
          Shuttle hint. Click restores; PTT (orb/Space) and ⌘K keep working
          while the box is folded. ── */}
      {chatMin && (
        <button
          data-testid="chat-min-pill"
          title="restore the typing box"
          onClick={() => {
            setChatMin(false);
            setSetting('cockpit.chatMin', 'off');
          }}
          style={{
            position: "fixed",
            // The organ dock owns bottom 16 center (z 1000, renders even when
            // empty) — the pill stacks directly above it, below modals (2000)
            // and the Shuttle (3000).
            bottom: 60,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 1100,
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            height: 30,
            padding: "0 12px",
            background: "var(--glass)",
            border: "1px solid var(--glass-border)",
            borderRadius: 999,
            backdropFilter: "blur(var(--blur))",
            WebkitBackdropFilter: "blur(var(--blur))",
            fontFamily: "var(--f-mono)",
            fontSize: 10,
            letterSpacing: ".1em",
            color: "var(--t3)",
            cursor: "pointer",
          }}
        >
          <LoomGlyph size={14} />
          <span>⌘K</span>
        </button>
      )}
    </div>
  );
}
