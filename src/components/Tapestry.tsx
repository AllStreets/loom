/**
 * Tapestry.tsx — LOOM's autobiography, woven.
 *
 * Replaces the constellation. Not decoration: the band renders LOOM's actual
 * life — its git history (warp), its organs alive and deleted, its decks, its
 * build experiences with visible knots for repaired weaves, tinted by what the
 * watch has learned. Every LOOM weaves a different cloth.
 *
 * CLOTH, NOT GRID: the render is the glyph's over-under technique
 * (public/brand/loom-glyph.svg) at band scale. Warps bow gently instead of
 * ruling the viewport; wefts undulate through every warp crossing with
 * checkerboard parity; short warp segments are overdrawn wherever the warp is
 * over; and the whole weave sits behind a two-axis gradient mask so threads
 * emerge from darkness — no hard band edges. Geometry is pure and tested in
 * lib/tapestry/geometry.ts; this component only renders its output.
 *
 * POSITIONING: fixed horizontal band, z 8 — the slot the constellation held:
 * above the deck layers (z 2) and ambient field (z 1), below chrome/orb-band
 * (z 10). Vertically centered on the orb's equator (see BAND_TOP). Lives
 * OUTSIDE the orb-band's screen blend so threads and labels render in normal
 * blend mode.
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
import {
  BAND_H,
  CROSSING_OVERDRAW,
  KNOT_R,
  warpGeometry,
  thinWarpForDensity,
  weftRows,
  overCrossings,
  knotPoint,
} from "../lib/tapestry/geometry";

// ── Band geometry ─────────────────────────────────────────────────────────────

/**
 * Vertical anchor: centered on the orb's equator. The top bar is ~62px
 * (16px padding ×2 + 30px controls); the orb hero adds 12px margin, so the
 * 180px orb's equator sits at ~62 + 12 + 90 = 164. Band center 164 − half the
 * 180px band = top 74.
 */
const BAND_TOP = 74;
/** z 8 — above decks (z 2), below chrome and the orb band (z 10). */
const BAND_Z = 8;

/** Faint placeholder warp for the empty state — a loom strung but unwoven. */
const EMPTY_WARP_COUNT = 12;

/** Warp opacity ceiling — the warp is structure, never the story. */
const WARP_MAX_OPACITY = 0.3;

/** Scar threads stay under this — a scar is remembered, not displayed. */
const SCAR_MAX_OPACITY = 0.15;

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

// ── Component ─────────────────────────────────────────────────────────────────

type HoverState = { label: string; x: number; y: number } | null;

