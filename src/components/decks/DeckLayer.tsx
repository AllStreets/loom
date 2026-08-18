/**
 * DeckLayer.tsx — sovereign cockpit deck layer (purely presentational)
 * Renders the active deck between Field (z1) and orb-band (z10).
 * This layer itself never captures pointer events — only the active
 * deck iframe may do so (when interact=true).
 *
 * Deck prop is owned by Shell (Shell reads/writes cockpit.deck setting).
 * DeckLayer is purely presentational — no event listeners, no persistence.
 *
 * "void" → renders nothing (current LOOM look is preserved).
 * "globe" → renders GlobeDeck iframe (AUSPEX globe behind the orb).
 */
import GlobeDeck from "./GlobeDeck";

export type DeckId = "void" | "globe";

interface DeckLayerProps {
  deck: DeckId;
  interactMode: boolean;

}

export default function DeckLayer({ deck, interactMode }: DeckLayerProps) {
  return (
    <div
      data-testid="deck-layer"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2,
        pointerEvents: "none",
      }}
    >
      {deck === "globe" && <GlobeDeck interact={interactMode} />}
    </div>
  );
}
