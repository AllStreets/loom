/**
 * AgoraDeck.tsx — AGORA exchange dock iframe deck
 *
 * AGORA is a locally-run Next.js app (web :3000 + engine ws :8080 + Postgres).
 * This deck is a DOCK: probes the configured local URL on mount/activation and
 * on RETRY; renders an iframe when reachable, a designed offline card when not.
 *
 * URL: read from settings key "deck.agora.url" (default http://localhost:3000).
 * Path: read from settings key "deck.agora.path" (default empty → Rust uses ~/Downloads/AGORA).
 *
 * Probe: fetch(url, { mode: "no-cors", signal: AbortSignal.timeout(2000) }).
 *   Resolves (even opaque response) → reachable → show iframe.
 *   Rejects/timeout → unreachable → show offline card.
 *
 * START button: calls agora_start(path) → "igniting" overlay with log polling.
 *   Auto-probes every 2s, up to 45s (22 attempts). If reachable → show iframe.
 *   After 45s → "still dark" card with RETRY + STOP.
 *   If agora_start REJECTS (bad path, no package.json, ...) nothing spawned —
 *   skip the probe loop entirely and surface the reason on the offline card.
 * STOP chip: calls agora_stop() → re-probes.
 *
 * sandbox="allow-scripts allow-same-origin allow-forms"
 * interact prop: controls iframe pointer events.
 * 400ms fade entrance + reduced-motion guard.
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { useReducedMotion } from "framer-motion";
import { getSetting } from "../../lib/voice/settings";
import { timeoutSignal } from "../../lib/util/timeoutSignal";
import { agoraStart, agoraStop, agoraLogs } from "../../lib/core";

interface AgoraDeckProps {
  interact: boolean;
}

type ProbeState = "probing" | "reachable" | "unreachable";
type LaunchState = "idle" | "igniting" | "still-dark" | "spawn-failed";

function getAgoraUrl(): string {
  try {
    const v = getSetting("deck.agora.url");
    return v || "http://localhost:3000";
  } catch {
    return "http://localhost:3000";
  }
}

function getAgoraPath(): string {
  try {
    return getSetting("deck.agora.path") || "";
  } catch {
    return "";
  }
}

/**
 * Extract a human-readable reason from a rejected agora_start invoke.
 * Rust rejections arrive as { kind, message }; Error covers shell-side throws.
 */
function startErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

