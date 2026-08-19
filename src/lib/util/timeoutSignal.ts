/**
 * timeoutSignal.ts — cross-runtime AbortSignal timeout helper.
 *
 * Usage: `fetch(url, { signal: timeoutSignal(10_000) })`
 *
 * Strategy:
 *   - When `AbortSignal.timeout` is available (modern browsers, Node ≥ 17.3,
 *     Tauri webview) it delegates directly — zero overhead.
 *   - Otherwise falls back to AbortController + setTimeout. The timer is
 *     fire-and-forget: if the signal is never consumed the timer still fires
 *     after `ms` ms but the abort is a no-op (nothing is listening). This is
 *     intentional; keeping it simple avoids the complexity of cleanup
 *     registration on an already-consumed signal.
 */

export function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  // Fallback: AbortController + setTimeout (fire-and-forget — see module doc).
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(new DOMException("TimeoutError", "TimeoutError")), ms);
  return ctrl.signal;
}
