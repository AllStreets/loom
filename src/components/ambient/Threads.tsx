/**
 * Threads.tsx
 * Canvas layer covering the content region.
 * Draws luminous bezier threads from orb anchor to each open organ window's title bar.
 * Uses the shared ambientLoop for ticking.
 * Honors prefers-reduced-motion: static faint lines.
 * Skips redraw when document.hidden.
 */

import { useEffect, useRef, useState } from "react";
import { subscribe } from "../../lib/ambient/ambientLoop";
import { windowRegistry } from "../../lib/ambient/windowRegistry";
import { MOOD_TARGETS, hexToRgb } from "../../lib/orb/state";

export interface ThreadPathOut {
  cp1x: number;
  cp1y: number;
  cp2x: number;
  cp2y: number;
}

/**
 * Compute bezier control points for a thread with sine-based undulation.
 * Undulation is bounded: max ±60px from the straight midpoint.
 * Writes result into `out` — zero heap allocation per call.
 */
export function threadPath(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  t: number,
  out: ThreadPathOut
): void {
  const midX = (fromX + toX) / 2;
  const midY = (fromY + toY) / 2;

  // Direction perpendicular to the thread
  const dx = toX - fromX;
  const dy = toY - fromY;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;

  // Bounded sine undulation: max ±60px
  const MAX_UNDULATION = 60;
  const amp1 = Math.sin(t * 0.4 + 0.0) * MAX_UNDULATION;
  const amp2 = Math.sin(t * 0.3 + Math.PI * 0.7) * MAX_UNDULATION;

  out.cp1x = midX * 0.5 + fromX * 0.5 + nx * amp1;
  out.cp1y = midY * 0.5 + fromY * 0.5 + ny * amp1;
  out.cp2x = midX * 0.5 + toX * 0.5 + nx * amp2;
  out.cp2y = midY * 0.5 + toY * 0.5 + ny * amp2;
}

export const THREAD_ALPHA_IDLE = 0.12;
export const THREAD_ALPHA_FOCUS = 0.40;
export const THREAD_FOCUSED_WIDTH = 2.5;
export const THREAD_SHADOW_BLUR = 14;
const FOCUS_FADE_SPEED = 3.0; // alpha decay rate per second toward idle
let _threadRgb = "34,211,238";

interface ThreadState {
  id: string;
  alpha: number; // current rendered alpha
}