export default function Tapestry() {
  const [visible, setVisible] = useState(() => getSetting("cockpit.tapestry") === "on");
  const [model, setModel] = useState<WeaveModel | null>(null);
  const [hover, setHover] = useState<HoverState>(null);
  const [width, setWidth] = useState(() => window.innerWidth);
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

  // Track the viewport — the cloth is laid out in real pixels, not a
  // stretched viewBox (stretching would distort the bows and crossings).
  useEffect(() => {
    function onResize() {
      setWidth(window.innerWidth);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
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

  // ---- geometry: pure functions lay the cloth; the component just renders ----
  // Density sanity: at typical widths 24 warps sit ~55px apart (fine), but on
  // narrow windows thinWarpForDensity strides the RENDERED warp down so
  // crossings never fall under ~28px. The data model caps are untouched —
  // threads thinned out of the geometry simply have no rendered curve or hit
  // target at this width.
  const warpPx = model.warp
    .map((t) => ({ ...t, px: t.x * width }))
    .sort((a, b) => a.px - b.px); // ascending for left→right weft sampling
  const warpThreads = thinWarpForDensity(warpPx.map((t) => ({ ...t, x: t.px })));
  const warpGeoms = warpGeometry(
    warpThreads.map((t) => ({ seed: t.id, x: t.x })),
    BAND_H
  );
  const warpXs = warpThreads.map((t) => t.x);

  // Rows are laid top-down with seeded 14–22px spacing; the band holds as many
  // as fit (geometry drops the lowest-priority tail — honest comment lives in
  // weftRows). Zip rendered threads against their rows.
  const rows = weftRows(model.weft.map((t) => ({ seed: t.id })), warpXs, width, BAND_H);
  const renderedWeft = model.weft.slice(0, rows.length);

  const crossings = overCrossings(warpXs, rows);

  const emptyWarpGeoms = empty
    ? warpGeometry(
        Array.from({ length: EMPTY_WARP_COUNT }, (_, i) => ({
          seed: `empty-${i}`,
          x: ((i + 1) / (EMPTY_WARP_COUNT + 1)) * width,
        })),
        BAND_H
      )
    : [];

  const warpOpacity = (o: number) => Math.min(o, WARP_MAX_OPACITY);

  return (
    <>
      <svg
        data-testid="tapestry"
        aria-hidden
        viewBox={`0 0 ${width} ${BAND_H}`}
        style={{
          position: "fixed",
          top: BAND_TOP,
          left: 0,
          width: "100%",
          height: BAND_H,
          zIndex: BAND_Z,
          pointerEvents: "none", // threads re-enable their own hit paths
          overflow: "visible",
        }}
      >
        <defs>
          {/* Soft edges: a vertical fade multiplied with a horizontal one (the
              inner rect carries the horizontal mask), so threads emerge from
              darkness on all four sides. White here is mask LUMINANCE, not a
              brand color — tokens cannot reach mask internals and no palette
              color is being displayed. */}
          <linearGradient id="loom-tap-fade-y" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset="0.2" stopColor="#fff" stopOpacity="1" />
            <stop offset="0.8" stopColor="#fff" stopOpacity="1" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="loom-tap-fade-x" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset="0.08" stopColor="#fff" stopOpacity="1" />
            <stop offset="0.92" stopColor="#fff" stopOpacity="1" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          <mask id="loom-tap-mask-x">
            <rect x={-60} y={0} width={width + 120} height={BAND_H} fill="url(#loom-tap-fade-x)" />
          </mask>
          <mask id="loom-tap-mask" data-testid="tapestry-mask">
            <rect
              x={-60}
              y={0}
              width={width + 120}
              height={BAND_H}
              fill="url(#loom-tap-fade-y)"
              mask="url(#loom-tap-mask-x)"
            />
          </mask>
        </defs>

        <g data-testid="tapestry-weave" mask="url(#loom-tap-mask)">
          {/* ── warp: commits — bowed verticals, newest brightest ── */}
          {warpGeoms.map((g, gi) => {
            const t = warpThreads[gi];
            return (
              <g key={t.id}>
                <path
                  d={g.d}
                  fill="none"
                  stroke={`var(${t.colorToken})`}
                  strokeWidth={1}
                  opacity={warpOpacity(t.opacity)}
                />
                {/* invisible hit path — wide enough to hover/click a hairline */}
                <path
                  data-testid={`tapestry-thread-${t.id}`}
                  d={g.d}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={12}
                  style={{
                    pointerEvents: "stroke",
                    cursor: t.action ? "pointer" : "default",
                  }}
                  onMouseEnter={(e) => setHover({ label: t.label, x: e.clientX, y: e.clientY })}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => runAction(t.action)}
                />
              </g>
            );
          })}

          {/* ── weft: organs, scars, decks, builds — undulating through the
              warp. The faint accent glow is token-derived (color-mix over
              var(--accent)) so mood/theme reach the cloth. ── */}
          <g
            data-testid="tapestry-weft"
            style={{
              filter: "drop-shadow(0 0 6px color-mix(in srgb, var(--accent) 35%, transparent))",
            }}
          >
            {renderedWeft.map((t, j) => {
              const row = rows[j];
              const isScar = t.kind === "scar";
              // Learned tint: what the watch has learned lifts this region's glow.
              const opacity = isScar
                ? Math.min(t.opacity, SCAR_MAX_OPACITY)
                : Math.min(1, t.opacity * (1 + 0.5 * t.intensity));
              return (
                <g key={t.id}>
                  <path
                    className={reducedMotion ? undefined : "loom-weft-shimmer"}
                    d={row.d}
                    fill="none"
                    stroke={`var(${t.colorToken})`}
                    strokeWidth={t.kind === "organ" ? 1.6 : 1.1}
                    strokeDasharray={isScar ? "3 5" : undefined}
                    strokeLinecap="round"
                    opacity={opacity}
                  />
                  {/* knots — repaired/failed builds tied at their seeded crossing */}
                  {t.knots.map((k, ki) => {
                    const p = knotPoint(k, row, warpXs, width);
                    return (
                      <circle
                        key={ki}
                        data-testid={`tapestry-knot-${t.id}-${ki}`}
                        cx={p.x}
                        cy={p.y}
                        r={KNOT_R}
                        fill="none"
                        stroke={`var(${t.colorToken})`}
                        strokeWidth={1.2}
                        opacity={opacity}
                      />
                    );
                  })}
                  {/* invisible hit path — the curved thread is the target */}
                  <path
                    data-testid={`tapestry-thread-${t.id}`}
                    d={row.d}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={12}
                    style={{
                      pointerEvents: "stroke",
                      cursor: t.action ? "pointer" : "default",
                    }}
                    onMouseEnter={(e) => setHover({ label: t.label, x: e.clientX, y: e.clientY })}
                    onMouseLeave={() => setHover(null)}
                    onClick={() => runAction(t.action)}
                  />
                </g>
              );
            })}
          </g>

          {/* ── interlacing: wherever the warp is over ((i+j)%2===1) a short
              warp segment is overdrawn on top of the weft — the checkerboard
              that makes the band read as cloth ── */}
          <g data-testid="tapestry-interlace">
            {crossings.map((c) => {
              const t = warpThreads[c.warpIndex];
              return (
                <line
                  key={`${c.warpIndex}-${c.rowIndex}`}
                  x1={c.x}
                  y1={c.y - CROSSING_OVERDRAW}
                  x2={c.x}
                  y2={c.y + CROSSING_OVERDRAW}
                  stroke={`var(${t.colorToken})`}
                  strokeWidth={1}
                  opacity={warpOpacity(t.opacity)}
                />
              );
            })}
          </g>

          {/* ── empty state: a loom strung but unwoven — same bowed warps ── */}
          {empty && (
            <g data-testid="tapestry-empty-warp">
              {emptyWarpGeoms.map((g) => (
                <path
                  key={g.seed}
                  d={g.d}
                  fill="none"
                  stroke="var(--t3)"
                  strokeWidth={1}
                  opacity={0.08}
                />
              ))}
            </g>
          )}
        </g>

        {/* empty-state copy sits outside the mask so it stays readable */}
        {empty && (
          <text
            data-testid="tapestry-empty-copy"
            x={width / 2}
            y={BAND_H - 24}
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
