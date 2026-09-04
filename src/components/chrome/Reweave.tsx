/**
 * Reweave.tsx — the reweave card: five stations, an honest countdown.
 *
 * The surface for walls 4→5: LOOM turning its edited genome into a new body.
 * It listens to the protected `reweave.ts` feed (the persisted state first,
 * then every `loom-reweave` event) and paints:
 *
 *   ASSETS · CORE · STAGE · SWAP · RELAUNCH   — the rail. The active station
 *     is luminous (--accent), completed stations are dimmed (--t2), pending
 *     ones faint (--t3). A failed weave marks the station it died at (--danger).
 *   the live tail                             — the last six lines of the
 *     current tool, mono, --t2.
 *   elapsed m:ss                              — from the state's elapsedMs,
 *     ticking locally between events while a station is live.
 *   CANCEL                                    — only while `cancellable`; the
 *     job tree is killed through the exec Guard. Swap and relaunch are past
 *     the point of return, and the card says so before they start.
 *   on failed / cancelled / dev done          — the outcome line and DISMISS.
 *
 * The card is absent while the job is idle. It never starts a weave itself —
 * that is the diff card's REWEAVE, the companion's consent turn, or Settings.
 *
 * Reduced-motion safe: the only animation is opacity. Tokens only. Copy law:
 * calm lowercase sentences, uppercase-mono chrome labels, no exclamation marks.
 */

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import LoomGlyph from "./LoomGlyph";
import { reweaveCancel, type ReweaveState } from "../../lib/core";
import { STATIONS, stationIndex, subscribe, type ReweaveStage } from "../../lib/loom/reweave";

/** z 1700 — above the proposal (1600), below the permission modal (2000). */
const REWEAVE_Z = 1700;

/** How many tail lines the card shows. The state carries up to 400. */
const TAIL_LINES = 6;

/**
 * The warning, said while it can still be acted on. STAGE is the last
 * cancellable station: SWAP writes the new executable over the running one and
 * RELAUNCH exits, and neither can be stopped. The spec says the card must say
 * so BEFORE the irreversible step, so this line stands next to a live CANCEL —
 * a warning shown only once the swap is running is not a warning.
 * Spec §Honest residuals: the microphone may be re-asked after the re-sign.
 */
export const APPROACHING_RETURN =
  "the next station cannot be cancelled — LOOM will close and return, and macOS may ask for the microphone again. cancel now if this is not the moment.";

/** The same fact, once it is no longer a warning but a description. */
export const POINT_OF_RETURN =
  "past the point of return — LOOM will close and return in a moment. macOS may ask for the microphone again.";

/** `m:ss`, floored. Minutes are not capped — a cold core build can pass an hour. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}

type StationState = "pending" | "active" | "done" | "failed";

const TERMINAL: ReadonlySet<ReweaveStage> = new Set(["done", "failed", "cancelled"]);

/**
 * The rail's colouring for one station, given the current stage and the last
 * station the job reached (so a terminal stage still shows where it stood).
 */
export function stationState(
  station: ReweaveStage,
  stage: ReweaveStage,
  lastStation: number,
): StationState {
  const i = stationIndex(station);
  const cursor = stationIndex(stage);
  if (cursor >= 0) {
    if (i < cursor) return "done";
    if (i === cursor) return "active";
    return "pending";
  }
  // Terminal or idle: everything the job reached is done; the station it
  // stood at when it failed is marked.
  if (stage === "failed" && i === lastStation) return "failed";
  if (stage === "done" && i <= lastStation) return "done";
  if (i < lastStation) return "done";
  if (i === lastStation && stage === "cancelled") return "pending";
  return "pending";
}

function stationColor(s: StationState): string {
  switch (s) {
    case "active":
      return "var(--accent)";
    case "done":
      return "var(--t2)";
    case "failed":
      return "var(--danger)";
    default:
      return "var(--t3)";
  }
}

function isStage(v: unknown): v is ReweaveStage {
  return (
    typeof v === "string" &&
    ["idle", "assets", "core", "stage", "swap", "relaunch", "done", "failed", "cancelled"].includes(v)
  );
}

