import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { fleetChat, organWrite, organRead, organList, ttsSpeak, type OrganFile, type Msg, type ChatOpts } from "../lib/core";
import { gate } from "../lib/loom/validate";
import { buildOrgan, type BuildEvent } from "../lib/loom/build";
import { editOrgan } from "../lib/companion/editOrgan";
import { handle, type CompanionTurn } from "../lib/companion/runtime";
import { turnStartMood, firstEventMood, settleMood, dispatchMood } from "../lib/orb/moods";
import { getSetting, setSetting } from "../lib/voice/settings";
import { playWav } from "../lib/voice/player";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type BubbleRole = "user" | "assistant";

type MsgBubble = {
  kind: "bubble";
  role: BubbleRole;
  text: string;
  id: string;
};

type EventLogCard = {
  kind: "event-log";
  events: BuildEvent[];
  id: string;
};

type SuccessCard = {
  kind: "success";
  turnKind: "build" | "edit";
  organId: string;
  sha: string;
  id: string;
};

type FailureCard = {
  kind: "failure";
  stage?: string;
  error?: string;
  utterance: string;
  id: string;
};

type ReviewCard = {
  kind: "review";
  files: OrganFile[];
  id: string;
};

type ConvoItem =
  | MsgBubble
  | EventLogCard
  | SuccessCard
  | FailureCard
  | ReviewCard;

// ---------------------------------------------------------------------------
// Shared style tokens (mirror LoomConsole visual language)
// ---------------------------------------------------------------------------

const panelBase: React.CSSProperties = {
  background: "var(--panel)",
  border: "1px solid rgba(255,255,255,0.06)",
  borderRadius: 8,
  padding: "16px 20px",
};

const monoSmall: React.CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 12,
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function CyanDot() {
  return (
    <div
      style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: "var(--accent)",
        flexShrink: 0,
        marginTop: 5,
      }}
    />
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
      <div
        style={{
          ...panelBase,
          padding: "10px 14px",
          maxWidth: "72%",
          minWidth: 0,
          color: "var(--t1)",
          fontSize: 14,
          lineHeight: 1.5,
          borderRadius: 10,
          background: "rgba(255,255,255,0.05)",
          border: "1px solid rgba(255,255,255,0.08)",
          overflowWrap: "break-word",
        }}
      >
        {text}
      </div>
    </div>
  );
}

function AssistantBubble({ text }: { text: string }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 10 }}>
      <CyanDot />
      <div
        style={{
          ...panelBase,
          padding: "10px 14px",
          maxWidth: "80%",
          minWidth: 0,
          color: "var(--t1)",
          fontSize: 14,
          lineHeight: 1.5,
          borderRadius: 10,
          flex: 1,
          overflowWrap: "break-word",
        }}
      >
        {text}
      </div>
    </div>
  );
}

// Canonical ordered build phases for the stepper.
const STEPPER_PHASES = [
  "manifest",
  "code",
  "probe",
  "tests",
  "gate",
  "review",
  "write",
] as const;
type StepperPhase = (typeof STEPPER_PHASES)[number];

// Per-phase accent colors for the mono detail log. Phases not listed fall
// back to --t2. Kept mood-agnostic and yellow-free.
const PHASE_COLORS: Record<string, string> = {
  manifest: "#7dd3fc",
  code: "#22d3ee",
  probe: "#a78bfa",
  tests: "#4ade80",
  gate: "#22d3ee",
  repair: "#f97316",
  review: "#a78bfa",
  write: "#4ade80",
  error: "var(--danger)",
};

function phaseColor(phase: string): string {
  return PHASE_COLORS[phase] ?? "var(--t2)";
}

type StepState = "pending" | "done" | "current" | "error";

/**
 * Derive the visual state of each ordered step from the raw BuildEvent stream.
 * - The last event's phase is the "current" step (unless it's an error).
 * - Every canonical phase that has appeared earlier than the current one is "done".
 * - An "error" event marks the current step (or the last non-error phase) as error.
 */
