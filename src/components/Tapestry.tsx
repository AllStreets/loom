/**
 * Tapestry.tsx — LOOM's autobiography, woven.
 *
 * Replaces the constellation. Not decoration: the band renders LOOM's actual
 * life — its git history (warp), its organs alive and deleted, its decks, its
 * build experiences with visible knots for repaired weaves, tinted by what the
 * watch has learned. Every LOOM weaves a different cloth.
 *
 * POSITIONING: fixed horizontal band behind the orb band, z 8 — the slot the
 * constellation held: above the deck layers (z 2) and ambient field (z 1),
 * below chrome/orb-band (z 10). Lives OUTSIDE the orb-band's screen blend so
 * threads and labels render in normal blend mode.
 *
 * DATA: gathered once at mount, re-gathered on `loom-fleet-activity`,
 * `organs-changed` and `loom-deck` events. NO polling interval.
 *
 * MOTION: slow shimmer only — a CSS opacity breathing over several seconds on
 * weft threads. prefers-reduced-motion: fully static (class never applied, and
 * the media query kills it as defense-in-depth).
 */

import { useCallback, useEffect, useState } from "react";
import { timelineLog, organList } from "../lib/core";
import { listExperience } from "../lib/loom/experience";
import { computeWeights, topWeights } from "../lib/watch/learned";
import { getSignals } from "../lib/watch/store";
import { getSetting } from "../lib/voice/settings";
import {
  weaveModel,
  WARP_CAP,
  type WeaveInputs,
  type WeaveModel,
  type ThreadAction,
} from "../lib/tapestry/weave";

// ── Band geometry ─────────────────────────────────────────────────────────────

/** Fixed viewBox — x is stretched to the viewport (preserveAspectRatio none). */
const VB_W = 1000;
const VB_H = 210;
/** Vertical inset so threads never kiss the band edges. */
const PAD_Y = 10;
/** z 8 — above decks (z 2), below chrome and the orb band (z 10). */
const BAND_Z = 8;

/** Faint placeholder warp for the empty state — a loom strung but unwoven. */
const EMPTY_WARP_COUNT = 12;

const KEYFRAMES_ID = "loom-tapestry-kf";

function ensureKeyframes() {
  if (document.getElementById(KEYFRAMES_ID)) return;
  const style = document.createElement("style");
  style.id = KEYFRAMES_ID;
  style.textContent = `
    @keyframes loom-tapestry-shimmer {
      0%, 100% { opacity: 1; }
      50%      { opacity: 0.55; }
    }
    .loom-weft-shimmer {
      animation: loom-tapestry-shimmer 7s ease-in-out infinite;
    }
    @media (prefers-reduced-motion: reduce) {
      .loom-weft-shimmer { animation: none !important; }
    }
  `;
  document.head.appendChild(style);
}

// ── Data gathering — callers adapt rich records to weave's narrow inputs ──────

async function gatherInputs(): Promise<WeaveInputs> {
  // Timeline + organ list need the desktop shell; in the browser they reject
  // (ShellUnavailableError) and the tapestry honestly weaves without them.
  let commits: WeaveInputs["commits"] = [];
  try {
    commits = (await timelineLog(WARP_CAP)).map((c) => ({ sha: c.sha, message: c.message }));
  } catch {
    // no shell — no history visible
  }

  let organs: WeaveInputs["organs"] = [];
  try {
    organs = (await organList()).map((e) => ({ id: e.id }));
  } catch {
    // no shell — no organ registry
  }

  let deletedOrganIds: string[] = [];
  try {
    const raw = localStorage.getItem("loom.organs.deleted");
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) deletedOrganIds = parsed.filter((x) => typeof x === "string");
  } catch {
    // corrupt tombstones read as none
  }

  const experiences = listExperience().map((r) => ({
    ts: r.ts,
    organId: r.organId,
    ok: r.ok,
    repairRounds: r.repairRounds,
  }));

  let learnedTop: WeaveInputs["learnedTop"] = [];
  try {
    const tw = topWeights(computeWeights(getSignals()), 6);
    learnedTop = [...tw.positive, ...tw.negative].map((e) => ({ key: e.key, weight: e.weight }));
  } catch {
    // learning store unreadable — weave untinted
  }

  // Decks used = the deck currently docked (honest: LOOM has no deck-usage
  // history store; the current berth is what we truthfully know).
  const deck = getSetting("cockpit.deck");
  const decksUsed = deck !== "void" ? [deck] : [];

  return { commits, organs, deletedOrganIds, experiences, learnedTop, decksUsed, now: Date.now() };
}

