/**
 * Threading.tsx — the threading card: six stations, one network trip, a stop.
 *
 * The surface for the one-time ceremony (spec §Threading). Threading spends
 * the owner's single network trip and then compiles the whole core — tens of
 * minutes — and until this card existed it ran blind: `thread_cancel` was
 * registered, wrapped and tested with no caller anywhere in the product, and
 * the `loom-thread` event had exactly one listener, inside an organ power.
 * A ceremony started from the companion's consent card printed one line and
 * then said nothing for half an hour.
 *
 * It listens to the protected `threading.ts` feed (the `thread_status` seed
 * first, then every `loom-thread` event) and paints:
 *
 *   SEED · DEPS · VENDOR · WARM · REGISTER · STAMP — the rail. The active
 *     station is luminous (--accent), completed stations dimmed (--t2),
 *     pending ones faint (--t3). A failed ceremony marks the station it died
 *     at (--danger).
 *   the network line     — said BEFORE the fetch, and only while the fetch is
 *     still owed: a resumed ceremony whose deps and vendor are already marked
 *     never touches the network, and must not claim it will.
 *   the streamed tail    — npm's output and cargo's "Compiling x/y", mono, --t2.
 *   elapsed m:ss         — counted from the first event this card saw. There is
 *     no Rust read of a ceremony in flight (see threading.ts on what a
 *     `thread_state` command would buy), so the clock is honest about that
 *     rather than pretending to know when the ceremony began.
 *   CANCEL               — wired to `thread_cancel`, with the note that every
 *     finished step is kept and threading resumes where it stopped. The core
 *     answers with an error when nothing is being threaded; that is a race the
 *     card can lose honestly, so it is shown as a sentence, not an error.
 *   the ending           — done or failed, said plainly, with DISMISS.
 *
 * The card is absent while nothing is threading. It never starts a ceremony —
 * that is the companion's consent turn, Settings' THREAD THE LOOM, or an
 * organ's request through the body-request card.
 *
 * Reduced-motion safe: the only animation is opacity. Tokens only. Copy law:
 * calm lowercase sentences, uppercase-mono chrome labels, no exclamation marks.
 */

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import LoomGlyph from "./LoomGlyph";
import type { ThreadEvent, ThreadStep } from "../../lib/core";
import {
  STATIONS,
  stationIndex,
  stationState,
  beforeNetworkSpent,
  formatElapsed,
  subscribe,
  cancelThreading,
  CANCEL_MEANS,
  NETWORK_ONCE,
  type CancelResult,
  type StationState,
  type ThreadFeedMsg,
} from "../../lib/loom/threading";

/** z 1700 — the reweave card's tier. The two can never be live together:
 *  threading and reweave share one job slot in the core. */
const THREADING_Z = 1700;

/** How many tail lines the card shows. Rust sends the last three. */
const TAIL_LINES = 6;

/** Every step the ceremony can report, terminal ones included. */
const STEPS: readonly string[] = [...STATIONS, "done", "failed"];