export default function AgoraDeck({ interact }: AgoraDeckProps) {
  const reducedMotion = useReducedMotion() ?? false;
  const [opacity, setOpacity] = useState(reducedMotion ? 1 : 0);
  const [probeState, setProbeState] = useState<ProbeState>("probing");
  const [launchState, setLaunchState] = useState<LaunchState>("idle");
  const [startError, setStartError] = useState<string | null>(null);
  const [engineHealth, setEngineHealth] = useState<"probing" | "healthy" | "down">("probing");
  const [logs, setLogs] = useState<string[]>([]);
  const agoraUrl = getAgoraUrl();

  // Monotonic probe id: a settled probe only writes state if it is still the
  // LATEST probe AND the component is mounted.
  const probeSeq = useRef(0);
  const mountedRef = useRef(true);
  const ignitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ignitionIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const logIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const probe = useCallback(async () => {
    const seq = ++probeSeq.current;
    setProbeState("probing");
    try {
      await fetch(agoraUrl, {
        mode: "no-cors",
        signal: timeoutSignal(2000),
      });
      if (mountedRef.current && seq === probeSeq.current) setProbeState("reachable");
    } catch {
      if (mountedRef.current && seq === probeSeq.current) setProbeState("unreachable");
    }
  }, [agoraUrl]);

  const probeEngine = useCallback(async () => {
    try {
      const res = await fetch("http://localhost:8080/health", { signal: timeoutSignal(2000) });
      const json = await res.json();
      if (mountedRef.current) setEngineHealth(json.ok === true ? "healthy" : "down");
    } catch {
      if (mountedRef.current) setEngineHealth("down");
    }
  }, []);

  // Clear ignition timers helper
  const clearIgnitionTimers = useCallback(() => {
    if (ignitionTimerRef.current) {
      clearTimeout(ignitionTimerRef.current);
      ignitionTimerRef.current = null;
    }
    if (ignitionIntervalRef.current) {
      clearInterval(ignitionIntervalRef.current);
      ignitionIntervalRef.current = null;
    }
    if (logIntervalRef.current) {
      clearInterval(logIntervalRef.current);
      logIntervalRef.current = null;
    }
  }, []);

  // Probe on mount (and re-probe when deck re-activates via key change)
  useEffect(() => {
    mountedRef.current = true;
    probe();
    return () => {
      mountedRef.current = false;
      clearIgnitionTimers();
    };
  }, [probe, clearIgnitionTimers]);

  // Engine health interval — only while reachable
  useEffect(() => {
    if (probeState !== "reachable") return;
    probeEngine();
    const id = setInterval(probeEngine, 60_000);
    return () => clearInterval(id);
  }, [probeState, probeEngine]);

  // Reset engine health when leaving reachable
  useEffect(() => {
    if (probeState !== "reachable") setEngineHealth("probing");
  }, [probeState]);

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

  // When igniting becomes reachable, clear ignition state
  useEffect(() => {
    if (probeState === "reachable" && launchState === "igniting") {
      clearIgnitionTimers();
      setLaunchState("idle");
    }
  }, [probeState, launchState, clearIgnitionTimers]);

  const handleStart = useCallback(async () => {
    setLaunchState("igniting");
    setStartError(null);
    setLogs([]);

    const path = getAgoraPath();

    try {
      await agoraStart(path);
    } catch (err) {
      // A rejected agora_start means nothing spawned — skip the probe loop
      // entirely and surface the reason instead of 45s of false hope.
      if (mountedRef.current) {
        setStartError(startErrorMessage(err));
        setLaunchState("spawn-failed");
        setProbeState("unreachable");
      }
      return;
    }

    // Poll logs every 2s
    logIntervalRef.current = setInterval(async () => {
      try {
        const lines = await agoraLogs();
        if (mountedRef.current) setLogs(lines);
      } catch {
        // Ignore log fetch errors
      }
    }, 2000);

    // Auto-probe every 2s while igniting
    ignitionIntervalRef.current = setInterval(async () => {
      const seq = ++probeSeq.current;
      try {
        await fetch(agoraUrl, {
          mode: "no-cors",
          signal: timeoutSignal(2000),
        });
        if (mountedRef.current && seq === probeSeq.current) {
          clearIgnitionTimers();
          setProbeState("reachable");
          setLaunchState("idle");
        }
      } catch {
        // Not reachable yet — keep igniting
      }
    }, 2000);

    // 45s timeout → still dark
    ignitionTimerRef.current = setTimeout(() => {
      if (mountedRef.current) {
        clearIgnitionTimers();
        setLaunchState("still-dark");
        setProbeState("unreachable");
      }
    }, 45_000);
  }, [agoraUrl, clearIgnitionTimers]);

  const handleStop = useCallback(async () => {
    clearIgnitionTimers();
    setLaunchState("idle");
    try {
      await agoraStop();
    } catch {
      // Ignore stop errors
    }
    // Re-probe — will land at unreachable
    probe();
  }, [probe, clearIgnitionTimers]);

  const handleRetry = useCallback(() => {
    setLaunchState("idle");
    setStartError(null);
    probe();
  }, [probe]);

  // ── Render helpers ──────────────────────────────────────────────────────────

  const lastThreeLogs = logs.slice(-3);

  return (
    <div
      data-testid="agora-deck"
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
      }}
    >
      {probeState === "probing" && launchState === "idle" && (
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
              fontFamily: "var(--f-mono, monospace)",
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

      {launchState === "igniting" && (
        <div
          data-testid="agora-igniting"
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
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
              maxWidth: 480,
              width: "100%",
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <div
              style={{
                fontFamily: "var(--f-mono, monospace)",
                fontSize: 11,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                color: "var(--t2, rgba(255,255,255,0.6))",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <span
                style={{
                  display: "inline-block",
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "rgba(255,255,255,0.4)",
                  animation: "pulse 1s ease-in-out infinite",
                }}
              />
              IGNITING THE EXCHANGE
            </div>
            {lastThreeLogs.length > 0 && (
              <div
                style={{
                  fontFamily: "var(--f-mono, monospace)",
                  fontSize: 10,
                  color: "rgba(255,255,255,0.35)",
                  lineHeight: 1.6,
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                  wordBreak: "break-all",
                }}
              >
                {lastThreeLogs.map((line, i) => (
                  <div key={i}>{line}</div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {probeState === "unreachable" && launchState !== "igniting" && (
        <div
          data-testid="agora-offline-card"
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
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
                fontFamily: "var(--f-mono, monospace)",
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
                fontFamily: "var(--f-mono, monospace)",
                fontSize: 13,
                color: "var(--t1, rgba(255,255,255,0.85))",
                lineHeight: 1.5,
              }}
            >
              AGORA is not running.
            </div>
            <div
              style={{
                fontFamily: "var(--f-mono, monospace)",
                fontSize: 11,
                color: "var(--t3, rgba(255,255,255,0.35))",
                lineHeight: 1.5,
              }}
            >
              Postgres must be running (Postgres.app).
            </div>
            {launchState === "still-dark" && (
              <div
                style={{
                  fontFamily: "var(--f-mono, monospace)",
                  fontSize: 11,
                  color: "var(--danger, #ef4444)",
                  letterSpacing: "0.08em",
                }}
              >
                STILL DARK — exchange did not come up in 45s.
              </div>
            )}
            {launchState === "spawn-failed" && startError && (
              <div
                data-testid="agora-spawn-error"
                style={{
                  fontFamily: "var(--f-mono, monospace)",
                  fontSize: 11,
                  color: "var(--danger, #ef4444)",
                  letterSpacing: "0.08em",
                  lineHeight: 1.5,
                  wordBreak: "break-word",
                }}
              >
                COULD NOT IGNITE — {startError}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                data-testid="agora-start-btn"
                onClick={handleStart}
                style={{
                  background: "rgba(255,255,255,0.08)",
                  border: "1px solid rgba(255,255,255,0.25)",
                  borderRadius: 6,
                  color: "var(--t1, rgba(255,255,255,0.85))",
                  fontFamily: "var(--f-mono, monospace)",
                  fontSize: 11,
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  padding: "6px 12px",
                  cursor: "pointer",
                  transition: "background var(--dur-fast, 120ms) var(--ease-out, ease-out)",
                  pointerEvents: "auto",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.14)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.08)";
                }}
              >
                START
              </button>
              <button
                data-testid="agora-retry-btn"
                onClick={handleRetry}
                style={{
                  alignSelf: "flex-start",
                  background: "transparent",
                  border: "1px solid rgba(255,255,255,0.18)",
                  borderRadius: 6,
                  color: "var(--t1, rgba(255,255,255,0.85))",
                  fontFamily: "var(--f-mono, monospace)",
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
              {launchState === "still-dark" && (
                <button
                  data-testid="agora-stop-btn-still-dark"
                  onClick={handleStop}
                  style={{
                    alignSelf: "flex-start",
                    background: "transparent",
                    border: "1px solid rgba(239,68,68,0.4)",
                    borderRadius: 6,
                    color: "var(--danger, #ef4444)",
                    fontFamily: "var(--f-mono, monospace)",
                    fontSize: 11,
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                    padding: "6px 12px",
                    cursor: "pointer",
                    transition: "background var(--dur-fast, 120ms) var(--ease-out, ease-out)",
                    pointerEvents: "auto",
                  }}
                >
                  STOP
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {probeState === "reachable" && (
        <>
          <div
            data-testid="agora-health-strip"
            style={{
              position: "absolute",
              top: 8,
              right: 12,
              zIndex: 2,
              display: "flex",
              gap: 4,
              alignItems: "center",
              pointerEvents: "auto",
            }}
          >
            {/* WEB chip */}
            <div
              data-testid="agora-health-web"
              style={{
                background: "var(--glass, rgba(255,255,255,0.05))",
                border: "1px solid var(--glass-border, rgba(255,255,255,0.1))",
                borderRadius: 999,
                padding: "2px 8px 2px 6px",
                display: "flex",
                alignItems: "center",
                gap: 4,
                backdropFilter: "blur(8px)",
                WebkitBackdropFilter: "blur(8px)",
                pointerEvents: "none",
              }}
            >
              <div style={{ width: 6, height: 6, borderRadius: 999, background: "#4ade80", flexShrink: 0 }} />
              <span style={{ fontFamily: "var(--f-mono, monospace)", fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--t2, rgba(255,255,255,0.6))" }}>WEB</span>
            </div>
            {/* ENGINE chip */}
            <div
              data-testid="agora-health-engine"
              style={{
                background: "var(--glass, rgba(255,255,255,0.05))",
                border: "1px solid var(--glass-border, rgba(255,255,255,0.1))",
                borderRadius: 999,
                padding: "2px 8px 2px 6px",
                display: "flex",
                alignItems: "center",
                gap: 4,
                backdropFilter: "blur(8px)",
                WebkitBackdropFilter: "blur(8px)",
                pointerEvents: "none",
              }}
            >
              <div
                data-health={engineHealth}
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 999,
                  background:
                    engineHealth === "healthy"
                      ? "#4ade80"
                      : engineHealth === "down"
                      ? "var(--danger, #ef4444)"
                      : "rgba(255,255,255,0.2)",
                  flexShrink: 0,
                }}
              />
              <span style={{ fontFamily: "var(--f-mono, monospace)", fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--t2, rgba(255,255,255,0.6))" }}>ENGINE</span>
            </div>
            {/* STOP chip */}
            <button
              data-testid="agora-stop-btn"
              onClick={handleStop}
              title="Stop AGORA"
              style={{
                background: "var(--glass, rgba(255,255,255,0.05))",
                border: "1px solid var(--glass-border, rgba(255,255,255,0.1))",
                borderRadius: 999,
                padding: "2px 10px",
                display: "flex",
                alignItems: "center",
                gap: 4,
                backdropFilter: "blur(8px)",
                WebkitBackdropFilter: "blur(8px)",
                cursor: "pointer",
                fontFamily: "var(--f-mono, monospace)",
                fontSize: 9,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: "var(--t2, rgba(255,255,255,0.6))",
                transition: "background var(--dur-fast, 120ms) var(--ease-out, ease-out)",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.1)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = "var(--glass, rgba(255,255,255,0.05))";
              }}
            >
              STOP
            </button>
          </div>
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
        </>
      )}
    </div>
  );
}
