import React, { Component, type ComponentType, useRef } from "react";
import { detectTier } from "../../lib/orb/capability";
import { Orb2D } from "./Orb2D";
import type { OrbMood } from "../../lib/orb/state";

const OrbGLLazy = React.lazy(() =>
  import("./OrbGL").then((m) => ({ default: m.OrbGL }))
);

export interface OrbProps {
  mood: OrbMood;
  reducedMotion?: boolean;
  size?: number;
  /** Deck mode: true-alpha GL, no bloom, no band blend (see OrbGL). */
  transparent?: boolean;
  /** For testing: inject a GL component (or a thrower) */
  glComponent?: ComponentType<{ mood: OrbMood; reducedMotion: boolean; size?: number; transparent?: boolean }>;
  /** For testing: override tier detection */
  tierOverride?: "gl" | "flat";
}

interface EBProps {
  children: React.ReactNode;
  fallback: React.ReactNode;
  onError: () => void;
}
interface EBState { crashed: boolean }

class OrbErrorBoundary extends Component<EBProps, EBState> {
  state: EBState = { crashed: false };
  static getDerivedStateFromError() { return { crashed: true }; }
  componentDidCatch() { this.props.onError(); }
  render() {
    return this.state.crashed ? this.props.fallback : this.props.children;
  }
}

export function Orb({ mood, reducedMotion: reducedMotionProp, size = 180, transparent = false, glComponent, tierOverride }: OrbProps) {
  const detectedRef = useRef<{ tier: "gl" | "flat"; reducedMotion: boolean } | null>(null);
  if (!detectedRef.current) {
    if (tierOverride) {
      detectedRef.current = { tier: tierOverride, reducedMotion: reducedMotionProp ?? false };
    } else {
      detectedRef.current = detectTier();
    }
  }

  const { tier, reducedMotion: detectedRM } = detectedRef.current;
  const reducedMotion = reducedMotionProp ?? detectedRM;

  const fallback = <Orb2D mood={mood} reducedMotion={reducedMotion} size={size} />;

  if (tier === "flat") {
    return <div data-testid="orb">{fallback}</div>;
  }

  const GLComponent = glComponent ?? OrbGLLazy;

  const handleError = () => {
    try { localStorage.setItem("loom.orb", "flat"); } catch {}
    detectedRef.current = { tier: "flat", reducedMotion };
  };

  return (
    <div data-testid="orb">
      <OrbErrorBoundary fallback={fallback} onError={handleError}>
        <React.Suspense fallback={fallback}>
          <GLComponent mood={mood} reducedMotion={reducedMotion} size={size} transparent={transparent} />
        </React.Suspense>
      </OrbErrorBoundary>
    </div>
  );
}
