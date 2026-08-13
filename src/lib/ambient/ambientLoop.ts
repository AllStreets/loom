/**
 * ambientLoop.ts
 * Single shared rAF loop with subscriber pattern.
 * All ambient animation subscribes here — one rAF, no per-subscriber loops.
 * When document.hidden the loop is fully stopped (no idle rAF spin).
 * It restarts automatically on visibilitychange→visible if subscribers exist.
 */

type TickFn = (t: number, dt: number) => void;

const subscribers = new Set<TickFn>();
let rafId: number | null = null;
let lastTime: number | null = null;

function tick(now: number) {
  const dt = lastTime !== null ? Math.min((now - lastTime) / 1000, 0.1) : 0;
  lastTime = now;

  const t = now / 1000;

  for (const fn of subscribers) {
    fn(t, dt);
  }

  rafId = requestAnimationFrame(tick);
}

function start() {
  if (rafId === null && subscribers.size > 0 && !document.hidden) {
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
    // Fully stop — no idle rAF spin while hidden
    stop();
  } else {
    // Restart if there are active subscribers
    start();
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
