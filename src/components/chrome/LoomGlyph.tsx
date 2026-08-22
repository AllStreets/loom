/**
 * LoomGlyph — the LOOM mark, inline for kernel chrome.
 *
 * Mirrors `public/brand/loom-glyph.svg` (the canonical brand definition and the
 * one place raw hex is allowed). Chrome renders the same geometry through
 * tokens — warp threads in `--t3`, the weft in `--accent` — so the mark sits in
 * the palette and mood glow can be applied by the caller via a CSS
 * `filter: drop-shadow(...)` on the element (see Shell's top bar).
 *
 * `draw` runs the ignition treatment: the weft thread draws itself across the
 * warp once (~1.2s ease-out) via stroke-dasharray/dashoffset. Callers must pass
 * `draw={false}` under reduced motion; the media query below also disables the
 * animation as defense-in-depth so the static glyph renders either way.
 */

import type { CSSProperties } from "react";

interface LoomGlyphProps {
  size?: number;
  /** Animate the weft thread drawing itself across the warp (once, at boot). */
  draw?: boolean;
  style?: CSSProperties;
  className?: string;
}

export default function LoomGlyph({
  size = 18,
  draw = false,
  style,
  className,
}: LoomGlyphProps) {
  return (
    <svg
      data-testid="loom-glyph"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden
      focusable="false"
      style={{ display: "block", ...style }}
      className={className}
    >
      {draw && (
        <style>{`
          @keyframes loom-weft-draw { from { stroke-dashoffset: 100; } to { stroke-dashoffset: 0; } }
          .loom-weft-draw { stroke-dasharray: 100; animation: loom-weft-draw 1.2s var(--ease-out) both; }
          @media (prefers-reduced-motion: reduce) {
            .loom-weft-draw { animation: none; stroke-dasharray: none; }
          }
        `}</style>
      )}
      {/* warp: three vertical threads */}
      <path
        d="M10 7v18M16 7v18M22 7v18"
        stroke="var(--t3)"
        strokeWidth={2}
        strokeLinecap="round"
      />
      {/* weft: one luminous thread, weaving over-under-over, rising into view */}
      <path
        data-testid="loom-glyph-weft"
        d="M4 20 C6 13 8 12 10 15.5 C12 19 14 20 16 16.5 C18 13 20 12 22 15.5 C24 18.5 26 13 28 8"
        stroke="var(--accent)"
        strokeWidth={2.4}
        strokeLinecap="round"
        pathLength={100}
        className={draw ? "loom-weft-draw" : undefined}
      />
      {/* the under-crossing: middle warp passes over the weft */}
      <path
        d="M16 13.5v6"
        stroke="var(--t3)"
        strokeWidth={2}
        strokeLinecap="round"
      />
    </svg>
  );
}
