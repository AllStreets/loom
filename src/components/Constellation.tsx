/**
 * Constellation.tsx
 *
 * SVG ring of LOOM's live agents (builder/companion/rewriter) and watch sensors
 * (auspex/quakes) around the orb center, with synaptic cubic-bezier wires and
 * one-shot CSS animated data-packet circles during activity.
 *
 * POSITIONING: This layer is a sibling OUTSIDE the orb-band (which carries
 * mixBlendMode:screen). We position it as a fixed overlay at z 8 (between the
 * deck at z 2-5 and the orb-band at z 10). Living outside the blend group keeps
 * labels and wires in normal blend mode, so they stay legible over the globe deck.
 *
 * ORB CENTER: Computed from [data-testid="orb-hero"] getBoundingClientRect()
 * (same pattern as Threads.tsx getOrbAnchor), re-measured on resize via
 * ResizeObserver. SVG viewBox maps to the full viewport.
 *
 * ACTIVITY: loom-fleet-activity sets data-active attr on the role node group
 * (no React state — FleetHUD's ref/attr pattern). A packet SVG circle is
 * injected with a SMIL <animateMotion> along the wire path, then removed after
 * the animation (one-shot, no rAF loop). Reduced-motion: packets suppressed,
 * activity = brightness class only.
 *
 * SALIENCE: loom-salience pulses auspex + quakes sensor nodes via a CSS
 * @keyframes class toggle (attribute flip, no state).
 */

import { useEffect, useRef } from "react";

// ── Node definitions ──────────────────────────────────────────────────────────

type NodeRole = "builder" | "companion" | "rewriter";
type SensorId = "auspex" | "quakes";
type NodeId = NodeRole | SensorId;

interface NodeDef {
  id: NodeId;
  label: string;
  color: string;
  kind: "role" | "sensor";
}

const NODES: NodeDef[] = [
  { id: "builder",   label: "BUILDER",   color: "#7dd3fc", kind: "role" },
  { id: "companion", label: "COMPANION", color: "#22d3ee", kind: "role" },
  { id: "rewriter",  label: "REWRITER",  color: "#a78bfa", kind: "role" },
  { id: "auspex",    label: "AUSPEX",    color: "#4ade80", kind: "sensor" },
  { id: "quakes",    label: "QUAKES",    color: "#86efac", kind: "sensor" },
];

// Angles in degrees (0=top, clockwise). Distribute 5 nodes.
// builder: upper-left, companion: lower-left, rewriter: upper-right,
// auspex: lower-right, quakes: bottom. A vertically-spread ellipse keeps the
// nodes clear of the orb glow at default size and off the screen corners.
// px = cx + rx·sin θ ; py = cy − ry·cos θ (θ=0 top, clockwise).
// The orb sits HIGH on screen, so the constellation fans across the lower
// hemisphere and sides — never above the orb band. builder/rewriter flank the
// orb at mid-height, companion/auspex sit lower on each side, quakes anchors
// the bottom. Symmetric, vertically generous, clear of the orb glow.
const ANGLES_DEG = [-88, -134, 88, 134, 180];

function degToRad(d: number): number {
  return (d * Math.PI) / 180;
}

// Ellipse radii relative to orb size (baseR ≈ orb width). Wide horizontal reach
// keeps the flanking nodes off the orb halo; vertical reach is generous but
// bounded so the bottom node clears the companion panel / screen edge.
const RX_FRAC = 1.75; // horizontal reach — flanks the orb, stays on-screen
const RY_FRAC = 1.35; // vertical reach — spreads down, clears the orb glow

// ── Event types ───────────────────────────────────────────────────────────────

type FleetActivity = { role: string | null; phase?: string };

// ── Animation keyframes injected once ────────────────────────────────────────

const KEYFRAMES_ID = "loom-constellation-kf";

