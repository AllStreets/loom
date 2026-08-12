import { useRef, useState } from "react";
import { fleetChat, organWrite, type OrganFile } from "../lib/core";
import { gate } from "../lib/loom/validate";
import { buildOrgan, isBusy, type BuildEvent, type BuildResult } from "../lib/loom/build";

export default function LoomConsole() {
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState(false);
  const [events, setEvents] = useState<BuildEvent[]>([]);
  const [result, setResult] = useState<BuildResult | null>(null);
  const [reviewOn, setReviewOn] = useState(() => localStorage.getItem("loom.reviewBeforeSave") === "1");
  const [reviewFiles, setReviewFiles] = useState<OrganFile[] | null>(null);
  const reviewResolve = useRef<((approved: boolean) => void) | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  function toggleReview() {
    setReviewOn((v) => {
      localStorage.setItem("loom.reviewBeforeSave", v ? "0" : "1");
      return !v;
    });
  }

  function requestReview(files: OrganFile[]): Promise<boolean> {
    return new Promise((resolve) => {
      reviewResolve.current = resolve;
      setReviewFiles(files);
    });
  }

  function settleReview(approved: boolean) {
    reviewResolve.current?.(approved);
    reviewResolve.current = null;
    setReviewFiles(null);
  }

  function appendEvent(e: BuildEvent) {
    setEvents((prev) => {
      const next = [...prev, e];
      // scroll to bottom after paint
      requestAnimationFrame(() => {
        if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
      });
      return next;
    });
  }

  async function handleBuild() {
    if (isBusy() || !request.trim()) return;
    setBusy(true);
    setEvents([]);
    setResult(null);
    try {
      const r = await buildOrgan(request.trim(), {
        chat: fleetChat,
        write: organWrite,
        gate,
        onEvent: appendEvent,
        ...(reviewOn ? { review: requestReview } : {}),
      });
      setResult(r);
      if (r.ok) {
        window.dispatchEvent(new CustomEvent("organs-changed"));
      }
    } finally {
      setBusy(false);
    }
  }

  function handleRetry() {
    setResult(null);
    setEvents([]);
    handleBuild();
  }

  const panelStyle: React.CSSProperties = {
    background: "var(--panel)",
    border: "1px solid rgba(255,255,255,0.06)",
    borderRadius: 8,
    padding: "16px 20px",
    marginTop: 20,
    maxWidth: 640,
  };

  const eyebrowStyle: React.CSSProperties = {
    fontFamily: "var(--f-mono)",
    color: "var(--t3)",
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: ".08em",
    marginBottom: 12,
  };

  return (
    <section style={panelStyle}>
      <div style={eyebrowStyle}>The Loom</div>
      <textarea
        value={request}
        onChange={(e) => setRequest(e.target.value)}
        onKeyDown={(e) => {
          // Enter submits; Shift+Enter inserts a newline
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleBuild();
          }
        }}
        placeholder="Describe what LOOM should build for itself"
        rows={3}
        style={{
          width: "100%",
          boxSizing: "border-box",
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 4,
          color: "var(--t1)",
          fontFamily: "var(--f-mono)",
          fontSize: 13,
          padding: "8px 10px",
          resize: "vertical",
          outline: "none",
          marginBottom: 10,
        }}
        disabled={busy}
      />
      <button
        onClick={handleBuild}
        disabled={busy || !request.trim()}
        style={{
          background: busy || !request.trim() ? "rgba(255,255,255,0.08)" : "var(--accent)",
          color: busy || !request.trim() ? "var(--t3)" : "#000",
          border: "none",
          borderRadius: 4,
          padding: "6px 18px",
          fontWeight: 600,
          cursor: busy || !request.trim() ? "not-allowed" : "pointer",
          fontSize: 13,
          transition: "background 0.15s",
        }}
      >
        Build
      </button>
      <label
        style={{
          marginLeft: 14,
          fontSize: 12,
          color: "var(--t2)",
          cursor: "pointer",
          userSelect: "none",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <input type="checkbox" checked={reviewOn} onChange={toggleReview} style={{ accentColor: "var(--accent)" }} />
        Review code before saving
      </label>

      {reviewFiles && (
        <div
          style={{
            marginTop: 14,
            background: "var(--accent-soft)",
            border: "1px solid rgba(34,211,238,0.3)",
            borderRadius: 6,
            padding: "12px 14px",
          }}
        >
          <div style={{ color: "var(--accent)", fontWeight: 600, marginBottom: 8 }}>
            Review — validated, not yet saved
          </div>
          {reviewFiles.map((f) => (
            <details key={f.name} style={{ marginBottom: 6 }}>
              <summary style={{ fontFamily: "var(--f-mono)", fontSize: 12, color: "var(--t1)", cursor: "pointer" }}>
                {f.name} <span style={{ color: "var(--t3)" }}>({f.content.length} chars)</span>
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
              onClick={() => settleReview(true)}
              style={{
                background: "var(--accent)", color: "#04222b", border: "none", borderRadius: 4,
                padding: "5px 14px", fontWeight: 600, cursor: "pointer", fontSize: 12,
              }}
            >
              Apply and save
            </button>
            <button
              onClick={() => settleReview(false)}
              style={{
                background: "rgba(255,255,255,0.08)", color: "var(--t1)",
                border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4,
                padding: "5px 14px", fontWeight: 600, cursor: "pointer", fontSize: 12,
              }}
            >
              Discard
            </button>
          </div>
        </div>
      )}

      {events.length > 0 && (
        <div
          ref={logRef}
          style={{
            marginTop: 14,
            maxHeight: 180,
            overflowY: "auto",
            fontFamily: "var(--f-mono)",
            fontSize: 12,
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
      )}

      {result && result.ok && (
        <div
          style={{
            marginTop: 14,
            background: "rgba(0,200,100,0.07)",
            border: "1px solid rgba(0,200,100,0.2)",
            borderRadius: 6,
            padding: "12px 14px",
          }}
        >
          <div style={{ color: "var(--go)", fontWeight: 600, marginBottom: 4 }}>
            Built successfully
          </div>
          <div style={{ fontFamily: "var(--f-mono)", fontSize: 12, color: "var(--t2)", marginBottom: 2 }}>
            organ: {result.organId}
          </div>
          <div style={{ fontFamily: "var(--f-mono)", fontSize: 12, color: "var(--t3)", marginBottom: 8 }}>
            sha: {result.sha}
          </div>
          <div style={{ fontSize: 13, color: "var(--t2)" }}>
            Approve it below to run it.
          </div>
        </div>
      )}

      {result && !result.ok && (
        <div
          style={{
            marginTop: 14,
            background: "rgba(220,50,50,0.07)",
            border: "1px solid rgba(220,50,50,0.2)",
            borderRadius: 6,
            padding: "12px 14px",
          }}
        >
          <div style={{ color: "var(--danger)", fontWeight: 600, marginBottom: 6 }}>
            Build failed{result.stage ? ` — stage: ${result.stage}` : ""}
          </div>
          <div
            style={{
              fontFamily: "var(--f-mono)",
              fontSize: 12,
              color: "var(--t2)",
              marginBottom: 10,
              wordBreak: "break-word",
            }}
          >
            {result.error}
          </div>
          <button
            onClick={handleRetry}
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
      )}
    </section>
  );
}
