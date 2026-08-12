export type OrbMood =
  | "idle"
  | "listening"
  | "thinking"
  | "building"
  | "speaking"
  | "offline";

export type OrbTargets = {
  color: string;
  amp: number;
  speed: number;
  glow: number;
};

export const MOOD_TARGETS: Record<OrbMood, OrbTargets> = {
  idle:     { color: "#22d3ee", amp: 0.22, speed: 0.35, glow: 0.55 },
  listening:{ color: "#0a84ff", amp: 0.34, speed: 0.7,  glow: 0.8  },
  thinking: { color: "#a78bfa", amp: 0.3,  speed: 1.0,  glow: 0.75 },
  building: { color: "#7dd3fc", amp: 0.38, speed: 1.2,  glow: 0.9  },
  speaking: { color: "#10b981", amp: 0.36, speed: 0.8,  glow: 0.85 },
  offline:  { color: "#5f6f8c", amp: 0.08, speed: 0.12, glow: 0.25 },
};

export type OrbState = {
  color: [number, number, number];
  amp: number;
  speed: number;
  glow: number;
};

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return [r, g, b];
}

export function stepOrbState(
  cur: OrbState,
  mood: OrbMood,
  dt: number,
  audioLevelVal = 0
): OrbState {
  const target = MOOD_TARGETS[mood];
  const rate = 1 - Math.exp(-dt * 4);

  const [tr, tg, tb] = hexToRgb(target.color);
  const [cr, cg, cb] = cur.color;

  const rawAmpTarget = Math.min(target.amp + audioLevelVal * 0.5, 0.9);

  return {
    color: [
      cr + (tr - cr) * rate,
      cg + (tg - cg) * rate,
      cb + (tb - cb) * rate,
    ],
    amp:   cur.amp   + (rawAmpTarget    - cur.amp)   * rate,
    speed: cur.speed + (target.speed    - cur.speed)  * rate,
    glow:  cur.glow  + (target.glow     - cur.glow)   * rate,
  };
}

export function breath(t: number): number {
  return 0.5 + 0.5 * Math.sin(t * (2 * Math.PI / 4));
}
