export type OrbTier = "gl" | "flat";

export interface OrbEnv {
  webgl2?: boolean;
  reducedMotion?: boolean;
  forceFlat?: boolean;
}

export function detectTier(env?: OrbEnv): { tier: OrbTier; reducedMotion: boolean } {
  if (env !== undefined) {
    // Injected (test) path
    const reducedMotion = env.reducedMotion ?? false;
    const forceFlat = env.forceFlat ?? false;
    const webgl2 = env.webgl2 ?? false;

    const tier: OrbTier =
      forceFlat || reducedMotion || !webgl2 ? "flat" : "gl";

    return { tier, reducedMotion };
  }

  // Real detection path
  const reducedMotion =
    typeof window !== "undefined"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false;

  const forceFlat =
    typeof localStorage !== "undefined"
      ? localStorage.getItem("loom.orb") === "flat"
      : false;

  const webgl2 =
    typeof document !== "undefined"
      ? !!document.createElement("canvas").getContext("webgl2")
      : false;

  const tier: OrbTier =
    forceFlat || reducedMotion || !webgl2 ? "flat" : "gl";

  return { tier, reducedMotion };
}
