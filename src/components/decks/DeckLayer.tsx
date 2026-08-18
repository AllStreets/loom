/**
 * DeckLayer.tsx — sovereign cockpit deck layer
 * Renders the active deck between Field (z1) and orb-band (z10).
 * This layer itself never captures pointer events — only the active
 * deck iframe may do so (when interact=true).
 *
 * Listens for the loom-deck CustomEvent {detail: {deck: "void"|"globe"}}
 * dispatched by deck control buttons in Shell's top bar.
 *
 * "void" → renders nothing (current LOOM look is preserved).
 * "globe" → renders GlobeDeck iframe (AUSPEX globe behind the orb).
 */
import { useEffect } from "react";
import GlobeDeck from "./GlobeDeck";
import { setSetting } from "../../lib/voice/settings";

export type DeckId = "void" | "globe";

interface DeckLayerProps {
  deck: DeckId;
  interactMode: boolean;
  onInteractToggle: () => void;
}

export default function DeckLayer({ deck, interactMode, onInteractToggle: _ }: DeckLayerProps) {
  // Listen for loom-deck events (dispatched by Shell's top-bar buttons).
  // We only persist here; Shell's own listener handles setDeck.
  useEffect(() => {
    function onDeckEvent(e: Event) {
      const detail = (e as CustomEvent<{ deck: DeckId }>).detail;
      if (!detail?.deck) return;
      setSetting("cockpit.deck", detail.deck);
    }
    window.addEventListener("loom-deck", onDeckEvent);
    return () => window.removeEventListener("loom-deck", onDeckEvent);
  }, []);

  return (
    <div
      data-testid="deck-layer"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 2,
        pointerEvents: "none",
      }}
    >
      {deck === "globe" && <GlobeDeck interact={interactMode} />}
    </div>
  );
}