// ── Thread click routing ──────────────────────────────────────────────────────

function runAction(action: ThreadAction) {
  if (!action) return;
  if (action.kind === "organ") {
    // Same path the dock and voice use — Desktop listens for organ-focus.
    window.dispatchEvent(new CustomEvent("organ-focus", { detail: { id: action.id } }));
    return;
  }
  // Commit thread → open the timeline details panel in the shell content region.
  const details = document.querySelector('[data-testid="timeline-details"]');
  if (details instanceof HTMLDetailsElement) {
    details.open = true;
    if (typeof details.scrollIntoView === "function") {
      details.scrollIntoView({ block: "nearest" });
    }
  }
}

// ── Weft path builder — smooth line with zigzag knots for repaired builds ─────

function weftPathD(y: number, knots: number[]): string {
  const ordered = [...knots].sort((a, b) => a - b);
  let d = `M 0 ${y.toFixed(1)}`;
  for (const kx of ordered) {
    const x = kx * VB_W;
    // A small zigzag — the knot where the weave was repaired.
    d += ` L ${(x - 8).toFixed(1)} ${y.toFixed(1)}`
      + ` L ${(x - 4).toFixed(1)} ${(y - 5).toFixed(1)}`
      + ` L ${x.toFixed(1)} ${(y + 5).toFixed(1)}`
      + ` L ${(x + 4).toFixed(1)} ${(y - 5).toFixed(1)}`
      + ` L ${(x + 8).toFixed(1)} ${y.toFixed(1)}`;
  }
  d += ` L ${VB_W} ${y.toFixed(1)}`;
  return d;
}

// ── Component ─────────────────────────────────────────────────────────────────

type HoverState = { label: string; x: number; y: number } | null;

