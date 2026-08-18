/**
 * EmberDeck.tsx — EMBER offline survival console iframe deck
 *
 * Loads the bundled EMBER static app into an iframe. No command bridge
 * and no queue: voice only switches to this deck (YAGNI — EMBER has no
 * LOOM adapter and needs none v1).
 *
 * Origin isolation: same as GlobeDeck (dev = shared-origin Vite path;
 * prod = deck://localhost/ember/index.html, cross-origin).
 *
 * sandbox="allow-scripts allow-same-origin":
 *   allow-same-origin is required so EMBER's Ollama fetch (localhost:11434)
 *   and localStorage both work within its own origin. Without it,
 *   localStorage reads throw SecurityError and all EMBER data persistence
 *   breaks. In prod this refers to deck://localhost, not LOOM's origin.
 *
 * interact prop: when false the iframe is purely visual; pointer events
 * pass through to the LOOM shell (orb-band, top bar, companion).
 *
 * 400ms fade entrance + reduced-motion guard (same as GlobeDeck).
 *
 * EMBER's Advisor and Forge call Ollama localhost:11434. Under deck://
 * origin Ollama's default CORS policy may reject; EMBER degrades
 * gracefully (chip shows "offline"). FOLLOWUP: OLLAMA_ORIGINS=deck://localhost
 * enables the Advisor in packaged builds. Forge (File System Access API)
 * may be unavailable in an iframe sandbox; EMBER hides/degrades per its
 * own design — no hard crash observed.
 */
import { useState, useEffect } from "react";
import { useReducedMotion } from "framer-motion";
import { buildDeckConfig } from "../../lib/decks/config";

const EMBER_URL = buildDeckConfig(import.meta.env.DEV, "ember").url;

interface EmberDeckProps {
  interact: boolean;
}

export default function EmberDeck({ interact }: EmberDeckProps) {
  const reducedMotion = useReducedMotion() ?? false;
  const [opacity, setOpacity] = useState(reducedMotion ? 1 : 0);

  useEffect(() => {
    if (reducedMotion) return;
    const raf = requestAnimationFrame(() => setOpacity(1));
    return () => cancelAnimationFrame(raf);
  }, [reducedMotion]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
      }}
    >
      <iframe
        src={EMBER_URL}
        sandbox="allow-scripts allow-same-origin"
        title="EMBER Survival Console"
        data-testid="ember-deck-iframe"
        style={{
          width: "100%",
          height: "100%",
          border: "none",
          display: "block",
          opacity,
          transition: reducedMotion ? "none" : "opacity 400ms ease",
          pointerEvents: interact ? "auto" : "none",
          transform: "translateZ(0)",
        }}
      />
    </div>
  );
}
