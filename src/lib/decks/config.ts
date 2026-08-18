/**
 * src/lib/decks/config.ts — Deck origin + URL single source of truth.
 *
 * Computes DECK_URL and DECK_ORIGIN once per environment:
 *
 *   DEV  (import.meta.env.DEV === true, Vite dev server):
 *     DECK_URL    = "/decks/auspex/index.html"   (same-origin, served by Vite)
 *     DECK_ORIGIN = window.location.origin        (e.g. http://localhost:1420)
 *     Consequence: iframe shares LOOM's localStorage — acceptable in dev only
 *                  (documented reviewer debt I3 from Stage 1).
 *
 *   PROD (import.meta.env.DEV === false, Tauri bundled app):
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

export const DECK_URL: string = import.meta.env.DEV
  ? "/decks/auspex/index.html"
  : "deck://localhost/index.html";

/**
 * The origin that the AUSPEX deck iframe runs on.
 * Used as postMessage targetOrigin — must match the iframe's actual origin.
 *
 * In dev: window.location.origin (shared with LOOM shell — dev-only acceptable).
 * In prod: "deck://localhost" (isolated custom-protocol origin — macOS/Linux).
 */
export const DECK_ORIGIN: string = import.meta.env.DEV
  ? (typeof window !== "undefined" ? window.location.origin : "http://localhost:1420")
  : "deck://localhost";
