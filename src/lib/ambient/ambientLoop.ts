/**
 * ambientLoop.ts
 * Single shared rAF loop with subscriber pattern.
 * All ambient animation subscribes here — one rAF, no per-subscriber loops.
 */

type TickFn = (t: number, dt: number) => void;

const subscribers = new Set<TickFn>();
let rafId: number | null = null;
let lastTime: number | null = null;
let paused = false;

function tick(now: number) {
  if (paused || document.hidden) {
    lastTime = null;
    rafId = requestAnimationFrame(tick);
    return;
  }

  const dt = lastTime !== null ? Math.min((now - lastTime) / 1000, 0.1) : 0;
  lastTime = now;

  const t = now / 1000;

  for (const fn of subscribers) {
    fn(t, dt);
  }

  rafId = requestAnimationFrame(tick);
}

function start() {
  if (rafId === null && subscribers.size > 0) {
    lastTime = null;
    rafId = requestAnimationFrame(tick);
  }
}

function stop() {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
    lastTime = null;
  }
}

function onVisibilityChange() {
  if (document.hidden) {
    paused = true;
  } else {
    paused = false;
    lastTime = null;
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", onVisibilityChange, { passive: true });
}

export function subscribe(fn: TickFn): () => void {
  subscribers.add(fn);
  start();

  return function unsubscribe() {
    subscribers.delete(fn);
    if (subscribers.size === 0) {
      stop();
    }
  };
}
