/**
 * AgoraDeck.tsx — AGORA exchange dock iframe deck
 *
 * AGORA is a locally-run Next.js app (web :3000 + engine ws :8080 + Postgres).
 * This deck is a DOCK: probes the configured local URL on mount/activation and
 * on RETRY; renders an iframe when reachable, a designed offline card when not.
 *
 * URL: read from settings key "deck.agora.url" (default http://localhost:3000).
 * Probe: fetch(url, { mode: "no-cors", signal: AbortSignal.timeout(2000) }).
 *   Resolves (even opaque response) → reachable → show iframe.
 *   Rejects/timeout → unreachable → show offline card.
 * NO polling while offline. Probe only on mount, RETRY click, and deck re-activation.
 *
 * sandbox="allow-scripts allow-same-origin allow-forms" — AGORA is a full
 * Next.js app; forms and scripts are required.
 *
 * interact prop: controls iframe pointer events (same as GlobeDeck/EmberDeck).
 *
 * 400ms fade entrance + reduced-motion guard (same pattern as other decks).
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { useReducedMotion } from "framer-motion";
import { getSetting } from "../../lib/voice/settings";

interface AgoraDeckProps {
  interact: boolean;
}

type ProbeState = "probing" | "reachable" | "unreachable";

function getAgoraUrl(): string {
  try {
    const v = getSetting("deck.agora.url");
    return v || "http://localhost:3000";
  } catch {
    return "http://localhost:3000";
  }
}

export default function AgoraDeck({ interact }: AgoraDeckProps) {
  const reducedMotion = useReducedMotion() ?? false;
  const [opacity, setOpacity] = useState(reducedMotion ? 1 : 0);
  const [probeState, setProbeState] = useState<ProbeState>("probing");
  const agoraUrl = getAgoraUrl();
  const probeController = useRef<AbortController | null>(null);

  const probe = useCallback(async () => {
    // Cancel any in-flight probe
    probeController.current?.abort();
    setProbeState("probing");
    try {
      // no-cors: response will be opaque (type "opaque") but no error = reachable.
      await fetch(agoraUrl, {
        mode: "no-cors",
        signal: AbortSignal.timeout(2000),
      });
      setProbeState("reachable");
    } catch {
      setProbeState("unreachable");
    }
  }, [agoraUrl]);

  // Probe on mount (and re-probe when deck re-activates via key change)
  useEffect(() => {
    probe();
    return () => {
      probeController.current?.abort();
    };
  }, [probe]);

  // Fade entrance
  useEffect(() => {
    if (reducedMotion || probeState !== "reachable") return;
    const raf = requestAnimationFrame(() => setOpacity(1));
    return () => cancelAnimationFrame(raf);
  }, [reducedMotion, probeState]);

  // Reset opacity when we transition back to probing
  useEffect(() => {
    if (probeState === "probing" || probeState === "unreachable") {
      if (!reducedMotion) setOpacity(0);
    }
  }, [probeState, reducedMotion]);

  return (
    <div
      data-testid="agora-deck"
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
      }}
    >
      {probeState === "probing" && (
        <div
          data-testid="agora-probing"
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "center",
            paddingBottom: "26vh",
            pointerEvents: "none",
          }}
        >
          <span
            style={{
              fontFamily: "monospace",
              fontSize: 11,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: "var(--t3, rgba(255,255,255,0.35))",
            }}
          >
            PROBING...
          </span>
        </div>
      )}

      {probeState === "unreachable" && (
        <div
          data-testid="agora-offline-card"
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            // Seated in the lower half: the orb band occupies the upper-center
            // of the viewport and a dead-center card collides with the orb.
            alignItems: "flex-end",
            justifyContent: "center",
            paddingBottom: "22vh",
            pointerEvents: "auto",
          }}
        >
          <div
            style={{
              background: "var(--glass-raised, rgba(255,255,255,0.06))",
              border: "1px solid var(--glass-border, rgba(255,255,255,0.1))",
              boxShadow: "var(--shadow-2, 0 8px 32px rgba(0,0,0,0.4))",
              borderRadius: 10,
              padding: "20px 24px",
              maxWidth: 420,
              width: "100%",
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <div
              style={{
                fontFamily: "monospace",
                fontSize: 11,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                color: "var(--t2, rgba(255,255,255,0.6))",
              }}
            >
              THE EXCHANGE IS DARK
            </div>
            <div
              style={{
                fontFamily: "monospace",
                fontSize: 13,
                color: "var(--t1, rgba(255,255,255,0.85))",
                lineHeight: 1.5,
              }}
            >
              AGORA is not running. Start it:{" "}
              <span style={{ color: "var(--t3, rgba(255,255,255,0.35))" }}>
                cd ~/Downloads/AGORA &amp;&amp; npm run dev
              </span>{" "}
              — engine, web, and Postgres required.
            </div>
            <button
              data-testid="agora-retry-btn"
              onClick={probe}
              style={{
                alignSelf: "flex-start",
                background: "transparent",
                border: "1px solid rgba(255,255,255,0.18)",
                borderRadius: 6,
                color: "var(--t1, rgba(255,255,255,0.85))",
                fontFamily: "monospace",
                fontSize: 11,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                padding: "6px 12px",
                cursor: "pointer",
                transition: "background var(--dur-fast, 120ms) var(--ease-out, ease-out)",
                pointerEvents: "auto",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.08)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = "transparent";
              }}
              onMouseDown={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.12)";
              }}
              onMouseUp={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.08)";
              }}
            >
              RETRY
            </button>
          </div>
        </div>
      )}

      {probeState === "reachable" && (
        <iframe
          src={agoraUrl}
          sandbox="allow-scripts allow-same-origin allow-forms"
          title="AGORA Exchange"
          data-testid="agora-deck-iframe"
          style={{
            width: "100%",
            height: "100%",
            border: "none",
            display: "block",
            opacity: reducedMotion ? 1 : opacity,
            transition: reducedMotion ? "none" : "opacity 400ms ease",
            pointerEvents: interact ? "auto" : "none",
            transform: "translateZ(0)",
          }}
        />
      )}
    </div>
  );
}
