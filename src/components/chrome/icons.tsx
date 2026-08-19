/**
 * icons.tsx — tiny inline SVG glyphs for kernel chrome.
 *
 * The SANDBOX kit ships icon(name) glyphs (see lib/organs/uikitSrc.ts). Kernel
 * chrome cannot import the sandbox runtime, so these mirror the exact same paths
 * (24-unit viewBox, stroke=currentColor, round caps/joins) for visual parity.
 *
 * Every glyph inherits color via currentColor and sizes via the `size` prop.
 */

import type { CSSProperties } from "react";

interface GlyphProps {
  size?: number;
  strokeWidth?: number;
  style?: CSSProperties;
  className?: string;
}

function Svg({
  size = 14,
  strokeWidth = 2,
  style,
  className,
  children,
}: GlyphProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      style={{ display: "block", ...style }}
      className={className}
    >
      {children}
    </svg>
  );
}

// paths.x — 'M18 6L6 18M6 6l12 12'
export function IconX(props: GlyphProps) {
  return (
    <Svg {...props}>
      <path d="M18 6L6 18M6 6l12 12" />
    </Svg>
  );
}

// paths.plus — 'M12 5v14M5 12h14'
export function IconPlus(props: GlyphProps) {
  return (
    <Svg {...props}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

// paths.copy — the sandbox kit's copy glyph
export function IconCopy(props: GlyphProps) {
  return (
    <Svg {...props}>
      <path d="M20 9H11a2 2 0 00-2 2v9a2 2 0 002 2h9a2 2 0 002-2v-9a2 2 0 00-2-2z" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </Svg>
  );
}

// chevron-right — rotates to point down when expanded (same feather geometry)
export function IconChevron(props: GlyphProps) {
  return (
    <Svg {...props}>
      <path d="M9 6l6 6-6 6" />
    </Svg>
  );
}

// eye/watch — "add to watch" affordance (feather 'eye')
export function IconWatch(props: GlyphProps) {
  return (
    <Svg {...props}>
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  );
}

// trash — delete affordance
export function IconTrash(props: GlyphProps) {
  return (
    <Svg {...props}>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" />
    </Svg>
  );
}

// crosshair — locate on globe
export function IconLocate(props: GlyphProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="3" />
      <line x1="12" y1="2" x2="12" y2="6" />
      <line x1="12" y1="18" x2="12" y2="22" />
      <line x1="2" y1="12" x2="6" y2="12" />
      <line x1="18" y1="12" x2="22" y2="12" />
    </Svg>
  );
}
