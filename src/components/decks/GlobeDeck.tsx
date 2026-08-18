/**
 * GlobeDeck.tsx — AUSPEX globe iframe deck
 * Loads the bundled AUSPEX static app from /decks/auspex/index.html.
 * sandbox="allow-scripts allow-same-origin" — allow-same-origin is required
 * so the globe's Supabase fetches and localStorage (bridge poller opt-in) work.
 * Without it, localStorage reads throw SecurityError and all data feeds break.
 *
 * interact prop controls whether the iframe captures pointer events.
 * When interact=false the globe is purely visual; pointer events pass through
 * to the LOOM shell above it (orb-band, top bar, companion panel).
 */
import { forwardRef, useImperativeHandle, useRef } from "react";
import { useReducedMotion } from "framer-motion";

interface GlobeDeckProps {
  interact: boolean;
}

export interface GlobeDeckHandle {
  postCommand: (cmd: object) => void;
}

export function postDeckCommand(
  iframeRef: React.RefObject<HTMLIFrameElement | null>,
  cmd: object
) {
  iframeRef.current?.contentWindow?.postMessage({ loomDeck: true, cmd }, "*");
}

const GlobeDeck = forwardRef<GlobeDeckHandle, GlobeDeckProps>(
  function GlobeDeck({ interact }, ref) {
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const reducedMotion = useReducedMotion() ?? false;

    useImperativeHandle(ref, () => ({
      postCommand(cmd: object) {
        postDeckCommand(iframeRef, cmd);
      },
    }));

    return (
      <div
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
        }}
      >
        <iframe
          ref={iframeRef}
          src="/decks/auspex/index.html"
          sandbox="allow-scripts allow-same-origin"
          title="AUSPEX Globe"
          style={{
            width: "100%",
            height: "100%",
            border: "none",
            display: "block",
            opacity: 1,
            transition: reducedMotion ? "none" : "opacity 400ms ease",
            pointerEvents: interact ? "auto" : "none",
          }}
        />
      </div>
    );
  }
);

export default GlobeDeck;
