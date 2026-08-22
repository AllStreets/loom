/**
 * usePoll.ts — the deck poll-lifecycle hook (shared by Terminal + AGORA floor).
 *
 * Run `tick` immediately and every `ms` while mounted AND visible — the exact
 * startQuotes/stopQuotes discipline as a hook. The interval is cleared on
 * unmount and while document.hidden; each run gets an AbortSignal that fires
 * on pause/unmount so no request outlives the deck.
 *
 * Restart semantics: the effect re-runs when `tick` or `ms` change identity —
 * callers switching targets (e.g. the floor's product chips) get a clean
 * stop-then-start with a fresh AbortController, no overlap, no leaks.
 */
import { useEffect } from "react";

export function usePoll(tick: (signal: AbortSignal) => void | Promise<void>, ms: number) {
  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null;
    let ctrl: AbortController | null = null;
    const run = () => {
      ctrl = new AbortController();
      void tick(ctrl.signal);
    };
    const start = () => {
      if (id !== null) return;
      run();
      id = setInterval(run, ms);
    };
    const stop = () => {
      if (id !== null) {
        clearInterval(id);
        id = null;
      }
      ctrl?.abort();
      ctrl = null;
    };
    const onVis = () => {
      if (document.hidden) stop();
      else start();
    };
    document.addEventListener("visibilitychange", onVis, { passive: true });
    if (!document.hidden) start();
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      stop();
    };
  }, [tick, ms]);
}