export function deriveStepStates(events: BuildEvent[]): Record<StepperPhase, StepState> {
  const states = Object.fromEntries(
    STEPPER_PHASES.map((p) => [p, "pending" as StepState]),
  ) as Record<StepperPhase, StepState>;

  if (events.length === 0) return states;

  const hasError = events.some((e) => e.phase === "error");
  // The most recent canonical phase seen in the stream.
  let lastCanonical: StepperPhase | null = null;
  const seen = new Set<StepperPhase>();
  for (const e of events) {
    if ((STEPPER_PHASES as readonly string[]).includes(e.phase)) {
      const p = e.phase as StepperPhase;
      seen.add(p);
      lastCanonical = p;
    }
  }

  if (lastCanonical === null) return states;

  const currentIdx = STEPPER_PHASES.indexOf(lastCanonical);
  for (let i = 0; i < STEPPER_PHASES.length; i++) {
    const p = STEPPER_PHASES[i];
    if (!seen.has(p)) continue;
    if (i < currentIdx) states[p] = "done";
    else if (i === currentIdx) states[p] = hasError ? "error" : "current";
  }
  // If an error occurred, mark the current step as error explicitly.
  if (hasError) states[lastCanonical] = "error";

  return states;
}

function PhaseStepper({ events }: { events: BuildEvent[] }) {
  const states = deriveStepStates(events);

  return (
    <div
      data-testid="phase-stepper"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        flexWrap: "wrap",
        marginBottom: 6,
      }}
    >
      {STEPPER_PHASES.map((phase, i) => {
        const state = states[phase];
        const color =
          state === "error"
            ? "var(--danger)"
            : state === "done"
              ? "var(--accent)"
              : state === "current"
                ? "var(--accent)"
                : "var(--t3)";
        return (
          <div
            key={phase}
            data-testid={`step-${phase}`}
            data-step-state={state}
            style={{ display: "flex", alignItems: "center", gap: 4 }}
          >
            <span
              className={state === "current" ? "loom-step-pulse" : undefined}
              style={{
                fontFamily: "var(--f-mono)",
                fontSize: 10,
                letterSpacing: ".04em",
                color,
                opacity: state === "pending" ? 0.5 : 1,
              }}
            >
              {phase}
            </span>
            {i < STEPPER_PHASES.length - 1 && (
              <span style={{ color: "var(--t3)", fontSize: 10, opacity: 0.5 }}>-&gt;</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function EventLog({ events }: { events: BuildEvent[] }) {
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [events]);

  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 10 }}>
      <CyanDot />
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Ordered phase stepper header */}
        <PhaseStepper events={events} />
        {/* Mono detail log — each line colored by phase */}
        <div
          ref={logRef}
          style={{
            ...monoSmall,
            maxHeight: 180,
            overflowY: "auto",
            color: "var(--t2)",
            background: "rgba(0,0,0,0.25)",
            borderRadius: 4,
            padding: "8px 10px",
          }}
        >
          {events.map((e, i) => (
            <div key={i} style={{ padding: "1px 0", overflowWrap: "break-word" }}>
              <span style={{ color: phaseColor(e.phase) }}>[{e.phase}]</span>{" "}
              <span style={{ overflowWrap: "break-word" }}>{e.detail}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SuccessCardView({
  item,
}: {
  item: SuccessCard;
}) {
  const verb = item.turnKind === "build" ? "Built" : "Edited";
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 10 }}>
      <CyanDot />
      <div
        style={{
          flex: 1,
          background: "rgba(0,200,100,0.07)",
          border: "1px solid rgba(0,200,100,0.2)",
          borderRadius: 8,
          padding: "12px 14px",
        }}
      >
        <div
          title={`${verb} ${item.organId}`}
          style={{
            color: "var(--go)",
            fontWeight: 600,
            marginBottom: 4,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: 320,
            minWidth: 0,
          }}
        >
          {verb} {item.organId}
        </div>
        <div
          style={{ ...monoSmall, color: "var(--t3)", marginBottom: 6, wordBreak: "break-all" }}
        >
          sha: {item.sha}
        </div>
        {item.turnKind === "build" && (
          <div style={{ fontSize: 13, color: "var(--t2)" }}>
            Approve it below to run it.
          </div>
        )}
      </div>
    </div>
  );
}

function FailureCardView({
  item,
  onRetry,
}: {
  item: FailureCard;
  onRetry: (utterance: string) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 10 }}>
      <CyanDot />
      <div
        style={{
          flex: 1,
          background: "rgba(220,50,50,0.07)",
          border: "1px solid rgba(220,50,50,0.2)",
          borderRadius: 8,
          padding: "12px 14px",
        }}
      >
        <div
          style={{
            color: "var(--danger)",
            fontWeight: 600,
            marginBottom: 6,
            display: "flex",
            gap: 6,
            minWidth: 0,
          }}
        >
          <span style={{ flexShrink: 0 }}>Failed</span>
          {item.stage && (
            <span
              title={`stage: ${item.stage}`}
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                minWidth: 0,
                fontWeight: 400,
              }}
            >
              — stage: {item.stage}
            </span>
          )}
        </div>
        <div
          style={{
            ...monoSmall,
            color: "var(--t2)",
            marginBottom: 10,
            wordBreak: "break-word",
          }}
        >
          {item.error}
        </div>
        <button
          onClick={() => onRetry(item.utterance)}
          style={{
            background: "rgba(255,255,255,0.08)",
            color: "var(--t1)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 4,
            padding: "5px 14px",
            fontWeight: 600,
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          Retry
        </button>
      </div>
    </div>
  );
}

function ReviewCardView({
  item,
  onSettle,
}: {
  item: ReviewCard;
  onSettle: (id: string, approved: boolean) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 10 }}>
      <CyanDot />
      <div
        style={{
          flex: 1,
          background: "var(--accent-soft)",
          border: "1px solid rgba(34,211,238,0.3)",
          borderRadius: 8,
          padding: "12px 14px",
        }}
      >
        <div style={{ color: "var(--accent)", fontWeight: 600, marginBottom: 8 }}>
          Review — validated, not yet saved
        </div>
        {item.files.map((f) => (
          <details key={f.name} style={{ marginBottom: 6 }}>
            <summary
              style={{
                fontFamily: "var(--f-mono)",
                fontSize: 12,
                color: "var(--t1)",
                cursor: "pointer",
              }}
            >
              {f.name}{" "}
              <span style={{ color: "var(--t3)" }}>({f.content.length} chars)</span>
            </summary>
            <pre
              style={{
                fontFamily: "var(--f-mono)",
                fontSize: 11,
                lineHeight: 1.5,
                color: "var(--t2)",
                background: "rgba(0,0,0,0.3)",
                borderRadius: 4,
                padding: "8px 10px",
                maxHeight: 220,
                overflow: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {f.content}
            </pre>
          </details>
        ))}
        <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
          <button
            onClick={() => onSettle(item.id, true)}
            style={{
              background: "var(--accent)",
              color: "#04222b",
              border: "none",
              borderRadius: 4,
              padding: "5px 14px",
              fontWeight: 600,
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            Apply and save
          </button>
          <button
            onClick={() => onSettle(item.id, false)}
            style={{
              background: "rgba(255,255,255,0.08)",
              color: "var(--t1)",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 4,
              padding: "5px 14px",
              fontWeight: 600,
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            Discard
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Companion
// ---------------------------------------------------------------------------

let _idCounter = 0;
function nextId() {
  return `ci-${++_idCounter}`;
}

// ---------------------------------------------------------------------------
// Fleet activity dispatch
// ---------------------------------------------------------------------------
// FleetHUD lights the active role from `loom-fleet-activity` CustomEvents.
// { role, phase } marks a role active with a phase label; { role: null }
// clears the active state. Companion is the single source of these events
// because it is the only place that observes which fleet member is working:
//   - builder  → every BuildEvent phase during a build/edit
//   - companion→ around the converse chat call
//   - rewriter → around the model-classified intent (askModel) call. The
//     rewriter is the fleet member the compiler uses for its model fallback
//     classification, so we light it around that askModel invocation and clear
//     it immediately after — regardless of whether the rules or model path
//     ultimately resolved the intent (a no-op flash if rules short-circuited
//     before the model was consulted is acceptable and cheap).
function dispatchFleetActivity(
  role: "builder" | "companion" | "rewriter" | null,
  phase?: string,
) {
  window.dispatchEvent(
    new CustomEvent("loom-fleet-activity", { detail: { role, phase } }),
  );
}

export default function Companion() {
  const rm = useReducedMotion() ?? false;
  const [textareaFocused, setTextareaFocused] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [items, setItems] = useState<ConvoItem[]>([]);
  const [reviewOn, setReviewOn] = useState(
    () => localStorage.getItem("loom.reviewBeforeSave") === "1"
  );

  // Each active review card gets a resolve fn keyed by its card id
  const reviewResolvers = useRef<Map<string, (approved: boolean) => void>>(new Map());

  // Ref for the active event-log card id (so we can append to it)
  const activeLogId = useRef<string | null>(null);

  // History as Msg[] for the runtime (user + assistant only)
  const history = useRef<Msg[]>([]);

  // Mood lifecycle refs
  // Tracks whether the "building" mood has been dispatched for the current turn
  const hasBuildingMood = useRef(false);
  // Stores the pending "idle" timeout so it can be cancelled on new turn or unmount
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Spoken turn tracking
  const spokenTurnRef = useRef(false);

  // Stable ref to runTurn so the loom-utterance listener doesn't need to re-register
  const runTurnRef = useRef<((utterance: string) => Promise<void>) | null>(null);

  const convoRef = useRef<HTMLDivElement | null>(null);

  function scrollToBottom() {
    requestAnimationFrame(() => {
      const el = convoRef.current;
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
    });
  }

  function toggleReview() {
    setReviewOn((v) => {
      localStorage.setItem("loom.reviewBeforeSave", v ? "0" : "1");
      return !v;
    });
  }

  function appendItem(item: ConvoItem) {
    setItems((prev) => [...prev, item]);
    scrollToBottom();
  }

  function appendEvent(e: BuildEvent) {
    const logId = activeLogId.current;
    if (!logId) return;
    setItems((prev) =>
      prev.map((item) =>
        item.kind === "event-log" && item.id === logId
          ? { ...item, events: [...item.events, e] }
          : item
      )
    );
    scrollToBottom();
  }

  function requestReview(files: OrganFile[]): Promise<boolean> {
    return new Promise((resolve) => {
      const reviewId = nextId();
      reviewResolvers.current.set(reviewId, resolve);
      appendItem({ kind: "review", files, id: reviewId });
    });
  }

  function clearIdleTimer() {
    if (idleTimer.current !== null) {
      clearTimeout(idleTimer.current);
      idleTimer.current = null;
    }
  }

  function settleReview(id: string, approved: boolean) {
    const resolve = reviewResolvers.current.get(id);
    if (resolve) {
      resolve(approved);
      reviewResolvers.current.delete(id);
    }
    // Remove the review card from the list
    setItems((prev) => prev.filter((item) => item.id !== id));
  }

  async function runTurn(utterance: string) {
    if (busy || !utterance.trim()) return;
    const text = utterance.trim();
    setBusy(true);

    // Mood: cancel any in-flight idle timer and start thinking
    clearIdleTimer();
    hasBuildingMood.current = false;
    turnStartMood();

    // Push user bubble
    appendItem({ kind: "bubble", role: "user", text, id: nextId() });
    history.current.push({ role: "user", content: text });

    // Start event-log card (will be populated by onEvent)
    const logId = nextId();
    activeLogId.current = logId;
    appendItem({ kind: "event-log", events: [], id: logId });

    // Wraps appendEvent so the first build/edit event also triggers the
    // "building" mood (only once per turn) and lights the builder in the HUD.
    function appendEventWithMood(e: BuildEvent) {
      if (firstEventMood(hasBuildingMood.current)) {
        hasBuildingMood.current = true;
      }
      // Every build/edit phase event lights the builder with the current phase.
      dispatchFleetActivity("builder", e.phase);
      appendEvent(e);
    }

    // Wrap fleetChat so the converse ("companion" role) call lights the
    // companion member for the duration of the reply generation.
    const chatWithActivity = async (role: string, messages: Msg[], opts?: ChatOpts) => {
      if (role === "companion") {
        dispatchFleetActivity("companion", "converse");
        try {
          return await fleetChat(role, messages, opts);
        } finally {
          dispatchFleetActivity(null);
        }
      }
      return fleetChat(role, messages, opts);
    };

    const deps = {
      chat: chatWithActivity,
      build: (req: string) =>
        buildOrgan(req, {
          chat: fleetChat,
          write: organWrite,
          gate,
          onEvent: appendEventWithMood,
          ...(reviewOn ? { review: requestReview } : {}),
        }),
      edit: (id: string, req: string) =>
        editOrgan(id, req, {
          chat: fleetChat,
          read: organRead,
          write: organWrite,
          gate,
          onEvent: appendEventWithMood,
          ...(reviewOn ? { review: requestReview } : {}),
        }),
      organIds: async () => {
        const entries = await organList();
        return entries
          .map((e) => {
            try {
              return JSON.parse(e.manifest).id as string;
            } catch {
              return null;
            }
          })
          .filter((id): id is string => Boolean(id));
      },
      // askModel is the rewriter-role model fallback used by the intent
      // compiler. Light the rewriter around the compile call: on before the
      // model classification, off immediately after.
      askModel: async (system: string, prompt: string) => {
        dispatchFleetActivity("rewriter", "rewrite");
        try {
          return await fleetChat("rewriter", [
            { role: "system", content: system },
            { role: "user", content: prompt },
          ]);
        } finally {
          dispatchFleetActivity(null);
        }
      },
      // Provide current deck state to the runtime so deck_command rules can
      // auto-switch from void → globe when needed.
      currentDeck: () => getSetting("cockpit.deck") as "void" | "globe",
    };

    let turn: CompanionTurn;
    try {
      turn = await handle(text, history.current, deps);
    } catch (err) {
      // Clear any fleet-active state — the turn is over.
      dispatchFleetActivity(null);
      // Settle and clear any pending review resolvers
      reviewResolvers.current.forEach((resolve) => resolve(false));
      reviewResolvers.current.clear();
      // Remove log card
      activeLogId.current = null;
      setItems((prev) => prev.filter((item) => item.id !== logId));
      appendItem({
        kind: "failure",
        error: String(err),
        utterance: text,
        id: nextId(),
      });
      // Mood: turn ended with error
      idleTimer.current = settleMood();
      setBusy(false);
      return;
    }

    // Turn resolved — clear any lingering fleet-active state (build end).
    dispatchFleetActivity(null);

    // Remove the log card if it's still empty (fast converse turns)
    activeLogId.current = null;
    setItems((prev) => {
      const log = prev.find((item) => item.id === logId);
      if (log && log.kind === "event-log" && log.events.length === 0) {
        return prev.filter((item) => item.id !== logId);
      }
      return prev;
    });

    // Process turn result
    if (turn.kind === "reply") {
      const replyText = turn.text;
      appendItem({ kind: "bubble", role: "assistant", text: replyText, id: nextId() });
      history.current.push({ role: "assistant", content: replyText });
    } else if (turn.kind === "build") {
      const result = turn.result;
      if (result.ok && result.organId && result.sha) {
        appendItem({
          kind: "success",
          turnKind: "build",
          organId: result.organId,
          sha: result.sha,
          id: nextId(),
        });
        window.dispatchEvent(new CustomEvent("organs-changed"));
        const repairRounds = result.log.filter((e) => e.phase === "repair").length;
        const historyMsg = `Built ${result.organId}: organ ready. Passed in ${repairRounds} repair round(s).`;
        history.current.push({ role: "assistant", content: historyMsg });
        const oneliner = `${result.organId} is ready — approve it below.`;
        appendItem({ kind: "bubble", role: "assistant", text: oneliner, id: nextId() });
      } else {
        appendItem({
          kind: "failure",
          stage: result.stage,
          error: result.error,
          utterance: text,
          id: nextId(),
        });
        const failMsg = `Build of ${result.organId ?? "organ"} failed at ${result.stage ?? "unknown"}.`;
        history.current.push({ role: "assistant", content: failMsg });
      }
    } else if (turn.kind === "edit") {
      const result = turn.result;
      if (result.ok && result.organId && result.sha) {
        appendItem({
          kind: "success",
          turnKind: "edit",
          organId: result.organId,
          sha: result.sha,
          id: nextId(),
        });
        window.dispatchEvent(new CustomEvent("organs-changed"));
        const requestSummary = text.slice(0, 80);
        const historyMsg = `Edited ${result.organId}: ${requestSummary}.`;
        history.current.push({ role: "assistant", content: historyMsg });
        const oneliner = `${result.organId} updated.`;
        appendItem({ kind: "bubble", role: "assistant", text: oneliner, id: nextId() });
      } else {
        appendItem({
          kind: "failure",
          stage: result.stage,
          error: result.error,
          utterance: text,
          id: nextId(),
        });
      }
    } else if (turn.kind === "act") {
      window.dispatchEvent(
        new CustomEvent("organ-focus", { detail: { id: turn.organId } })
      );
      const oneliner = `Opening ${turn.organId} below.`;
      appendItem({ kind: "bubble", role: "assistant", text: oneliner, id: nextId() });
    } else if (turn.kind === "deck_command") {
      const { deckCommandResult, confirmation } = turn;

      // 1. Orb mood pulse: building → idle (fast visual beat for instant commands)
      dispatchMood("building");

      // 2. Deck switch first (spec requirement 4: auto-switch fires before bridge cmd)
      if (deckCommandResult.deckSwitch) {
        // Persist deck state so kernel store stays consistent
        setSetting("cockpit.deck", deckCommandResult.deckSwitch);
        window.dispatchEvent(
          new CustomEvent("loom-deck", {
            detail: { deck: deckCommandResult.deckSwitch },
          })
        );
      }

      // 3. Bridge commands forwarded to GlobeDeck via loom-deck-command event
      if (deckCommandResult.bridgeCmds.length > 0) {
        window.dispatchEvent(
          new CustomEvent("loom-deck-command", {
            detail: { bridgeCmds: deckCommandResult.bridgeCmds },
          })
        );
      }

      // 4. Push confirmation to history and show in companion
      appendItem({ kind: "bubble", role: "assistant", text: confirmation, id: nextId() });
      history.current.push({ role: "assistant", content: confirmation });

      // 5. Orb settle to idle
      dispatchMood("idle");
    }

    // Determine if we should speak the reply
    let speakableText: string | null = null;
    if (turn.kind === "reply") {
      speakableText = turn.text;
    } else if (turn.kind === "build") {
      const r = turn.result;
      if (r.ok && r.organId) speakableText = `${r.organId} is ready — approve it below.`;
    } else if (turn.kind === "edit") {
      const r = turn.result;
      if (r.ok && r.organId) speakableText = `${r.organId} updated.`;
    } else if (turn.kind === "act") {
      speakableText = `Opening ${turn.organId} below.`;
    } else if (turn.kind === "deck_command") {
      speakableText = turn.confirmation;
    }

    const speakReplies = getSetting("voice.speakReplies");
    const shouldSpeak =
      speakableText !== null &&
      (speakReplies === "always" || (speakReplies === "whenSpoken" && spokenTurnRef.current));

    if (shouldSpeak && speakableText !== null) {
      const textToSpeak = speakableText;
      dispatchMood("speaking");
      setBusy(false);
      spokenTurnRef.current = false;
      void (async () => {
        try {
          const raw = await ttsSpeak(textToSpeak, getSetting("voice.default"));
          await playWav(new Uint8Array(raw));
        } catch (e) {
          console.warn("[Companion] ttsSpeak/playWav failed:", e);
        } finally {
          dispatchMood("idle");
        }
      })();
      return;
    }

    // Non-speaking path
    spokenTurnRef.current = false;
    idleTimer.current = settleMood();
    setBusy(false);
  }

  // Keep runTurnRef in sync so the loom-utterance listener can call current runTurn
  runTurnRef.current = runTurn;

  function handleRetry(utterance: string) {
    runTurn(utterance);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      runTurn(input);
      setInput("");
    }
  }

  // Auto-scroll on new items
  useEffect(() => {
    scrollToBottom();
  }, [items]);

  // loom-utterance listener — triggered by voice PTT
  useEffect(() => {
    function onUtterance(ev: Event) {
      const detail = (ev as CustomEvent<{ text: string; spoken?: boolean }>).detail;
      if (!detail?.text) return;
      spokenTurnRef.current = detail.spoken === true;
      void runTurnRef.current?.(detail.text);
    }
    window.addEventListener("loom-utterance", onUtterance);
    return () => window.removeEventListener("loom-utterance", onUtterance);
  }, []); // stable — uses ref pattern

  // First-run greeting — injected instantly, no model call required
  useEffect(() => {
    if (localStorage.getItem("loom.firstGreeting") !== null) return;
    setItems([{
      kind: "bubble",
      role: "assistant",
      text: "I am LOOM. I run on your machine, entirely offline. To start building: ask me to build something — a water tracker, a reading log, a habit counter. Press Enter or hold the orb and speak.",
      id: nextId(),
    }]);
    localStorage.setItem("loom.firstGreeting", "1");
  }, []);

  // Cleanup: settle all pending reviews on unmount, cancel idle timer, dispatch idle
  useEffect(() => {
    const resolvers = reviewResolvers.current;
    return () => {
      resolvers.forEach((resolve) => resolve(false));
      resolvers.clear();
      clearIdleTimer();
      dispatchMood("idle");
    };
  }, []);

  const eyebrowStyle: React.CSSProperties = {
    fontFamily: "var(--f-mono)",
    color: "var(--t3)",
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: ".08em",
  };

  return (
    <section
      style={{
        padding: "16px 20px",
        display: "flex",
        flexDirection: "column",
        gap: 0,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 16,
        }}
      >
        <div style={eyebrowStyle}>LOOM</div>
        <label
          style={{
            fontSize: 12,
            color: "var(--t2)",
            cursor: "pointer",
            userSelect: "none",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <input
            type="checkbox"
            checked={reviewOn}
            onChange={toggleReview}
            style={{ accentColor: "var(--accent)" }}
          />
          Review code before saving
        </label>
      </div>

      {/* Conversation — scrolls within its own container */}
      <div
        ref={convoRef}
        data-testid="companion-log"
        style={{
          display: "flex",
          flexDirection: "column",
          minHeight: items.length === 0 ? 0 : 40,
          maxHeight: 480,
          overflowY: "auto",
          marginBottom: items.length > 0 ? 16 : 0,
        }}
      >
        <AnimatePresence initial={false}>
        {items.map((item) => {
          if (item.kind === "bubble") {
            return (
              <motion.div
                key={item.id}
                initial={rm ? undefined : { opacity: 0, y: 8 }}
                animate={rm ? undefined : { opacity: 1, y: 0 }}
                transition={rm ? undefined : { type: "spring", stiffness: 400, damping: 30 }}
              >
                {item.role === "user" ? (
                  <UserBubble text={item.text} />
                ) : (
                  <AssistantBubble text={item.text} />
                )}
              </motion.div>
            );
          }
          if (item.kind === "event-log") {
            if (item.events.length === 0) return null;
            return <EventLog key={item.id} events={item.events} />;
          }
          if (item.kind === "success") {
            return <SuccessCardView key={item.id} item={item} />;
          }
          if (item.kind === "failure") {
            return (
              <FailureCardView
                key={item.id}
                item={item}
                onRetry={handleRetry}
              />
            );
          }
          if (item.kind === "review") {
            return (
              <ReviewCardView
                key={item.id}
                item={item}
                onSettle={settleReview}
              />
            );
          }
          return null;
        })}
        </AnimatePresence>
      </div>

      {/* Input */}
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Talk to LOOM — ask, or ask it to build or change an organ"
        rows={3}
        disabled={busy}
        onFocus={() => setTextareaFocused(true)}
        onBlur={() => setTextareaFocused(false)}
        style={{
          width: "100%",
          boxSizing: "border-box",
          background: busy ? "rgba(255,255,255,0.02)" : "rgba(255,255,255,0.04)",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 4,
          color: busy ? "var(--t3)" : "var(--t1)",
          fontFamily: "var(--f-mono)",
          fontSize: 13,
          padding: "8px 10px",
          resize: "vertical",
          outline: "none",
          cursor: busy ? "not-allowed" : "text",
          transition: "background 0.15s, box-shadow 0.15s",
          boxShadow: textareaFocused && !rm ? "0 0 0 1.5px var(--accent)" : "none",
        }}
      />
    </section>
  );
}
