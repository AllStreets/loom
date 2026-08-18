import { useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { EffectComposer, Bloom, ChromaticAberration } from "@react-three/postprocessing";
import * as THREE from "three";
import { VERT, FRAG } from "./shaders";
import { stepOrbState, breath, MOOD_TARGETS, hexToRgb, type OrbMood, type OrbState } from "../../lib/orb/state";
import { audioLevel } from "../../lib/orb/audioLevel";

interface OrbGLProps {
  mood: OrbMood;
  reducedMotion: boolean;
  size?: number;
  /** Deck mode: true-alpha context, no post-processing, no band blend required. */
  transparent?: boolean;
}

// Pre-allocate to avoid GC pressure in the animation loop
const _color = new THREE.Color();

function OrbMesh({ mood, reducedMotion }: Omit<OrbGLProps, "size">) {
  const target0 = MOOD_TARGETS[mood];
  const [r0, g0, b0] = hexToRgb(target0.color);
  const orbState = useRef<OrbState>({
    color: [r0, g0, b0],
    amp: target0.amp,
    speed: target0.speed,
    glow: target0.glow,
  });
  const uTimeRef = useRef(0);

  const matRef = useRef<THREE.ShaderMaterial>(null!);

  useFrame((_state, dt) => {
    const nextState = stepOrbState(orbState.current, mood, dt, audioLevel.current);
    orbState.current = nextState;
    uTimeRef.current += dt;

    const mat = matRef.current;
    if (!mat) return;

    const [r, g, b] = nextState.color;
    _color.setRGB(r, g, b);

    mat.uniforms.uTime.value = uTimeRef.current;
    mat.uniforms.uAmp.value = nextState.amp;
    mat.uniforms.uSpeed.value = nextState.speed;
    mat.uniforms.uGlow.value = nextState.glow;
    mat.uniforms.uBreath.value = reducedMotion ? 0.5 : breath(uTimeRef.current);
    mat.uniforms.uColor.value.copy(_color);
  });

  const [ir, ig, ib] = hexToRgb(target0.color);

  return (
    <mesh>
      <icosahedronGeometry args={[1.55, 24]} />
      <shaderMaterial
        ref={matRef}
        vertexShader={VERT}
        fragmentShader={FRAG}
        uniforms={{
          uTime:   { value: 0 },
          uAmp:    { value: target0.amp },
          uSpeed:  { value: target0.speed },
          uBreath: { value: 0.5 },
          uColor:  { value: new THREE.Color(ir, ig, ib) },
          uGlow:   { value: target0.glow },
        }}
      />
    </mesh>
  );
}

export function OrbGL({ mood, reducedMotion, size = 180, transparent = false }: OrbGLProps) {
  const moodColor = MOOD_TARGETS[mood].color;
  if (transparent) {
    // DECK MODE — true alpha, no post-processing, no blend needed.
    // The band's mix-blend-mode over a deck iframe forces a cross-document
    // backdrop readback on EVERY orb frame, which flickers the whole iframe
    // (banner/earth/moon). With the EffectComposer dropped, the GL context can
    // be genuinely transparent: no black clear to screen out, so no blend, so
    // no readback. The shader's own fresnel/rim glow carries the look; the
    // radial mask keeps edges soft.
    return (
      <div style={{ width: size * 2.4, height: size * 2.4, flexShrink: 0 }}>
        <Canvas
          dpr={[1, 2]}
          gl={{ antialias: true, alpha: true }}
          style={{
            background: "transparent",
            maskImage: "radial-gradient(circle closest-side, rgba(0,0,0,1) 55%, rgba(0,0,0,0) 96%)",
            WebkitMaskImage: "radial-gradient(circle closest-side, rgba(0,0,0,1) 55%, rgba(0,0,0,0) 96%)",
            // Without bloom the shader core washes out over bright deck content.
            // drop-shadow composites FORWARD (no backdrop readback) so it cannot
            // reintroduce the blend flicker; mood-colored halo keeps the presence.
            filter: "drop-shadow(0 0 26px " + moodColor + "aa) drop-shadow(0 0 64px " + moodColor + "55)",
          }}
          onCreated={({ gl }) => { gl.setClearAlpha(0); }}
        >
          <OrbMesh mood={mood} reducedMotion={reducedMotion} />
        </Canvas>
      </div>
    );
  }
  return (
    <div style={{ width: size * 2.4, height: size * 2.4, flexShrink: 0 }}>
      {/* VOID MODE — full bloom. EffectComposer's final pass writes an opaque buffer,
          so an alpha context still yields a visible rectangle. The verified combo
          (screenshot-checked in-browser):
          (1) clear to pure black; (2) the orb BAND carries mix-blend-mode: screen (the
          blend must live there — orb-hero's transform and the band's z-index isolate any
          deeper blend from the page backdrop), so black contributes no light; (3) a
          radial mask fades the bloom veil out before the canvas edge. All three are
          load-bearing: without the mask the veil edge shows; without the band blend a
          dark halo rings the orb. Over DECKS this blend is the flicker source — decks
          use the transparent mode above instead. */}
      <Canvas
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: false }}
        style={{
          background: "#000",
          maskImage: "radial-gradient(circle closest-side, rgba(0,0,0,1) 55%, rgba(0,0,0,0) 96%)",
          WebkitMaskImage: "radial-gradient(circle closest-side, rgba(0,0,0,1) 55%, rgba(0,0,0,0) 96%)",
        }}
        onCreated={({ gl }) => { gl.setClearColor(0x000000, 1); }}
      >
        <OrbMesh mood={mood} reducedMotion={reducedMotion} />
        <EffectComposer>
          <Bloom luminanceThreshold={0.85} intensity={1.8} mipmapBlur />
          <ChromaticAberration offset={new THREE.Vector2(0.0009, 0.0006)} />
        </EffectComposer>
      </Canvas>
    </div>
  );
}
