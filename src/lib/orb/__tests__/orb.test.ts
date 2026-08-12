import { describe, it, expect } from "vitest";
import {
  MOOD_TARGETS,
  hexToRgb,
  stepOrbState,
  breath,
  type OrbMood,
  type OrbState,
} from "../state";
import { detectTier } from "../capability";
import { audioLevel, envelope } from "../audioLevel";

// ---------------------------------------------------------------------------
// MOOD_TARGETS
// ---------------------------------------------------------------------------

describe("MOOD_TARGETS", () => {
  const ALL_MOODS: OrbMood[] = [
    "idle",
    "listening",
    "thinking",
    "building",
    "speaking",
    "offline",
  ];

  it("contains all 6 moods", () => {
    for (const mood of ALL_MOODS) {
      expect(MOOD_TARGETS).toHaveProperty(mood);
    }
  });

  it("has no yellow hexes", () => {
    for (const mood of ALL_MOODS) {
      const color = MOOD_TARGETS[mood].color.toLowerCase();
      // Yellow hues: hues ~45-70 deg. Simple check: starts with #ffff or #f?d?0 etc.
      // None of the palette should be yellow. Check known yellow prefixes.
      expect(color).not.toMatch(/^#ff[ef][0-9a-f]{3}$/i);
      expect(color).not.toMatch(/^#[ef][0-9a-f]d[0-9a-f]{2}0[0-9a-f]?$/i);
      // Ensure color is a valid hex
      expect(color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("idle target values match spec", () => {
    expect(MOOD_TARGETS.idle.color).toBe("#22d3ee");
    expect(MOOD_TARGETS.idle.amp).toBeCloseTo(0.22);
    expect(MOOD_TARGETS.idle.speed).toBeCloseTo(0.35);
    expect(MOOD_TARGETS.idle.glow).toBeCloseTo(0.55);
  });

  it("offline target values match spec", () => {
    expect(MOOD_TARGETS.offline.color).toBe("#5f6f8c");
    expect(MOOD_TARGETS.offline.amp).toBeCloseTo(0.08);
  });
});

// ---------------------------------------------------------------------------
// hexToRgb
// ---------------------------------------------------------------------------

describe("hexToRgb", () => {
  it("converts #ffffff to [1, 1, 1]", () => {
    const [r, g, b] = hexToRgb("#ffffff");
    expect(r).toBeCloseTo(1);
    expect(g).toBeCloseTo(1);
    expect(b).toBeCloseTo(1);
  });

  it("converts #000000 to [0, 0, 0]", () => {
    const [r, g, b] = hexToRgb("#000000");
    expect(r).toBeCloseTo(0);
    expect(g).toBeCloseTo(0);
    expect(b).toBeCloseTo(0);
  });

  it("converts #22d3ee correctly (idle cyan)", () => {
    const [r, g, b] = hexToRgb("#22d3ee");
    // 0x22/255 ≈ 0.133, 0xd3/255 ≈ 0.827, 0xee/255 ≈ 0.933
    expect(r).toBeCloseTo(0x22 / 255, 3);
    expect(g).toBeCloseTo(0xd3 / 255, 3);
    expect(b).toBeCloseTo(0xee / 255, 3);
  });

  it("returns values in [0, 1]", () => {
    for (const hex of ["#ff0000", "#00ff00", "#0000ff", "#a78bfa", "#10b981"]) {
      const [r, g, b] = hexToRgb(hex);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(1);
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThanOrEqual(1);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// stepOrbState
// ---------------------------------------------------------------------------

const makeIdleState = (): OrbState => ({
  color: hexToRgb("#000000"),
  amp: 0,
  speed: 0,
  glow: 0,
});

describe("stepOrbState", () => {
  it("converges toward target over repeated steps", () => {
    let state = makeIdleState();
    const mood: OrbMood = "idle";
    const target = MOOD_TARGETS[mood];
    const [tr, tg, tb] = hexToRgb(target.color);

    for (let i = 0; i < 200; i++) {
      state = stepOrbState(state, mood, 0.016);
    }

    expect(state.color[0]).toBeCloseTo(tr, 2);
    expect(state.color[1]).toBeCloseTo(tg, 2);
    expect(state.color[2]).toBeCloseTo(tb, 2);
    expect(state.amp).toBeCloseTo(target.amp, 2);
    expect(state.speed).toBeCloseTo(target.speed, 2);
    expect(state.glow).toBeCloseTo(target.glow, 2);
  });

  it("is frame-rate independent within tolerance", () => {
    const mood: OrbMood = "thinking";

    // Two half-steps
    let stateA = makeIdleState();
    stateA = stepOrbState(stateA, mood, 0.008);
    stateA = stepOrbState(stateA, mood, 0.008);

    // One full step
    let stateB = makeIdleState();
    stateB = stepOrbState(stateB, mood, 0.016);

    // They should be close but not identical (exponential lerp is not perfectly
    // frame-rate independent, but should be within a few percent)
    expect(stateA.color[0]).toBeCloseTo(stateB.color[0], 1);
    expect(stateA.amp).toBeCloseTo(stateB.amp, 1);
  });

  it("does not mutate the input state", () => {
    const state = makeIdleState();
    const original = { ...state, color: [...state.color] as [number, number, number] };
    stepOrbState(state, "idle", 0.016);
    expect(state.color).toEqual(original.color);
    expect(state.amp).toBe(original.amp);
  });

  it("returns a new object each call", () => {
    const state = makeIdleState();
    const next = stepOrbState(state, "idle", 0.016);
    expect(next).not.toBe(state);
  });

  it("audio boosts amp target but clamps at 0.9", () => {
    // With audioLevel=1.0, target amp boost would be +0.5 → clamped at 0.9
    let state = makeIdleState();
    for (let i = 0; i < 500; i++) {
      state = stepOrbState(state, "idle", 0.016, 1.0);
    }
    // Amp should be clamped at 0.9 (not above)
    expect(state.amp).toBeLessThanOrEqual(0.9);
    // But it should be significantly above the normal idle amp (0.22)
    expect(state.amp).toBeGreaterThan(0.5);
  });

  it("amp with no audio converges to natural target", () => {
    let state = makeIdleState();
    for (let i = 0; i < 500; i++) {
      state = stepOrbState(state, "idle", 0.016, 0);
    }
    expect(state.amp).toBeCloseTo(MOOD_TARGETS.idle.amp, 2);
  });
});

// ---------------------------------------------------------------------------
// breath
// ---------------------------------------------------------------------------

describe("breath", () => {
  it("returns values in [0, 1]", () => {
    for (let t = 0; t < 20; t += 0.1) {
      const v = breath(t);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("has a period of 4 seconds", () => {
    // breath(t) should equal breath(t+4) for any t
    for (let t = 0; t < 8; t += 0.5) {
      expect(breath(t)).toBeCloseTo(breath(t + 4), 10);
    }
  });

  it("equals 0.5 at t=0 (sin(0)=0 → 0.5+0=0.5)", () => {
    expect(breath(0)).toBeCloseTo(0.5);
  });

  it("equals 1.0 at t=1 (quarter period, sin peak)", () => {
    // 0.5 + 0.5 * sin(1 * 2π/4) = 0.5 + 0.5 * sin(π/2) = 0.5 + 0.5 = 1.0
    expect(breath(1)).toBeCloseTo(1.0);
  });
});

// ---------------------------------------------------------------------------
// detectTier
// ---------------------------------------------------------------------------

describe("detectTier", () => {
  it("webgl2=false → flat tier", () => {
    const result = detectTier({ webgl2: false, reducedMotion: false, forceFlat: false });
    expect(result.tier).toBe("flat");
  });

  it("forceFlat=true → flat tier regardless of webgl2", () => {
    const result = detectTier({ webgl2: true, reducedMotion: false, forceFlat: true });
    expect(result.tier).toBe("flat");
  });

  it("reducedMotion=true → flat tier", () => {
    const result = detectTier({ webgl2: true, reducedMotion: true, forceFlat: false });
    expect(result.tier).toBe("flat");
  });

  it("webgl2=true, reducedMotion=false, forceFlat=false → gl tier", () => {
    const result = detectTier({ webgl2: true, reducedMotion: false, forceFlat: false });
    expect(result.tier).toBe("gl");
  });

  it("reducedMotion propagates in the return value", () => {
    const yes = detectTier({ webgl2: true, reducedMotion: true, forceFlat: false });
    const no = detectTier({ webgl2: true, reducedMotion: false, forceFlat: false });
    expect(yes.reducedMotion).toBe(true);
    expect(no.reducedMotion).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// envelope (audioLevel)
// ---------------------------------------------------------------------------

describe("audioLevel module", () => {
  it("exports audioLevel.current = 0", () => {
    expect(audioLevel.current).toBe(0);
  });
});

describe("envelope", () => {
  it("attack path: sample > prev uses attack rate 0.65", () => {
    const prev = 0;
    const sample = 1;
    const result = envelope(prev, sample, 0.65, 0.12);
    // prev + (sample - prev) * attack = 0 + 1 * 0.65 = 0.65
    expect(result).toBeCloseTo(0.65);
  });

  it("decay path: sample < prev uses decay rate 0.12", () => {
    const prev = 1;
    const sample = 0;
    const result = envelope(prev, sample, 0.65, 0.12);
    // prev + (sample - prev) * decay = 1 + (0 - 1) * 0.12 = 1 - 0.12 = 0.88
    expect(result).toBeCloseTo(0.88);
  });

  it("attack is faster than decay", () => {
    // From 0, one step toward 1: attack moves 0.65; from 1, one step toward 0: moves only 0.12
    const attackStep = envelope(0, 1);
    const decayStep = 1 - envelope(1, 0);
    expect(attackStep).toBeGreaterThan(decayStep);
  });

  it("equal sample and prev: no movement", () => {
    expect(envelope(0.5, 0.5)).toBeCloseTo(0.5);
  });
});