function isStep(v: unknown): v is ThreadStep {
  return typeof v === "string" && STEPS.includes(v);
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

const BUTTON: React.CSSProperties = {
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
};

export type ThreadingProps = {
  /** The state feed — defaults to the protected `subscribe`. Tests hand-crank it. */
  feed?: typeof subscribe;
  /** The cancel seam — defaults to `cancelThreading`. */
  cancel?: () => Promise<CancelResult>;
};

export default function Threading({ feed = subscribe, cancel = cancelThreading }: ThreadingProps) {
  const rm = useReducedMotion() ?? false;
  const [step, setStep] = useState<ThreadStep | null>(null);
  const [detail, setDetail] = useState("");
  const [tail, setTail] = useState<string[]>([]);
  const [needsNetwork, setNeedsNetwork] = useState(true);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Set when `thread_cancel` refuses — the calm sentence replaces CANCEL. */
  const [refusal, setRefusal] = useState<string | null>(null);

  // The furthest station this ceremony reached, so a terminal step still
  // shows where it stood.
  const lastStation = useRef(-1);
  // The station the current tail belongs to — a new station starts clean.
  const tailStep = useRef<string | null>(null);
  // The first event's arrival. There is no ceremony start time to read.
  const startedAt = useRef(0);
  const [, setTick] = useState(0);

  useEffect(() => {
    const off = feed((m: ThreadFeedMsg) => {
      if (m.kind === "seed") {
        setNeedsNetwork(m.status.needsNetwork);
        return;
      }
      const e: ThreadEvent = m.event;
      if (!e || typeof e !== "object" || !isStep(e.step)) return;
      const cursor = stationIndex(e.step);
      if (cursor === 0 || startedAt.current === 0) {
        startedAt.current = Date.now();
        lastStation.current = -1;
      }
      if (cursor > lastStation.current) lastStation.current = cursor;
      if (cursor >= 0) {
        setDismissed(false);
        setRefusal(null);
      }
      if (tailStep.current !== e.step) {
        tailStep.current = e.step;
        setTail(e.tail ?? []);
      } else if (e.tail && e.tail.length > 0) {
        setTail(e.tail);
      }
      setStep(e.step);
      setDetail(typeof e.detail === "string" ? e.detail : "");
    });
    return off;
  }, [feed]);

  const terminal = step === "done" || step === "failed";
  const live = step !== null && !terminal;

  // Tick once a second while the ceremony runs, so the clock reads honestly
  // between events — the warm step can be quiet for a long minute.
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [live]);

  async function onCancel() {
    if (busy) return;
    setBusy(true);
    try {
      const out = await cancel();
      if (!out.ok) setRefusal(out.reason);
    } catch {
      // the seam itself broke — the next event says where the ceremony stands.
    } finally {
      setBusy(false);
    }
  }

  const visible = step !== null && !dismissed;
  const elapsedMs = startedAt.current === 0 ? 0 : Date.now() - startedAt.current;
  const shownTail = tail.slice(-TAIL_LINES);
  const showTail = shownTail.length > 0 && (!terminal || step === "failed");
  const showNetworkLine = needsNetwork && step !== null && beforeNetworkSpent(step);

  const eyebrow =
    step === "failed"
      ? "threading failed"
      : step === "done"
        ? "the loom is threaded"
        : "threading the loom";

  // Present tense only while it is present tense — a stopped ceremony that
  // still says "preparing" is describing something that is not happening.
  const heading =
    step === "failed"
      ? "the ceremony stopped at the station marked above"
      : step === "done"
        ? "the ceremony is over"
        : "preparing the loom to weave";

  return (
    <AnimatePresence>
      {visible && step && (
        <motion.div
          data-testid="threading-card"
          data-step={step}
          initial={rm ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={rm ? undefined : { opacity: 0 }}
          transition={rm ? {} : { duration: 0.25 }}
          style={{
            position: "fixed",
            bottom: 96,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: THREADING_Z,
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
                data-testid="threading-eyebrow"
                style={{
                  fontFamily: "var(--f-mono)",
                  fontSize: 10,
                  letterSpacing: ".1em",
                  textTransform: "uppercase",
                  color: step === "failed" ? "var(--danger)" : "var(--t3)",
                  marginBottom: 4,
                }}
              >
                {eyebrow}
              </div>
              <div
                data-testid="threading-heading"
                style={{ fontSize: 13, color: "var(--t1)", lineHeight: 1.5 }}
              >
                {heading}
              </div>
            </div>
            <div
              data-testid="threading-elapsed"
              title="elapsed since this card started watching"
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

          {/* The rail — six stations, uppercase mono */}
          <div
            data-testid="threading-rail"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              flexWrap: "wrap",
              fontFamily: "var(--f-mono)",
              fontSize: 10,
              letterSpacing: ".14em",
            }}
          >
            {STATIONS.map((s, i) => {
              const st = stationState(s, step, lastStation.current);
              return (
                <div key={s} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  {i > 0 && (
                    <span aria-hidden style={{ color: "var(--t3)", opacity: 0.6 }}>
                      ·
                    </span>
                  )}
                  <span
                    data-testid={`threading-station-${s}`}
                    data-state={st}
                    style={{
                      fontFamily: "var(--f-mono)",
                      textTransform: "uppercase",
                      color: stationColor(st),
                      fontWeight: st === "active" ? 700 : 400,
                      // Opacity and colour are all that move; reduced motion needs no more.
                      transition: rm ? undefined : "color var(--dur-slow) var(--ease-out)",
                    }}
                  >
                    {s.toUpperCase()}
                  </span>
                </div>
              );
            })}
          </div>

          {/* What the ceremony is doing, in the core's own words */}
          {detail && !terminal && (
            <div
              data-testid="threading-detail"
              style={{ fontSize: 12.5, color: "var(--t2)", lineHeight: 1.5, overflowWrap: "anywhere" }}
            >
              {detail}
            </div>
          )}

          {/* The network line — said before the network is used, and only
              while this ceremony still owes the trip. */}
          {showNetworkLine && (
            <div
              data-testid="threading-network-line"
              style={{ fontSize: 12.5, color: "var(--warn)", lineHeight: 1.5 }}
            >
              {NETWORK_ONCE}
            </div>
          )}

          {/* The streamed tail — npm's output, cargo's "Compiling x/y" */}
          {showTail && (
            <pre
              data-testid="threading-tail"
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
              {shownTail.map((line, i) => (
                <div
                  key={i}
                  data-testid="threading-tail-line"
                  style={{ overflow: "hidden", textOverflow: "ellipsis" }}
                >
                  {line === "" ? " " : line}
                </div>
              ))}
            </pre>
          )}

          {/* The ending, said plainly */}
          {terminal && detail && (
            <div
              data-testid="threading-outcome"
              style={{
                fontSize: 12.5,
                color: step === "failed" ? "var(--danger)" : "var(--t2)",
                lineHeight: 1.5,
                overflowWrap: "anywhere",
              }}
            >
              {detail}
            </div>
          )}

          {/* What cancelling means — or, once the core has refused, why it did
              nothing. Either way it stands next to the button it describes. */}
          {!terminal && (
            <div
              data-testid="threading-cancel-note"
              style={{ fontSize: 12, color: "var(--t3)", lineHeight: 1.5 }}
            >
              {refusal ?? CANCEL_MEANS}
            </div>
          )}

          {/* Actions — CANCEL while the ceremony runs, DISMISS once it is over */}
          <div style={{ display: "flex", gap: 8 }}>
            {!terminal && refusal === null && (
              <button
                data-testid="threading-cancel"
                onClick={onCancel}
                disabled={busy}
                style={{ ...BUTTON, cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.6 : 1 }}
              >
                CANCEL
              </button>
            )}
            {(terminal || refusal !== null) && (
              <button
                data-testid="threading-dismiss"
                onClick={() => setDismissed(true)}
                style={BUTTON}
              >
                DISMISS
              </button>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