export default function Threads() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const threadStateRef = useRef<Map<string, ThreadState>>(new Map());

  const [reducedMotion, setReducedMotion] = useState<boolean>(() =>
    typeof window !== "undefined"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false
  );

  // Keep reducedMotion in sync with OS-level changes dynamically
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    function onChange(e: MediaQueryListEvent) { setReducedMotion(e.matches); }
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    function onMood(ev: Event) {
      const detail = (ev as CustomEvent<{ mood: string }>).detail;
      if (!detail?.mood) return;
      const target = MOOD_TARGETS[detail.mood as keyof typeof MOOD_TARGETS];
      if (!target) return;
      const [r, g, b] = hexToRgb(target.color);
      _threadRgb = `${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)}`;
    }
    window.addEventListener("loom-mood", onMood);
    return () => window.removeEventListener("loom-mood", onMood);
  }, []);

  useEffect(() => {
    // Listen for organ-focus events to brighten the corresponding thread
    function onOrganFocus(ev: Event) {
      const detail = (ev as CustomEvent<{ id: string }>).detail;
      if (!detail?.id) return;
      const state = threadStateRef.current.get(detail.id);
      if (state) {
        state.alpha = THREAD_ALPHA_FOCUS;
      } else {
        threadStateRef.current.set(detail.id, { id: detail.id, alpha: THREAD_ALPHA_FOCUS });
      }
    }
    window.addEventListener("organ-focus", onOrganFocus);
    return () => window.removeEventListener("organ-focus", onOrganFocus);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const dpr = window.devicePixelRatio || 1;

    function resize() {
      if (!canvas || !container) return;
      const rect = container.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
    }

    resize();
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(resize);
      ro.observe(container);
    } else {
      window.addEventListener("resize", resize, { passive: true });
    }

    const ctx = canvas.getContext("2d");

    // Persistent scratch objects — allocated once, reused every frame (zero per-frame alloc)
    const orbAnchor = { x: 0, y: 0 };
    const winAnchor = { x: 0, y: 0 };
    const cpOut: ThreadPathOut = { cp1x: 0, cp1y: 0, cp2x: 0, cp2y: 0 };

    /** Returns false if orb element not found; writes result into `orbAnchor`. */
    function getOrbAnchor(): boolean {
      if (!container) return false;
      const orbEl = document.querySelector('[data-testid="orb-hero"]');
      if (!orbEl) return false;
      const orbRect = orbEl.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      orbAnchor.x = (orbRect.left + orbRect.width / 2 - containerRect.left) * dpr;
      orbAnchor.y = (orbRect.top + orbRect.height / 2 - containerRect.top) * dpr;
      return true;
    }

    /** Writes window title bar anchor into `winAnchor`. */
    function getWindowTitleBarAnchor(rect: { x: number; y: number; w: number; h: number }): void {
      if (!container) {
        winAnchor.x = 0;
        winAnchor.y = 0;
        return;
      }
      const containerRect = container.getBoundingClientRect();
      // The rect from windowRegistry is in page/plane coordinates (absolute within plane),
      // but we need canvas coordinates relative to the container
      winAnchor.x = (rect.x + rect.w / 2 - containerRect.left) * dpr;
      winAnchor.y = (rect.y + 14 - containerRect.top) * dpr; // 14 = half title bar height
    }

    // Static render for reduced motion
    if (reducedMotion) {
      function drawStatic() {
        if (!canvas || !ctx) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (!getOrbAnchor()) return;
        const wins = windowRegistry.getAll();
        ctx.strokeStyle = `rgba(${_threadRgb},${THREAD_ALPHA_IDLE})`;
        ctx.lineWidth = 1 * dpr;
        for (const rect of wins.values()) {
          getWindowTitleBarAnchor(rect);
          ctx.beginPath();
          ctx.moveTo(orbAnchor.x, orbAnchor.y);
          ctx.lineTo(winAnchor.x, winAnchor.y);
          ctx.stroke();
        }
      }
      drawStatic();
      // Re-draw static lines when windows change (no animation needed)
      const intervalId = setInterval(drawStatic, 500);
      return () => {
        clearInterval(intervalId);
        if (ro) ro.disconnect(); else window.removeEventListener("resize", resize);
      };
    }

    // Animated render
    function drawTick(t: number, dt: number) {
      if (!canvas || !ctx || document.hidden) return;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      if (!getOrbAnchor()) return;

      const wins = windowRegistry.getAll();
      const threadStates = threadStateRef.current;

      // Remove stale thread states for windows that are gone
      for (const id of threadStates.keys()) {
        if (!wins.has(id)) {
          threadStates.delete(id);
        }
      }

      for (const [id, rect] of wins) {
        // Ensure thread state exists
        if (!threadStates.has(id)) {
          threadStates.set(id, { id, alpha: THREAD_ALPHA_IDLE });
        }
        const state = threadStates.get(id)!;

        // Decay alpha toward idle
        if (state.alpha > THREAD_ALPHA_IDLE) {
          state.alpha = Math.max(
            THREAD_ALPHA_IDLE,
            state.alpha - FOCUS_FADE_SPEED * dt
          );
        }

        getWindowTitleBarAnchor(rect);
        threadPath(orbAnchor.x, orbAnchor.y, winAnchor.x, winAnchor.y, t, cpOut);

        // Draw luminous thread with glow
        const idleAlpha = 0.10 + 0.08 * Math.sin(t * 0.5);
        const alpha = state.alpha > THREAD_ALPHA_IDLE ? state.alpha : idleAlpha;
        ctx.save();
        ctx.lineWidth = (state.alpha > THREAD_ALPHA_IDLE ? 2.5 : 1.5) * dpr;
        ctx.strokeStyle = `rgba(${_threadRgb},${alpha})`;
        ctx.shadowColor = `rgba(${_threadRgb},0.6)`;
        ctx.shadowBlur = 14 * dpr;
        ctx.beginPath();
        ctx.moveTo(orbAnchor.x, orbAnchor.y);
        ctx.bezierCurveTo(cpOut.cp1x, cpOut.cp1y, cpOut.cp2x, cpOut.cp2y, winAnchor.x, winAnchor.y);
        ctx.stroke();
        ctx.restore();
      }
    }

    const unsub = subscribe(drawTick);

    return () => {
      unsub();
      if (ro) ro.disconnect(); else window.removeEventListener("resize", resize);
    };
  }, [reducedMotion]);

  return (
    <div
      ref={containerRef}
      data-testid="threads-container"
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        zIndex: 99,
      }}
    >
      <canvas
        ref={canvasRef}
        data-testid="ambient-threads"
        aria-hidden
        style={{
          display: "block",
          width: "100%",
          height: "100%",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}
