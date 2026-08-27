/**
 * KernelDiff.tsx — the third wall, made visible: the diff-review card.
 *
 * This is the surface where LOOM asks to change ITSELF. It appears ONLY after
 * a self-edit passed tsc + vitest in isolation (the pipeline dispatches
 * `loom-kernel-review` with a validated proposal). The owner sees the real
 * unified diff and the exact file(s) it touches, then Approves or Discards.
 *
 * The walls, made structural here:
 *   - Approve → applyKernelEdit (the ONLY live-tree write) → close. HMR
 *     hot-reloads the changed kernel; a calm "changed — reloading" note lands.
 *   - Discard → discardKernelEdit (worktree removed) → close.
 * The card never proposes or validates; it only shows an already-validated
 * proposal and carries the owner's decision to apply or discard. No apply is
 * possible without this card having received a validated proposal AND the
 * owner clicking Approve.
 *
 * Weighty, not casual: BRAND voice header ("LOOM WANTS TO CHANGE ITSELF"), the
 * danger-tinted eyebrow, the target path(s), monospace diff with added/removed
 * tinting via tokens (--go / --danger). Glass modal, z/AnimatePresence/reduced-
 * motion mirror the permission modal (Desktop.tsx).
 */

import { useEffect, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { kernelApply, kernelDiscard, type KernelApplied } from "../../lib/core";
import { applyKernelEdit, discardKernelEdit } from "../../lib/loom/kernelBuild";

/** z 2000 — the permission-modal tier: the only surfaces allowed to block. */
const KERNEL_DIFF_Z = 2000;

/** The proposal the pipeline hands to the card (validated, not yet applied). */
export type KernelReviewProposal = {
  worktreeId: string;
  diff: string;
  targetPaths: string[];
  /** the owner's original request — becomes the `self:` commit message body */
  request: string;
};

/**
 * Injectable kernel surface (defaults to the real wrappers). Tests pass mocks
 * so no Tauri round-trip is needed and Approve/Discard can be asserted.
 */
export type KernelDiffApi = {
  apply: (worktreeId: string, message: string) => Promise<KernelApplied>;
  discard: (worktreeId: string) => Promise<void>;
};

const DEFAULT_API: KernelDiffApi = {
  apply: (worktreeId, message) => kernelApply(worktreeId, message),
  discard: (worktreeId) => kernelDiscard(worktreeId),
};

type DiffLineKind = "add" | "del" | "hunk" | "meta" | "ctx";

function classifyLine(line: string): DiffLineKind {
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

/** Per-line color + background tint, all from tokens (no raw hex). */
function lineStyle(kind: DiffLineKind): React.CSSProperties {
  switch (kind) {
    case "add":
      return { color: "var(--go)", background: "rgba(74,222,128,0.08)" };
    case "del":
      return { color: "var(--danger)", background: "rgba(248,113,113,0.08)" };
    case "hunk":
      return { color: "var(--accent)" };
    case "meta":
      return { color: "var(--t3)" };
    default:
      return { color: "var(--t2)" };
  }
}

export default function KernelDiff({ api = DEFAULT_API }: { api?: KernelDiffApi }) {
  const rm = useReducedMotion() ?? false;
  const [proposal, setProposal] = useState<KernelReviewProposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState(false);

  useEffect(() => {
    function onReview(ev: Event) {
      const detail = (ev as CustomEvent<{ proposal?: KernelReviewProposal }>).detail;
      const p = detail?.proposal;
      if (!p || typeof p.worktreeId !== "string" || typeof p.diff !== "string") return;
      // Only one card at a time — a live review ignores further proposals.
      setProposal((prev) => prev ?? p);
    }
    window.addEventListener("loom-kernel-review", onReview);
    return () => window.removeEventListener("loom-kernel-review", onReview);
  }, []);

  function reset() {
    setProposal(null);
    setBusy(false);
    setApplied(false);
  }

  async function approve() {
    if (!proposal || busy) return;
    setBusy(true);
    try {
      const message = proposal.request.slice(0, 72);
      await applyKernelEdit(proposal.worktreeId, message, api.apply);
      // The change is committed to the live tree; Vite HMR hot-reloads it.
      // Show the calm note briefly, then close.
      setApplied(true);
      setTimeout(reset, 2400);
    } catch {
      // A late apply failure (worktree vanished, etc.) — close honestly.
      reset();
    }
  }

  async function discard() {
    if (!proposal || busy) return;
    setBusy(true);
    try {
      await discardKernelEdit(proposal.worktreeId, api.discard);
    } catch {
      // best-effort cleanup — close regardless
    }
    reset();
  }

  const diffLines = proposal ? proposal.diff.replace(/\n$/, "").split("\n") : [];

  return (
    <AnimatePresence>
      {proposal && (
        <div
          data-testid="kernel-diff-overlay"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: KERNEL_DIFF_Z,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,.6)",
            pointerEvents: "auto",
          }}
        >
          <motion.div
            data-testid="kernel-diff-card"
            initial={rm ? false : { opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={rm ? undefined : { opacity: 0, scale: 0.96, y: 12 }}
            transition={rm ? {} : { type: "spring", stiffness: 400, damping: 30 }}
            style={{
              background: "var(--glass)",
              backdropFilter: "blur(var(--blur))",
              WebkitBackdropFilter: "blur(var(--blur))",
              // A hairline danger frame — this is the app editing itself.
              border: "1px solid rgba(248,113,113,0.4)",
              borderRadius: 14,
              padding: "22px 24px",
              width: "min(680px, 92vw)",
              maxHeight: "80vh",
              display: "flex",
              flexDirection: "column",
              position: "relative",
            }}
          >
            {/* Eyebrow — unmistakable that this edits LOOM itself. */}
            <div
              data-testid="kernel-diff-eyebrow"
              style={{
                fontFamily: "var(--f-mono)",
                fontSize: 10,
                letterSpacing: ".18em",
                textTransform: "uppercase",
                color: "var(--danger)",
                marginBottom: 6,
              }}
            >
              self-edit — the walls
            </div>

            {/* Header — BRAND voice, weighty. */}
            <div
              style={{
                fontWeight: 700,
                fontSize: 18,
                letterSpacing: ".01em",
                color: "var(--t1)",
                marginBottom: 10,
              }}
            >
              LOOM WANTS TO CHANGE ITSELF
            </div>

            {/* Target file(s) */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ color: "var(--t3)", fontSize: 12, marginBottom: 4 }}>
                it will edit:
              </div>
              {proposal.targetPaths.map((p) => (
                <div
                  key={p}
                  data-testid="kernel-diff-target"
                  style={{
                    fontFamily: "var(--f-mono)",
                    fontSize: 12,
                    color: "var(--accent)",
                    padding: "1px 0",
                    overflowWrap: "anywhere",
                  }}
                >
                  {p}
                </div>
              ))}
            </div>

            {/* Reassurance line — the walls it already passed. */}
            <div style={{ color: "var(--t2)", fontSize: 12.5, marginBottom: 12, lineHeight: 1.5 }}>
              this edit was type-checked and tested in isolation — the live tree
              is untouched until you approve. approving commits it and reloads.
            </div>

            {/* The diff — monospace, added/removed tinted via tokens. */}
            <pre
              data-testid="kernel-diff-body"
              style={{
                fontFamily: "var(--f-mono)",
                fontSize: 11.5,
                lineHeight: 1.55,
                margin: 0,
                background: "rgba(0,0,0,0.35)",
                borderRadius: 8,
                padding: "10px 12px",
                overflow: "auto",
                flex: 1,
                minHeight: 0,
                whiteSpace: "pre",
              }}
            >
              {diffLines.map((line, i) => {
                const kind = classifyLine(line);
                return (
                  <div
                    key={i}
                    data-diff-kind={kind}
                    style={{
                      ...lineStyle(kind),
                      padding: "0 4px",
                      overflowWrap: "anywhere",
                    }}
                  >
                    {line === "" ? " " : line}
                  </div>
                );
              })}
            </pre>

            {/* Applied note — HMR will hot-reload. */}
            {applied && (
              <div
                data-testid="kernel-diff-applied"
                style={{ color: "var(--go)", fontSize: 13, marginTop: 12, fontWeight: 600 }}
              >
                changed — reloading.
              </div>
            )}

            {/* Actions */}
            {!applied && (
              <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                <button
                  data-testid="kernel-diff-approve"
                  onClick={approve}
                  disabled={busy}
                  style={{
                    background: "var(--accent)",
                    color: "#04222b",
                    border: "none",
                    borderRadius: 6,
                    padding: "8px 20px",
                    fontWeight: 700,
                    fontSize: 13,
                    cursor: busy ? "not-allowed" : "pointer",
                    opacity: busy ? 0.6 : 1,
                  }}
                >
                  approve the change
                </button>
                <button
                  data-testid="kernel-diff-discard"
                  onClick={discard}
                  disabled={busy}
                  style={{
                    background: "rgba(255,255,255,.06)",
                    color: "var(--t2)",
                    border: "1px solid var(--glass-border)",
                    borderRadius: 6,
                    padding: "8px 20px",
                    fontSize: 13,
                    cursor: busy ? "not-allowed" : "pointer",
                    opacity: busy ? 0.6 : 1,
                  }}
                >
                  discard
                </button>
              </div>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
