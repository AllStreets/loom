/**
 * GlobeDeck.tsx — AUSPEX globe iframe deck
 * Loads the bundled AUSPEX static app into an iframe.
 *
 * Origin isolation:
 *   DEV  (Vite): src="/decks/auspex/index.html" — shared-origin with LOOM shell.
 *        Shared localStorage is acceptable in dev only (documented debt).
 *   PROD (Tauri bundled): src="deck://localhost/index.html" — custom protocol,
 *        cross-origin with LOOM's tauri://localhost origin. localStorage is
 *        ISOLATED per the deck origin (closes reviewer I3 from Stage 1).
 *
 *   DECK_URL and DECK_ORIGIN are the single source of truth (src/lib/decks/config.ts).
 *   All postMessage calls use DECK_ORIGIN as targetOrigin — never a scattered string.
 *
 * sandbox="allow-scripts allow-same-origin" — allow-same-origin is required
 * so the globe's Supabase fetches and localStorage work within its OWN origin.
 * In prod, "same-origin" refers to deck://localhost, not to LOOM's origin.
 * Without it, localStorage reads throw SecurityError and all data feeds break.
 *
 * interact prop controls whether the iframe captures pointer events.
 * When interact=false the globe is purely visual; pointer events pass through
 * to the LOOM shell above it (orb-band, top bar, companion panel).
 *
 * Mount-safe command queue (C1 fix):
 *   When Companion fires a deck_command with both deckSwitch and bridgeCmds,
 *   GlobeDeck may not yet be mounted (and its loom-deck-command listener not
 *   registered) at the moment the event fires.  The exported `sendDeckCommands`
 *   function solves this: if GlobeDeck is already mounted it dispatches
 *   immediately; otherwise it enqueues for flush on mount.  Additionally,
 *   even after React mounts the component the iframe itself needs to load
 *   before postMessage is useful, so onDeckCommand enqueues when !iframeLoaded
 *   and onIframeLoad flushes the queue — ensuring no double-send on any path.
 */
import { forwardRef, useImperativeHandle, useRef, useState, useEffect } from "react";
import { useReducedMotion } from "framer-motion";
import type { BridgeCmd } from "../../lib/decks/commands";
import { DECK_URL, DECK_ORIGIN } from "../../lib/decks/config";

interface GlobeDeckProps {
  interact: boolean;
}

export interface GlobeDeckHandle {
  postCommand: (cmd: object) => void;
}

// ── Module-level pending command queue (C1 fix) ──────────────────────────────

/**
 * Pending bridge commands enqueued before GlobeDeck mounts or before the
 * iframe has fired its `load` event.
 */
const pendingCmds: BridgeCmd[][] = [];

/** True while a GlobeDeck instance is mounted and its listener registered. */
let globeListenerActive = false;

/**
 * True once the mounted iframe has fired its `load` event (or was already
 * complete on mount).  Reset to false on effect cleanup so the next mount
 * starts fresh.
 */
let iframeLoaded = false;

/**
 * Reset all module-level deck-queue state.
 * Called in test beforeEach to guarantee isolation between test runs.
 */
export function _resetDeckQueueForTests(): void {
  pendingCmds.length = 0;
  globeListenerActive = false;
  iframeLoaded = false;
}

/**
 * Send bridge commands to GlobeDeck.
 *
 * Always dispatches the loom-deck-command event (preserves ordering guarantees
 * and test observability). When GlobeDeck is not yet mounted (listener not
 * registered), the event fires but no one catches it — so the commands are
 * ALSO enqueued in pendingCmds.  GlobeDeck drains the queue on mount after
 * the iframe fires its load event, ensuring no commands are silently dropped.
 *
 * Called by Companion instead of dispatching loom-deck-command directly.
 */
export function sendDeckCommands(cmds: BridgeCmd[]): void {
  if (cmds.length === 0) return;
  // Always fire the event so ordering tests and any active listener work.
  window.dispatchEvent(
    new CustomEvent("loom-deck-command", { detail: { bridgeCmds: cmds } })
  );
  // If no GlobeDeck listener is active, queue for drain on mount.
  if (!globeListenerActive) {
    pendingCmds.push(cmds);
  }
}

