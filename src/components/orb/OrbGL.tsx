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

export function OrbGL({ mood, reducedMotion, size = 180 }: OrbGLProps) {
  return (
    <div style={{ width: size * 2.4, height: size * 2.4, flexShrink: 0 }}>
      <Canvas dpr={[1, 2]} gl={{ antialias: true, alpha: true }} style={{ background: "transparent" }} onCreated={({ gl }) => { gl.setClearAlpha(0); }}>
        <OrbMesh mood={mood} reducedMotion={reducedMotion} />
        <EffectComposer>
          <Bloom luminanceThreshold={0.85} intensity={1.8} mipmapBlur />
          <ChromaticAberration offset={new THREE.Vector2(0.0009, 0.0006)} />
        </EffectComposer>
      </Canvas>
    </div>
  );
}