function ensureKeyframes() {
  if (document.getElementById(KEYFRAMES_ID)) return;
  const style = document.createElement("style");
  style.id = KEYFRAMES_ID;
  style.textContent = `
    @keyframes loom-node-pulse {
      0%   { opacity: 1; }
      40%  { opacity: 0.35; }
      80%  { opacity: 0.9; }
      100% { opacity: 1; }
    }
    @keyframes loom-sensor-pulse {
      0%   { r: 5; stroke-opacity: 0.75; }
      100% { r: 18; stroke-opacity: 0; }
    }
    .loom-node-active circle.node-glow {
      animation: loom-node-pulse 0.8s ease-out;
    }
    .loom-sensor-pulsing circle.sensor-ring {
      animation: loom-sensor-pulse 1s ease-out forwards;
    }
  `;
  document.head.appendChild(style);
}

// ── Packet injection ──────────────────────────────────────────────────────────

let _packetId = 0;

function launchPacket(
  svgEl: SVGSVGElement,
  pathD: string,
  color: string,
  durationMs: number
) {
  const ns = "http://www.w3.org/2000/svg";
  const g = document.createElementNS(ns, "g");
  g.setAttribute("aria-hidden", "true");
  g.setAttribute("pointer-events", "none");

  const pathId = `loom-pkt-path-${++_packetId}`;

  // Create a temporary path element for the mpath href
  const tmpPath = document.createElementNS(ns, "path");
  tmpPath.setAttribute("id", pathId);
  tmpPath.setAttribute("d", pathD);
  tmpPath.setAttribute("fill", "none");
  tmpPath.setAttribute("stroke", "none");
  svgEl.appendChild(tmpPath);

  // A packet is a bright head plus two fading trail dots, each offset in time
  // along the same motion path — a comet whose tail dissolves. Pure SMIL, no rAF.
  const trailSpec = [
    { r: 4.2, opacity: 0.95, begin: 0 },
    { r: 3.2, opacity: 0.5, begin: durationMs * 0.08 },
    { r: 2.3, opacity: 0.28, begin: durationMs * 0.16 },
  ];

  for (const spec of trailSpec) {
    const circle = document.createElementNS(ns, "circle");
    circle.setAttribute("r", String(spec.r));
    circle.setAttribute("fill", color);
    circle.setAttribute("opacity", "0");
    circle.setAttribute("filter", `url(#loom-const-glow)`);

    const anim = document.createElementNS(ns, "animateMotion");
    anim.setAttribute("dur", `${durationMs}ms`);
    anim.setAttribute("begin", `${spec.begin}ms`);
    anim.setAttribute("fill", "remove");
    anim.setAttribute("calcMode", "spline");
    anim.setAttribute("keySplines", "0.4 0 0.6 1");
    anim.setAttribute("keyTimes", "0;1");

    const mpath = document.createElementNS(ns, "mpath");
    mpath.setAttribute("href", `#${pathId}`);
    anim.appendChild(mpath);
    circle.appendChild(anim);

    // Fade the head in fast, then out toward arrival (trail dissolves)
    const fade = document.createElementNS(ns, "animate");
    fade.setAttribute("attributeName", "opacity");
    fade.setAttribute("dur", `${durationMs}ms`);
    fade.setAttribute("begin", `${spec.begin}ms`);
    fade.setAttribute("fill", "remove");
    fade.setAttribute("values", `0;${spec.opacity};${spec.opacity};0`);
    fade.setAttribute("keyTimes", "0;0.12;0.7;1");
    circle.appendChild(fade);

    g.appendChild(circle);
  }

  svgEl.appendChild(g);

  const headAnim = g.querySelector("animateMotion");
  headAnim?.addEventListener("endEvent", () => {
    g.remove();
    tmpPath.remove();
  }, { once: true });

  // Fallback cleanup (last trail dot begins latest, +buffer)
  setTimeout(() => {
    if (g.parentNode) g.remove();
    if (tmpPath.parentNode) tmpPath.remove();
  }, durationMs + durationMs * 0.16 + 250);
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function Constellation() {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const nodeGroupRefs = useRef<Map<NodeId, SVGGElement>>(new Map());
  const wirePathRefs = useRef<Map<NodeId, string>>(new Map()); // path D strings for packets

  // Orb center + node positions (in px, viewport coords)
  const orbCenter = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const nodePositions = useRef<Map<NodeId, { x: number; y: number }>>(new Map());

  // Compute layout from orb rect
  const recompute = useRef<() => void>(() => {});

  const reducedMotionRef = useRef<boolean>(false);

  useEffect(() => {
    ensureKeyframes();

    // Detect reduced motion
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotionRef.current = mql.matches;
    const onMqlChange = (e: MediaQueryListEvent) => {
      reducedMotionRef.current = e.matches;
    };
    mql.addEventListener("change", onMqlChange);

    const svg = svgRef.current;
    if (!svg) return;

    function computeLayout() {
      const orbEl = document.querySelector('[data-testid="orb-hero"]');
      if (!orbEl) return;
      const orbRect = orbEl.getBoundingClientRect();
      const cx = orbRect.left + orbRect.width / 2;
      const cy = orbRect.top + orbRect.height / 2;
      orbCenter.current = { x: cx, y: cy };

      // Ellipse radii: base on orb size
      const baseR = Math.max(orbRect.width, 60);
      const rx = baseR * RX_FRAC;
      const ry = baseR * RY_FRAC;

      // Keep nodes on-screen: never under the top bar, never off the viewport
      // sides, never below the fold. Labels sit ~24px under the node, so leave
      // headroom below too.
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const MARGIN_X = 70;
      const MARGIN_TOP = 76; // clears the top bar
      const MARGIN_BOTTOM = 60; // clears the label chip + screen edge

      NODES.forEach((node, i) => {
        const rad = degToRad(ANGLES_DEG[i]);
        let px = cx + rx * Math.sin(rad);
        let py = cy - ry * Math.cos(rad);
        px = Math.min(Math.max(px, MARGIN_X), vw - MARGIN_X);
        py = Math.min(Math.max(py, MARGIN_TOP), vh - MARGIN_BOTTOM);
        nodePositions.current.set(node.id, { x: px, y: py });
      });

      renderSVG();
    }

    recompute.current = computeLayout;

    function renderSVG() {
      if (!svg) return;
      const svgRect = svg.getBoundingClientRect();
      const W = svgRect.width || window.innerWidth;
      const H = svgRect.height || window.innerHeight;
      const cx = orbCenter.current.x;
      const cy = orbCenter.current.y;

      // Update wire paths and node group transforms
      NODES.forEach((node) => {
        const pos = nodePositions.current.get(node.id);
        if (!pos) return;

        const dx = cx - pos.x;
        const dy = cy - pos.y;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;

        // Orb edge: stop wire slightly before center (orb radius ~ 90px)
        const ORB_R = 90;
        const edgeFrac = Math.max(0, (len - ORB_R) / len);
        const ex = pos.x + dx * (1 - edgeFrac); // point on orb edge toward node
        const ey = pos.y + dy * (1 - edgeFrac);

        // Cubic bezier: two control points with gentle perpendicular bow
        const nx = -dy / len;
        const ny = dx / len;
        const amp = len * 0.18;
        const cp1x = pos.x + dx * 0.33 + nx * amp;
        const cp1y = pos.y + dy * 0.33 + ny * amp;
        const cp2x = pos.x + dx * 0.66 - nx * amp;
        const cp2y = pos.y + dy * 0.66 - ny * amp;

        // Path FROM node TO orb edge (packet direction)
        const pathD = `M ${pos.x.toFixed(1)} ${pos.y.toFixed(1)} C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${ex.toFixed(1)} ${ey.toFixed(1)}`;
        wirePathRefs.current.set(node.id, pathD);

        // Update SVG elements via refs
        const g = nodeGroupRefs.current.get(node.id);
        if (g) {
          g.setAttribute("transform", `translate(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)})`);
          const wirePath = svg!.querySelector(`[data-wire="${node.id}"]`) as SVGPathElement | null;
          const wireGlow = svg!.querySelector(`[data-wireglow="${node.id}"]`) as SVGPathElement | null;
          if (wirePath) wirePath.setAttribute("d", pathD);
          if (wireGlow) wireGlow.setAttribute("d", pathD);
          // Track the wire gradient to the node→orb direction (dim node, bright orb)
          const grad = svg!.querySelector(`[data-grad="${node.id}"]`) as SVGLinearGradientElement | null;
          if (grad) {
            grad.setAttribute("x1", pos.x.toFixed(1));
            grad.setAttribute("y1", pos.y.toFixed(1));
            grad.setAttribute("x2", ex.toFixed(1));
            grad.setAttribute("y2", ey.toFixed(1));
          }
        }
      });

      // Update SVG viewBox dimensions
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    }

    // ResizeObserver on body to re-measure when layout changes
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => computeLayout());
      ro.observe(document.body);
    } else {
      window.addEventListener("resize", computeLayout, { passive: true });
    }

    // Initial layout
    computeLayout();

    // ── loom-fleet-activity listener ────────────────────────────────────────
    function onFleetActivity(ev: Event) {
      const detail = (ev as CustomEvent<FleetActivity>).detail;
      if (!detail) return;

      // Clear all role active states
      (["builder", "companion", "rewriter"] as NodeRole[]).forEach((role) => {
        const g = nodeGroupRefs.current.get(role);
        if (g) g.removeAttribute("data-active");
      });

      const role = detail.role as NodeRole | null;
      if (!role) return;

      const g = nodeGroupRefs.current.get(role);
      if (!g) return;

      // Flip attribute (no React state — FleetHUD pattern)
      g.setAttribute("data-active", "true");

      // Launch packet along wire (skip in reduced-motion)
      if (!reducedMotionRef.current) {
        const pathD = wirePathRefs.current.get(role);
        const node = NODES.find((n) => n.id === role);
        if (pathD && node && svgRef.current) {
          launchPacket(svgRef.current, pathD, node.color, 900);
        }
      }
    }

    window.addEventListener("loom-fleet-activity", onFleetActivity);

    // ── loom-salience listener ───────────────────────────────────────────────
    function onSalience() {
      // Pulse sensor nodes
      (["auspex", "quakes"] as SensorId[]).forEach((sensor) => {
        const g = nodeGroupRefs.current.get(sensor);
        if (!g || reducedMotionRef.current) return;
        // Trigger CSS animation by toggling class
        g.classList.remove("loom-sensor-pulsing");
        // Force reflow (use getBoundingClientRect which SVGGElement supports)
        void g.getBoundingClientRect();
        g.classList.add("loom-sensor-pulsing");
      });
    }

    window.addEventListener("loom-salience", onSalience);

    return () => {
      window.removeEventListener("loom-fleet-activity", onFleetActivity);
      window.removeEventListener("loom-salience", onSalience);
      mql.removeEventListener("change", onMqlChange);
      if (ro) ro.disconnect();
      else window.removeEventListener("resize", computeLayout);
    };
  }, []);

  const W = typeof window !== "undefined" ? window.innerWidth : 1440;
  const H = typeof window !== "undefined" ? window.innerHeight : 900;

  return (
    <svg
      ref={svgRef}
      data-testid="constellation"
      aria-hidden
      viewBox={`0 0 ${W} ${H}`}
      style={{
        position: "fixed",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        // z 8: above deck layers (z 2-5), below orb-band (z 10)
        // Outside the screen-blend band so normal blend mode keeps labels legible
        zIndex: 8,
        overflow: "visible",
      }}
    >
      <defs>
        <filter id="loom-const-glow" x="-100%" y="-100%" width="300%" height="300%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id="loom-const-node-glow" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        {/* Per-node wire gradients — dim at the node, brighter toward the orb.
            gradientUnits=userSpaceOnUse with endpoints updated on layout so the
            gradient tracks the wire's node→orb direction. */}
        {NODES.map((node) => (
          <linearGradient
            key={`grad-${node.id}`}
            id={`loom-wire-grad-${node.id}`}
            gradientUnits="userSpaceOnUse"
            data-grad={node.id}
            x1="0" y1="0" x2="0" y2="0"
          >
            <stop offset="0%" stopColor={node.color} stopOpacity={0.1} />
            <stop offset="60%" stopColor={node.color} stopOpacity={0.32} />
            <stop offset="100%" stopColor={node.color} stopOpacity={0.7} />
          </linearGradient>
        ))}
      </defs>

      {/* Wires — drawn first (behind nodes) */}
      {NODES.map((node) => (
        <g key={`wire-${node.id}`}>
          {/* Glow layer */}
          <path
            data-wireglow={node.id}
            d=""
            fill="none"
            stroke={node.color}
            strokeWidth={3}
            strokeOpacity={0.06}
            filter="url(#loom-const-glow)"
            strokeLinecap="round"
          />
          {/* Core wire — gradient stroke, brighter toward the orb */}
          <path
            data-wire={node.id}
            data-testid={`wire-${node.id}`}
            d=""
            fill="none"
            stroke={`url(#loom-wire-grad-${node.id})`}
            strokeWidth={1.1}
            strokeLinecap="round"
          />
        </g>
      ))}

      {/* Nodes */}
      {NODES.map((node) => (
        <g
          key={node.id}
          data-testid={`constellation-node-${node.id}`}
          data-node-id={node.id}
          data-node-kind={node.kind}
          ref={(el) => {
            if (el) nodeGroupRefs.current.set(node.id, el);
            else nodeGroupRefs.current.delete(node.id);
          }}
          transform="translate(0,0)"
        >
          {/* Outer dim halo */}
          <circle
            r={14}
            fill={node.color}
            fillOpacity={0.04}
            stroke={node.color}
            strokeWidth={0.5}
            strokeOpacity={0.12}
          />

          {/* Active glow (brightens on activity via CSS attr selector) */}
          <circle
            className="node-glow"
            r={10}
            fill={node.color}
            fillOpacity={0.12}
            filter="url(#loom-const-node-glow)"
          />

          {/* Core node dot */}
          <circle
            r={4}
            fill={node.color}
            fillOpacity={0.85}
          />

          {/* Sensor pulse ring — expands outward on salience (ring, not blink) */}
          {node.kind === "sensor" && (
            <circle
              className="sensor-ring"
              r={5}
              fill="none"
              stroke={node.color}
              strokeWidth={1.5}
              strokeOpacity={0}
            />
          )}

          {/* Glass-chip label — panel surface treatment, 9px mono .1em */}
          <g transform="translate(0, 24)">
            <rect
              x={-(node.label.length * 3.6 + 9)}
              y={-8}
              width={node.label.length * 7.2 + 18}
              height={16}
              rx={5}
              fill="rgba(16,24,43,0.85)"
              stroke="rgba(255,255,255,0.08)"
              strokeWidth={1}
            />
            {/* accent tick — a hairline color cue at the chip's left edge */}
            <rect
              x={-(node.label.length * 3.6 + 9) + 4}
              y={-3.5}
              width={2}
              height={7}
              rx={1}
              fill={node.color}
              fillOpacity={0.85}
            />
            <text
              textAnchor="middle"
              dominantBaseline="central"
              x={2}
              y={0.5}
              style={{
                fontFamily: "var(--f-mono, monospace)",
                fontSize: 9,
                fill: "var(--t2, #9fb0cc)",
                letterSpacing: "0.1em",
                userSelect: "none",
              }}
            >
              {node.label}
            </text>
          </g>
        </g>
      ))}

      {/* Active-node brightness rule via inline style (no React state) */}
      <style>{`
        [data-active="true"] circle.node-glow {
          fill-opacity: 0.45 !important;
          animation: loom-node-pulse 0.8s ease-out;
        }
        [data-active="true"] circle:not(.node-glow):not(.sensor-ring) {
          fill-opacity: 1 !important;
        }
        .loom-sensor-pulsing circle.sensor-ring {
          animation: loom-sensor-pulse 1s ease-out forwards;
        }
        @media (prefers-reduced-motion: reduce) {
          [data-active="true"] circle.node-glow {
            animation: none !important;
          }
          .loom-sensor-pulsing circle.sensor-ring {
            animation: none !important;
          }
        }
      `}</style>
    </svg>
  );
}
