import { useMemo } from "react";
import { MOOD_TARGETS, type OrbMood } from "../../lib/orb/state";

interface Orb2DProps {
  mood: OrbMood;
  reducedMotion: boolean;
  size?: number;
}

const PULSE_KEYFRAMES = `
@keyframes orb2d-pulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.045); }
}
`;

let styleInjected = false;
function ensurePulseStyle() {
  if (styleInjected || typeof document === "undefined") return;
  styleInjected = true;
  const s = document.createElement("style");
  s.textContent = PULSE_KEYFRAMES;
  document.head.appendChild(s);
}

export function Orb2D({ mood, reducedMotion, size = 180 }: Orb2DProps) {
  ensurePulseStyle();
  const { color, glow } = MOOD_TARGETS[mood];

  const glowPx = useMemo(() => Math.round(glow * 48), [glow]);

  const containerStyle: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    background: `radial-gradient(circle at 35% 35%, ${color} 0%, #060b18 72%)`,
    boxShadow: `0 0 ${glowPx}px ${Math.round(glowPx * 0.6)}px ${color}55, inset 0 0 12px 2px ${color}33`,
    border: `1px solid ${color}44`,
    transition: "background 1s ease, box-shadow 1s ease",
    flexShrink: 0,
    animation: reducedMotion ? "none" : "orb2d-pulse 4s ease-in-out infinite",
  };

  return <div data-testid="orb-2d" style={containerStyle} />;
}
