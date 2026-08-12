import { useEffect, useRef, useState } from "react";
import { fleetChat, organWrite, organRead, organList, type OrganFile, type Msg } from "../lib/core";
import { gate } from "../lib/loom/validate";
import { buildOrgan, type BuildEvent } from "../lib/loom/build";
import { editOrgan } from "../lib/companion/editOrgan";
import { handle, type CompanionTurn } from "../lib/companion/runtime";
import { turnStartMood, firstEventMood, settleMood, dispatchMood } from "../lib/orb/moods";

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
          color: "var(--t1)",
          fontSize: 14,
          lineHeight: 1.5,
          borderRadius: 10,
          background: "rgba(255,255,255,0.05)",
          border: "1px solid rgba(255,255,255,0.08)",
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
          color: "var(--t1)",
          fontSize: 14,
          lineHeight: 1.5,
          borderRadius: 10,
          flex: 1,
        }}
      >
        {text}
      </div>
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
      <div
        ref={logRef}
        style={{
          ...monoSmall,
          flex: 1,
          maxHeight: 180,
          overflowY: "auto",
          color: "var(--t2)",
          background: "rgba(0,0,0,0.25)",
          borderRadius: 4,
          padding: "8px 10px",
        }}
      >
        {events.map((e, i) => (
          <div key={i} style={{ padding: "1px 0" }}>
            <span style={{ color: "var(--t3)" }}>[{e.phase}]</span>{" "}
            <span>{e.detail}</span>
          </div>
        ))}
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
        <div style={{ color: "var(--go)", fontWeight: 600, marginBottom: 4 }}>
          {verb} {item.organId}
        </div>
        <div style={{ ...monoSmall, color: "var(--t3)", marginBottom: 6 }}>
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
        <div style={{ color: "var(--danger)", fontWeight: 600, marginBottom: 6 }}>
          Failed{item.stage ? ` — stage: ${item.stage}` : ""}
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

export default function Companion() {
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

  const bottomRef = useRef<HTMLDivElement | null>(null);

  function scrollToBottom() {
    requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView?.({ behavior: "smooth" });
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
    // "building" mood (only once per turn).
    function appendEventWithMood(e: BuildEvent) {
      if (firstEventMood(hasBuildingMood.current)) {
        hasBuildingMood.current = true;
      }
      appendEvent(e);
    }

    const deps = {
      chat: fleetChat,
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
      askModel: (p: string) =>
        fleetChat("rewriter", [{ role: "user", content: p }]),
    };

    let turn: CompanionTurn;
    try {
      turn = await handle(text, history.current, deps);
    } catch (err) {
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
        const oneliner = `${result.organId} is ready — approve it below.`;
        appendItem({ kind: "bubble", role: "assistant", text: oneliner, id: nextId() });
        // Do NOT push status string to history
      } else {
        appendItem({
          kind: "failure",
          stage: result.stage,
          error: result.error,
          utterance: text,
          id: nextId(),
        });
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
        const oneliner = `${result.organId} updated.`;
        appendItem({ kind: "bubble", role: "assistant", text: oneliner, id: nextId() });
        // Do NOT push status string to history
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
      // Do NOT push status string to history
    }

    // Mood: turn settled — speak, then go idle after 2500ms
    idleTimer.current = settleMood();

    setBusy(false);
  }

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

      {/* Conversation */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          minHeight: items.length === 0 ? 0 : 40,
          marginBottom: items.length > 0 ? 16 : 0,
        }}
      >
        {items.map((item) => {
          if (item.kind === "bubble") {
            return item.role === "user" ? (
              <UserBubble key={item.id} text={item.text} />
            ) : (
              <AssistantBubble key={item.id} text={item.text} />
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
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Talk to LOOM — ask, or ask it to build or change an organ"
        rows={3}
        disabled={busy}
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
          transition: "background 0.15s",
        }}
      />
    </section>
  );
}