// ── postDeckCommand util (unchanged public API) ───────────────────────────────

export function postDeckCommand(
  iframeRef: React.RefObject<HTMLIFrameElement | null>,
  cmd: object
) {
  iframeRef.current?.contentWindow?.postMessage({ loomDeck: true, cmd }, DECK_ORIGIN);
}

// ── Component ─────────────────────────────────────────────────────────────────

const GlobeDeck = forwardRef<GlobeDeckHandle, GlobeDeckProps>(
  function GlobeDeck({ interact }, ref) {
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const reducedMotion = useReducedMotion() ?? false;
    // Mount at opacity 0; flip to 1 via rAF so the 400ms CSS transition fires.
    // Reduced-motion: skip the transition entirely (opacity 1, transition none).
    const [opacity, setOpacity] = useState(reducedMotion ? 1 : 0);

    useEffect(() => {
      if (reducedMotion) return;
      const raf = requestAnimationFrame(() => setOpacity(1));
      return () => cancelAnimationFrame(raf);
    }, [reducedMotion]);

    useImperativeHandle(ref, () => ({
      postCommand(cmd: object) {
        postDeckCommand(iframeRef, cmd);
      },
    }));

    // Listen for loom-deck-command events dispatched by Companion (or sendDeckCommands).
    // Each event carries { bridgeCmds: BridgeCmd[] }; forward them to the AUSPEX iframe.
    useEffect(() => {
      /**
       * Drain the pending queue now that the iframe is ready.
       * Only called after iframeLoaded is set to true.
       */
      function flushPending() {
        if (pendingCmds.length === 0) return;
        const batches = pendingCmds.splice(0);
        for (const batch of batches) {
          for (const cmd of batch) {
            postDeckCommand(iframeRef, cmd);
          }
        }
      }

      function onDeckCommand(ev: Event) {
        const detail = (ev as CustomEvent<{ bridgeCmds: BridgeCmd[] }>).detail;
        if (!detail?.bridgeCmds) return;
        if (!iframeLoaded) {
          // Iframe not yet ready — enqueue; onIframeLoad will flush.
          // Do NOT post here to avoid a double-send with the flush path.
          pendingCmds.push(detail.bridgeCmds);
          return;
        }
        for (const cmd of detail.bridgeCmds) {
          postDeckCommand(iframeRef, cmd);
        }
      }

      function onIframeLoad() {
        iframeLoaded = true;
        flushPending();
      }

      globeListenerActive = true;
      window.addEventListener("loom-deck-command", onDeckCommand);

      const iframe = iframeRef.current;
      if (iframe) {
        // Try to check contentDocument.readyState for same-origin iframes.
        // Cross-origin access throws SecurityError; fall through to load listener.
        try {
          if (iframe.contentDocument?.readyState === "complete") {
            iframeLoaded = true;
            flushPending();
          } else {
            iframe.addEventListener("load", onIframeLoad);
          }
        } catch {
          // SecurityError on cross-origin access — fall through to load listener.
          iframe.addEventListener("load", onIframeLoad);
        }
      }

      return () => {
        globeListenerActive = false;
        iframeLoaded = false;
        window.removeEventListener("loom-deck-command", onDeckCommand);
        if (iframe) iframe.removeEventListener("load", onIframeLoad);
      };
    }, []);

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
          src={DECK_URL}
          sandbox="allow-scripts allow-same-origin"
          title="AUSPEX Globe"
          data-testid="globe-deck-iframe"
          style={{
            width: "100%",
            height: "100%",
            border: "none",
            display: "block",
            opacity,
            transition: reducedMotion ? "none" : "opacity 400ms ease",
            pointerEvents: interact ? "auto" : "none",
            // Own compositing layer: isolates the deck's WebGL/DOM repaints from
            // LOOM's per-frame layers (orb blend, ambient) — prevents whole-iframe
            // flicker (banner/earth/moon) from cross-layer invalidation.
            transform: "translateZ(0)",
          }}
        />
      </div>
    );
  }
);

export default GlobeDeck;
