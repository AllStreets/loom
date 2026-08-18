/**
 * src/lib/decks/config.ts — Deck origin + URL single source of truth.
 *
 * Computes DECK_URL and DECK_ORIGIN once per environment:
 *
 *   DEV  (isDev === true, Vite dev server):
 *     DECK_URL    = "/decks/auspex/index.html"   (same-origin, served by Vite)
 *     DECK_ORIGIN = window.location.origin        (e.g. http://localhost:1420)
 *     Consequence: iframe shares LOOM's localStorage — acceptable in dev only
 *                  (documented reviewer debt I3 from Stage 1).
 *
 *   PROD (isDev === false, Tauri bundled app):
 *     DECK_URL    = "deck://localhost/index.html"
 *     DECK_ORIGIN = "deck://localhost"
 *     Consequence: iframe is cross-origin → localStorage ISOLATED from LOOM's
 *                  (closes reviewer I3 — no shared localStorage in production).
 *
 * Origin strings are platform-specific per Tauri v2 docs
 * (see ~/.cargo/registry/.../tauri-2.x/src/app.rs:2126):
 *   macOS / iOS / Linux : <scheme>://localhost/...  → origin "deck://localhost"
 *   Windows / Android   : http://<scheme>.localhost/... (we target macOS; documented)
 *
 * Both DECK_URL and DECK_ORIGIN are imported by GlobeDeck.tsx; no other module
 * should embed origin strings for the deck iframe.
 */

/**
 * Build deck configuration for the given environment.
 * Pure factory function — no module-level env reading.
 *
 * @param isDev  true for dev (Vite), false for prod (Tauri bundled)
 * @returns { url, origin } — deck iframe URL and postMessage origin
 */
export function buildDeckConfig(isDev: boolean) {
  return {
    url: isDev ? "/decks/auspex/index.html" : "deck://localhost/index.html",
    origin: isDev
      ? (typeof window !== "undefined" ? window.location.origin : "http://localhost:1420")
      : "deck://localhost",
  };
}

// Module-level constants derived from import.meta.env.DEV
const _config = buildDeckConfig(import.meta.env.DEV);
export const DECK_URL: string = _config.url;
export const DECK_ORIGIN: string = _config.origin;
