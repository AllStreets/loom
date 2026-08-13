/**
 * Field.tsx
 * Background ambient canvas: ~90 slow drifting particles + 2 aurora radial gradients.
 * Uses the shared ambientLoop for ticking. DPR-aware. Fixed position, zIndex:1.
 * Honors prefers-reduced-motion: static render with half density (45 particles).
 * Zero allocation in tick — particle array preallocated.
 */

import { useEffect, useRef } from "react";
import { subscribe } from "../../lib/ambient/ambientLoop";

const MAX_PARTICLES = 90;
const REDUCED_PARTICLES = 45;

interface Particle {
  x: number; // 0..1 normalized
  y: number;
  vx: number;
  vy: number;
  r: number;    // radius px (1-2)
  a: number;    // base alpha (0.04-0.08)
  z: number;    // depth 0-1 for parallax
  phase: number; // sine phase offset
}

function createParticles(count: number): Particle[] {
  const arr: Particle[] = new Array(count);
  for (let i = 0; i < count; i++) {
    arr[i] = makeParticle();
  }
  return arr;
}

function makeParticle(): Particle {
  return {
    x: Math.random(),
    y: Math.random(),
    vx: (Math.random() - 0.5) * 0.00004,
    vy: (Math.random() - 0.5) * 0.00004,
    r: 1 + Math.random(),
    a: 0.04 + Math.random() * 0.04,
    z: Math.random(),
    phase: Math.random() * Math.PI * 2,
  };
}

function makeColorString(particle: Particle): string {
  const cyan = Math.random() > 0.4;
  return cyan
    ? `rgba(34,211,238,${particle.a})`
    : `rgba(255,255,255,${particle.a})`;
}

function createColorStrings(particles: Particle[]): string[] {
  return particles.map(makeColorString);
}

export default function Field() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const reducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const count = reducedMotion ? REDUCED_PARTICLES : MAX_PARTICLES;
  // Preallocate once, stable across renders
  const particlesRef = useRef<Particle[]>(createParticles(count));
  // Precomputed final color strings per particle — zero allocation in tick
  const colorStringsRef = useRef<string[]>(
    createColorStrings(particlesRef.current)
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;

    function resize() {
      if (!canvas) return;
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
    }

    resize();
    window.addEventListener("resize", resize, { passive: true });

    const ctx = canvas.getContext("2d");
    const particles = particlesRef.current;
    const colorStrings = colorStringsRef.current;

    // Static render for reduced motion — draw once and return
    if (reducedMotion) {
      if (ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const W = canvas.width;
        const H = canvas.height;
        for (let i = 0; i < particles.length; i++) {
          const p = particles[i];
          const px = p.x * W;
          const py = p.y * H;
          ctx.beginPath();
          ctx.arc(px, py, p.r * dpr, 0, Math.PI * 2);
          ctx.fillStyle = colorStrings[i];
          ctx.fill();
        }
      }
      return () => {
        window.removeEventListener("resize", resize);
      };
    }

    // Animated render — subscribe to shared rAF loop
    function drawTick(t: number, _dt: number) {
      if (!canvas || !ctx) return;
      const W = canvas.width;
      const H = canvas.height;

      ctx.clearRect(0, 0, W, H);

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];

        // Update position (wrapping)
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0) p.x += 1;
        if (p.x > 1) p.x -= 1;
        if (p.y < 0) p.y += 1;
        if (p.y > 1) p.y -= 1;

        // Parallax by depth: deeper particles move slower visually (already in vx/vy)
        // Slight sine drift
        const driftX = Math.sin(t * 0.2 + p.phase) * 0.3 * p.z;
        const driftY = Math.cos(t * 0.15 + p.phase * 1.3) * 0.2 * p.z;

        const px = (p.x * W + driftX) % W;
        const py = (p.y * H + driftY) % H;

        ctx.beginPath();
        ctx.arc(px, py, p.r * dpr, 0, Math.PI * 2);
        ctx.fillStyle = colorStrings[i];
        ctx.fill();
      }
    }

    const unsub = subscribe(drawTick);

    return () => {
      unsub();
      window.removeEventListener("resize", resize);
    };
  }, [reducedMotion, count]);

  return (
    <>
      {/* Aurora layers — CSS keyframe animation, not canvas */}
      <div
        aria-hidden
        data-testid="aurora-layer"
        style={{
          position: "fixed",
          inset: 0,
          pointerEvents: "none",
          zIndex: 1,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            width: "120%",
            height: "120%",
            top: "-10%",
            left: "-10%",
            background:
              "radial-gradient(ellipse 60% 40% at 30% 30%, rgba(34,211,238,0.07) 0%, transparent 70%)",
            animation: reducedMotion ? "none" : "aurora-drift-a 180s linear infinite",
          }}
        />
        <div
          style={{
            position: "absolute",
            width: "120%",
            height: "120%",
            top: "-10%",
            left: "-10%",
            background:
              "radial-gradient(ellipse 50% 35% at 70% 65%, rgba(34,211,238,0.05) 0%, transparent 65%)",
            animation: reducedMotion ? "none" : "aurora-drift-b 240s linear infinite",
          }}
        />
      </div>

      <canvas
        ref={canvasRef}
        data-testid="ambient-field"
        aria-hidden
        style={{
          position: "fixed",
          inset: 0,
          pointerEvents: "none",
          zIndex: 1,
          display: "block",
        }}
      />

      {/* Aurora keyframes injected via style tag */}
      {!reducedMotion && (
        <style>{`
          @keyframes aurora-drift-a {
            0%   { transform: translate(0%, 0%) rotate(0deg); }
            33%  { transform: translate(8%, -5%) rotate(15deg); }
            66%  { transform: translate(-6%, 8%) rotate(-10deg); }
            100% { transform: translate(0%, 0%) rotate(0deg); }
          }
          @keyframes aurora-drift-b {
            0%   { transform: translate(0%, 0%) rotate(0deg); }
            25%  { transform: translate(-10%, 6%) rotate(20deg); }
            50%  { transform: translate(5%, -8%) rotate(-5deg); }
            75%  { transform: translate(8%, 4%) rotate(12deg); }
            100% { transform: translate(0%, 0%) rotate(0deg); }
          }
        `}</style>
      )}
    </>
  );
}