export default function Tapestry() {
  const [visible, setVisible] = useState(() => getSetting("cockpit.tapestry") === "on");
  const [model, setModel] = useState<WeaveModel | null>(null);
  const [hover, setHover] = useState<HoverState>(null);
  const [reducedMotion] = useState(
    () => typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );

  const refresh = useCallback(() => {
    let cancelled = false;
    gatherInputs().then((inputs) => {
      if (!cancelled) setModel(weaveModel(inputs));
    });
    return () => { cancelled = true; };
  }, []);

  // Live setting toggle — same loom-settings-changed pattern the shell uses.
  useEffect(() => {
    function onSettingsChanged(ev: Event) {
      const detail = (ev as CustomEvent<{ key: string; value: string }>).detail;
      if (detail?.key === "cockpit.tapestry") {
        setVisible(detail.value === "on");
      }
    }
    window.addEventListener("loom-settings-changed", onSettingsChanged);
    return () => window.removeEventListener("loom-settings-changed", onSettingsChanged);
  }, []);

  // Gather at mount; re-gather on life events. No polling interval.
  useEffect(() => {
    if (!visible) return;
    ensureKeyframes();
    let cancelGather = refresh();

    function onLifeEvent() {
      cancelGather();
      cancelGather = refresh();
    }
    window.addEventListener("loom-fleet-activity", onLifeEvent);
    window.addEventListener("organs-changed", onLifeEvent);
    window.addEventListener("loom-deck", onLifeEvent);
    return () => {
      cancelGather();
      window.removeEventListener("loom-fleet-activity", onLifeEvent);
      window.removeEventListener("organs-changed", onLifeEvent);
      window.removeEventListener("loom-deck", onLifeEvent);
    };
  }, [visible, refresh]);

  if (!visible || model === null) return null;

  const empty = model.warp.length === 0 && model.weft.length === 0;
  const yPx = (y: number) => PAD_Y + y * (VB_H - 2 * PAD_Y);

  return (
    <>
      <svg
        data-testid="tapestry"
        aria-hidden
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        preserveAspectRatio="none"
        style={{
          position: "fixed",
          top: 62, // just under the top bar — the band runs behind the orb
          left: 0,
          width: "100%",
          height: VB_H,
          zIndex: BAND_Z,
          pointerEvents: "none", // threads re-enable their own hit paths
          overflow: "visible",
        }}
      >
        {/* ── warp: commits — vertical, structural, newest brightest ── */}
        {model.warp.map((t) => {
          const x = (t.x * VB_W).toFixed(1);
          return (
            <g key={t.id}>
              <line
                x1={x}
                y1={PAD_Y}
                x2={x}
                y2={VB_H - PAD_Y}
                stroke={`var(${t.colorToken})`}
                strokeWidth={1}
                opacity={t.opacity}
              />
              {/* invisible hit path — wide enough to hover/click a hairline */}
              <line
                data-testid={`tapestry-thread-${t.id}`}
                x1={x}
                y1={PAD_Y}
                x2={x}
                y2={VB_H - PAD_Y}
                stroke="transparent"
                strokeWidth={10}
                style={{ pointerEvents: "auto", cursor: t.action ? "pointer" : "default" }}
                onMouseEnter={(e) => setHover({ label: t.label, x: e.clientX, y: e.clientY })}
                onMouseLeave={() => setHover(null)}
                onClick={() => runAction(t.action)}
              />
            </g>
          );
        })}

        {/* ── weft: organs, scars, decks, builds — horizontal, colored ── */}
        {model.weft.map((t) => {
          const y = yPx(t.y);
          const d = weftPathD(y, t.knots);
          // Learned tint: what the watch has learned lifts this region's glow.
          const opacity = Math.min(1, t.opacity * (1 + 0.5 * t.intensity));
          return (
            <g key={t.id}>
              <path
                className={reducedMotion ? undefined : "loom-weft-shimmer"}
                d={d}
                fill="none"
                stroke={`var(${t.colorToken})`}
                strokeWidth={t.kind === "organ" ? 1.6 : 1.1}
                strokeLinejoin="round"
                opacity={opacity}
              />
              <path
                data-testid={`tapestry-thread-${t.id}`}
                d={d}
                fill="none"
                stroke="transparent"
                strokeWidth={10}
                style={{ pointerEvents: "auto", cursor: t.action ? "pointer" : "default" }}
                onMouseEnter={(e) => setHover({ label: t.label, x: e.clientX, y: e.clientY })}
                onMouseLeave={() => setHover(null)}
                onClick={() => runAction(t.action)}
              />
            </g>
          );
        })}

        {/* ── empty state: a loom strung but unwoven ── */}
        {empty && (
          <g data-testid="tapestry-empty-warp">
            {Array.from({ length: EMPTY_WARP_COUNT }, (_, i) => {
              const x = (((i + 1) / (EMPTY_WARP_COUNT + 1)) * VB_W).toFixed(1);
              return (
                <line
                  key={i}
                  x1={x}
                  y1={PAD_Y}
                  x2={x}
                  y2={VB_H - PAD_Y}
                  stroke="var(--t3)"
                  strokeWidth={1}
                  opacity={0.08}
                />
              );
            })}
            <text
              data-testid="tapestry-empty-copy"
              x={VB_W / 2}
              y={VB_H - 24}
              textAnchor="middle"
              style={{
                fontFamily: "var(--f-mono)",
                fontSize: 11,
                fill: "var(--t3)",
                letterSpacing: ".04em",
                userSelect: "none",
              }}
            >
              your tapestry begins when LOOM weaves its first organ.
            </text>
          </g>
        )}
      </svg>

      {/* ── hover chip: glass label naming the thread ── */}
      {hover && (
        <div
          data-testid="tapestry-hover-label"
          style={{
            position: "fixed",
            // clamp so labels on the rightmost (newest) threads stay readable
            left: Math.min(hover.x + 12, Math.max(0, window.innerWidth - 240)),
            top: Math.min(hover.y + 12, Math.max(0, window.innerHeight - 36)),
            zIndex: BAND_Z + 1, // above the band, still below chrome (z 10)
            background: "var(--glass-raised)",
            border: "1px solid var(--glass-border)",
            borderRadius: 6,
            padding: "4px 8px",
            fontFamily: "var(--f-mono)",
            fontSize: 10,
            letterSpacing: ".04em",
            color: "var(--t2)",
            pointerEvents: "none",
            whiteSpace: "nowrap",
          }}
        >
          {hover.label}
        </div>
      )}
    </>
  );
}