export type ReweaveProps = {
  /** The state feed — defaults to the protected `subscribe`. Tests hand-crank it. */
  feed?: typeof subscribe;
  /** The cancel seam — defaults to `reweaveCancel`. */
  cancel?: () => Promise<void>;
};

export default function Reweave({ feed = subscribe, cancel = reweaveCancel }: ReweaveProps) {
  const rm = useReducedMotion() ?? false;
  const [state, setState] = useState<ReweaveState | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  // The furthest station this job reached — so a terminal state still shows
  // where it stood. Reset when a new weave begins at `assets`.
  const lastStation = useRef(-1);
  // Local clock: the state's elapsedMs at receipt, plus the time since.
  const receivedAt = useRef(0);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const off = feed((s) => {
      if (!s || typeof s !== "object" || !isStage((s as ReweaveState).stage)) return;
      const cursor = stationIndex(s.stage);
      if (cursor === 0) lastStation.current = 0;
      if (cursor > lastStation.current) lastStation.current = cursor;
      if (cursor >= 0) setDismissed(false);
      receivedAt.current = Date.now();
      setState(s);
    });
    return off;
  }, [feed]);

  // Tick once a second while a station is live so the clock reads honestly
  // between events (cargo can be quiet for a long minute).
  const live = state ? stationIndex(state.stage) >= 0 : false;
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [live]);

  const visible = state !== null && state.stage !== "idle" && !dismissed;

  async function onCancel() {
    if (busy) return;
    setBusy(true);
    try {
      await cancel();
    } catch {
      // refused past the point of return, or no shell — the next event says so.
    } finally {
      setBusy(false);
    }
  }

  const stage: ReweaveStage = state?.stage ?? "idle";
  const terminal = TERMINAL.has(stage);
  const pastReturn = stage === "swap" || stage === "relaunch";
  // In dev the job stops after STAGE — stages 4→5 are skipped and nothing is
  // ever swapped, so there is no irreversible step to warn about.
  const nearingReturn = stage === "stage" && state?.mode === "packaged";
  const returnLine = pastReturn ? POINT_OF_RETURN : nearingReturn ? APPROACHING_RETURN : null;
  const sha7 = state?.targetSha ? state.targetSha.slice(0, 7) : "";
  const tail = state ? state.tail.slice(-TAIL_LINES) : [];
  const elapsedMs = state
    ? state.elapsedMs + (live ? Math.max(0, Date.now() - receivedAt.current) : 0)
    : 0;
  void tick;

  const eyebrow =
    stage === "failed"
      ? "the weave failed"
      : stage === "cancelled"
        ? "the weave was cancelled"
        : stage === "done"
          ? "the weave is done"
          : "reweaving";

  const heading = sha7 ? `becoming generation ${sha7}` : "becoming a new generation";

  return (
    <AnimatePresence>
      {visible && state && (
        <motion.div
          data-testid="reweave-card"
          data-stage={stage}
          initial={rm ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={rm ? undefined : { opacity: 0 }}
          transition={rm ? {} : { duration: 0.25 }}
          style={{
            position: "fixed",
            bottom: 96,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: REWEAVE_Z,
            width: 460,
            maxWidth: "calc(100vw - 48px)",
            background: "var(--glass)",
            backdropFilter: "blur(var(--blur))",
            WebkitBackdropFilter: "blur(var(--blur))",
            border: "1px solid var(--glass-border)",
            boxShadow: "var(--shadow-2)",
            borderRadius: 14,
            padding: "16px 18px",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          {/* Eyebrow + heading */}
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
            <LoomGlyph size={18} style={{ flexShrink: 0, marginTop: 2 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                data-testid="reweave-eyebrow"
                style={{
                  fontFamily: "var(--f-mono)",
                  fontSize: 10,
                  letterSpacing: ".1em",
                  textTransform: "uppercase",
                  color: stage === "failed" ? "var(--danger)" : "var(--t3)",
                  marginBottom: 4,
                }}
              >
                {eyebrow}
              </div>
              <div style={{ fontSize: 13, color: "var(--t1)", lineHeight: 1.5 }}>{heading}</div>
            </div>
            <div
              data-testid="reweave-elapsed"
              title="elapsed"
              style={{
                fontFamily: "var(--f-mono)",
                fontSize: 11,
                color: "var(--t3)",
                fontVariantNumeric: "tabular-nums",
                flexShrink: 0,
                marginTop: 2,
              }}
            >
              {formatElapsed(elapsedMs)}
            </div>
          </div>

          {/* The rail — five stations, uppercase mono */}
          <div
            data-testid="reweave-rail"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontFamily: "var(--f-mono)",
              fontSize: 10,
              letterSpacing: ".14em",
            }}
          >
            {STATIONS.map((s, i) => {
              const st = stationState(s, stage, lastStation.current);
              return (
                <div key={s} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {i > 0 && (
                    <span aria-hidden style={{ color: "var(--t3)", opacity: 0.6 }}>
                      ·
                    </span>
                  )}
                  <span
                    data-testid={`reweave-station-${s}`}
                    data-state={st}
                    style={{
                      fontFamily: "var(--f-mono)",
                      textTransform: "uppercase",
                      color: stationColor(st),
                      fontWeight: st === "active" ? 700 : 400,
                      // Opacity is the only thing that moves; reduced motion needs no more.
                      transition: rm ? undefined : "color var(--dur-slow) var(--ease-out)",
                    }}
                  >
                    {s.toUpperCase()}
                  </span>
                </div>
              );
            })}
          </div>

          {/* The live tail — the last six lines of the current tool */}
          {tail.length > 0 && !terminal && (
            <pre
              data-testid="reweave-tail"
              style={{
                fontFamily: "var(--f-mono)",
                fontSize: 11,
                lineHeight: 1.5,
                color: "var(--t2)",
                margin: 0,
                padding: "8px 10px",
                background: "rgba(0,0,0,0.35)",
                borderRadius: 8,
                overflow: "hidden",
                whiteSpace: "pre",
              }}
            >
              {tail.map((line, i) => (
                <div
                  key={i}
                  data-testid="reweave-tail-line"
                  style={{ overflow: "hidden", textOverflow: "ellipsis" }}
                >
                  {line === "" ? " " : line}
                </div>
              ))}
            </pre>
          )}

          {/* The point of return — warned at STAGE, while CANCEL still works;
              restated plainly once SWAP has begun. */}
          {returnLine && (
            <div
              data-testid="reweave-return-line"
              style={{ fontSize: 12.5, color: "var(--warn)", lineHeight: 1.5 }}
            >
              {returnLine}
            </div>
          )}

          {/* The outcome — failed, cancelled, or a dev done */}
          {terminal && state.outcome && (
            <div
              data-testid="reweave-outcome"
              style={{
                fontSize: 12.5,
                color: stage === "failed" ? "var(--danger)" : "var(--t2)",
                lineHeight: 1.5,
                overflowWrap: "anywhere",
              }}
            >
              {state.outcome}
            </div>
          )}

          {/* Actions — one at a time: CANCEL while it can be, DISMISS at rest */}
          {(state.cancellable && !terminal) || terminal ? (
            <div style={{ display: "flex", gap: 8 }}>
              {state.cancellable && !terminal && (
                <button
                  data-testid="reweave-cancel"
                  onClick={onCancel}
                  disabled={busy}
                  style={{
                    background: "rgba(255,255,255,.06)",
                    color: "var(--t2)",
                    border: "1px solid var(--glass-border)",
                    borderRadius: 6,
                    padding: "6px 14px",
                    fontFamily: "var(--f-mono)",
                    fontSize: 10,
                    letterSpacing: ".14em",
                    textTransform: "uppercase",
                    cursor: busy ? "not-allowed" : "pointer",
                    opacity: busy ? 0.6 : 1,
                  }}
                >
                  CANCEL
                </button>
              )}
              {terminal && (
                <button
                  data-testid="reweave-dismiss"
                  onClick={() => setDismissed(true)}
                  style={{
                    background: "rgba(255,255,255,.06)",
                    color: "var(--t2)",
                    border: "1px solid var(--glass-border)",
                    borderRadius: 6,
                    padding: "6px 14px",
                    fontFamily: "var(--f-mono)",
                    fontSize: 10,
                    letterSpacing: ".14em",
                    textTransform: "uppercase",
                    cursor: "pointer",
                  }}
                >
                  DISMISS
                </button>
              )}
            </div>
          ) : null}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
