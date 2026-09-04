/**
 * KernelDiff.tsx — the third wall, made visible: the diff-review card.
 *
 * This is the surface where LOOM asks to change ITSELF. It appears ONLY after
 * a self-edit passed tsc + vitest in isolation (the pipeline dispatches
 * `loom-kernel-review` with a validated proposal). The owner sees the real
 * unified diff and the exact file(s) it touches, then Approves or Discards.
 *
 * The walls, made structural here:
 *   - Approve → applyKernelEdit (the ONLY live-tree write) → close. For a TS
 *     edit HMR hot-reloads and a calm "changed — reloading" note lands; for a
 *     RUST-CORE edit (src-tauri/…​.rs) there is NO hot-reload — the note reads
 *     "changed — restart LOOM to load the core," because tauri dev compiled the
 *     binary once and does not watch src-tauri/. The card makes that weight
 *     honest up front (a core banner + "restart to take effect").
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
import {
  kernelApply,
  kernelApprove,
  kernelDiscard,
  kernelIdentity,
  type Identity,
  type KernelApplied,
} from "../../lib/core";
import { applyKernelEdit, discardKernelEdit } from "../../lib/loom/kernelBuild";
import { startReweave } from "../../lib/loom/reweave";

/** z 2000 — the permission-modal tier: the only surfaces allowed to block. */
const KERNEL_DIFF_Z = 2000;

/** The proposal the pipeline hands to the card (validated, not yet applied). */
export type KernelReviewProposal = {
  worktreeId: string;
  diff: string;
  targetPaths: string[];
  /** the owner's original request — becomes the `self:` commit message body */
  request: string;
  /**
   * True when this edit touches LOOM's Rust core (src-tauri/…​.rs). The core does
   * NOT hot-reload: approving commits it, but it takes effect only after a
   * RESTART. The card reads this to make the weight honest — "editing the core,"
   * "restart to load" — instead of the TS "reloading." The pipeline sets it, but
   * the card also derives it defensively from targetPaths so the framing can
   * never be silently downgraded.
   */
  isCore?: boolean;
};

/** True when any target path is a Rust-core file (src-tauri/…​.rs). */
function pathsTouchCore(paths: string[]): boolean {
  return paths.some((p) => p.startsWith("src-tauri/") && p.endsWith(".rs"));
}

/**
 * Is this the CORE? Trust the pipeline's flag, but never let it downgrade the
 * framing below what the target paths themselves imply — a Rust-core path
 * always reads as the heavier framing.
 */
function coreOf(p: KernelReviewProposal): boolean {
  return p.isCore === true || pathsTouchCore(p.targetPaths);
}

/**
 * Injectable kernel surface (defaults to the real wrappers). Tests pass mocks
 * so no Tauri round-trip is needed and Approve/Discard can be asserted.
 */
export type KernelDiffApi = {
  approve: (worktreeId: string) => Promise<void>;
  apply: (worktreeId: string, message: string) => Promise<KernelApplied>;
  discard: (worktreeId: string) => Promise<void>;
};

const DEFAULT_API: KernelDiffApi = {
  approve: (worktreeId) => kernelApprove(worktreeId),
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

/**
 * What the card reports after an apply (Phase 23): the shell reads `mode` to
 * decide whether `kernel.autoReweave` should start the weave on its own.
 */
export type KernelAppliedInfo = { mode: Identity["mode"]; isCore: boolean; sha: string };

export type KernelDiffProps = {
  api?: KernelDiffApi;
  /** Who this binary is — defaults to `kernelIdentity`; unreachable → dev framing. */
  identity?: () => Promise<Identity>;
  /** The REWEAVE seam — defaults to the protected `startReweave`. */
  reweave?: () => Promise<unknown>;
  /** Fires once per successful apply, after the note lands. */
  onApplied?: (info: KernelAppliedInfo) => void;
};

export default function KernelDiff({
  api = DEFAULT_API,
  identity = kernelIdentity,
  reweave = () => startReweave(),
  onApplied,
}: KernelDiffProps) {
  const rm = useReducedMotion() ?? false;
  const [proposal, setProposal] = useState<KernelReviewProposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState(false);
  // Packaged mode (Phase 23): nothing hot-reloads — a TS edit is bundled into
  // dist and a Rust edit into the binary, so every applied edit is "woven into
  // source" until a reweave. Unreachable identity (browser dev) reads as dev.
  const [mode, setMode] = useState<Identity["mode"]>("dev");

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const id = await identity();
        if (live && id && (id.mode === "packaged" || id.mode === "dev")) setMode(id.mode);
      } catch {
        // no shell — the dev framing stands.
      }
    })();
    return () => {
      live = false;
    };
  }, [identity]);

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
      const result = await applyKernelEdit(proposal.worktreeId, message, api.apply, api.approve);
      // The change is committed to the live tree. In dev Vite HMR hot-reloads
      // it — show the calm note briefly, then close. In packaged mode nothing
      // reloads: the note offers REWEAVE and the card waits for the owner.
      setApplied(true);
      if (mode === "packaged") setBusy(false);
      else setTimeout(reset, 2400);
      onApplied?.({ mode, isCore: coreOf(proposal), sha: result?.sha ?? "" });
    } catch {
      // A late apply failure (approve set the flags but apply threw). The live
      // tree was NOT written (apply_inner runs after the gate), but the isolated
      // worktree is still registered — discard it so no orphan survives, then
      // close honestly.
      try {
        await discardKernelEdit(proposal.worktreeId, api.discard);
      } catch {
        // best-effort — the OS temp dir is reclaimed on process exit
      }
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

  // Is this the CORE? Trust the pipeline's flag, but never let it downgrade the
  // framing below what the target paths themselves imply — a Rust-core path
  // always reads as the heavier "restart to load," never the TS "reloading."
  const isCore = proposal ? coreOf(proposal) : false;
  const packaged = mode === "packaged";

  async function reweaveNow() {
    if (busy) return;
    setBusy(true);
    try {
      await reweave();
    } catch {
      // the reweave card or Settings will say why — this card only asked.
    }
    reset();
  }

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
              {isCore ? "self-edit — the core" : "self-edit — the walls"}
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
              {isCore ? "LOOM WANTS TO CHANGE ITS CORE" : "LOOM WANTS TO CHANGE ITSELF"}
            </div>

            {/* Core signifier — a Rust edit reaches the native binary and does
                NOT hot-reload; approving it needs a restart to take effect. */}
            {isCore && (
              <div
                data-testid="kernel-diff-core-banner"
                style={{
                  fontSize: 12.5,
                  color: "var(--warn)",
                  background: "rgba(251,191,36,0.08)",
                  border: "1px solid rgba(251,191,36,0.28)",
                  borderRadius: 8,
                  padding: "8px 10px",
                  marginBottom: 12,
                  lineHeight: 1.5,
                }}
              >
                {packaged
                  ? "this edits the RUST CORE — the native binary LOOM runs inside. approving weaves it into the source; LOOM becomes it only after a REWEAVE you approve, which closes LOOM and returns it."
                  : "this edits the RUST CORE — the native binary LOOM runs inside. it does not hot-reload: approving commits it, but it takes effect only after you RESTART LOOM."}
              </div>
            )}

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
              {packaged
                ? isCore
                  ? "this edit was compiled and tested in isolation (cargo check + test) — the source is untouched until you approve. approving weaves it into the source; reweave to become it."
                  : "this edit was type-checked and tested in isolation — the source is untouched until you approve. approving weaves it into the source; reweave to become it."
                : isCore
                  ? "this edit was compiled and tested in isolation (cargo check + test) — the live tree is untouched until you approve. approving commits it; restart LOOM to load the core."
                  : "this edit was type-checked and tested in isolation — the live tree is untouched until you approve. approving commits it and reloads."}
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

            {/* Applied note — TS hot-reloads; the CORE needs a restart to load. */}
            {applied && (
              <div
                data-testid="kernel-diff-applied"
                style={{ color: "var(--go)", fontSize: 13, marginTop: 12, fontWeight: 600 }}
              >
                {packaged
                  ? "woven into source — reweave to become it"
                  : isCore
                    ? "changed — restart LOOM to load the core."
                    : "changed — reloading."}
              </div>
            )}

            {/* Packaged (Phase 23): the edit is in the genome, not the body.
                REWEAVE starts the build job; the reweave card takes over. */}
            {applied && packaged && (
              <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
                <button
                  data-testid="kernel-diff-reweave"
                  onClick={reweaveNow}
                  disabled={busy}
                  style={{
                    background: "var(--accent)",
                    color: "var(--bg)",
                    border: "none",
                    borderRadius: 6,
                    padding: "8px 20px",
                    fontFamily: "var(--f-mono)",
                    fontSize: 11,
                    letterSpacing: ".14em",
                    textTransform: "uppercase",
                    fontWeight: 700,
                    cursor: busy ? "not-allowed" : "pointer",
                    opacity: busy ? 0.6 : 1,
                  }}
                >
                  REWEAVE
                </button>
                <button
                  data-testid="kernel-diff-later"
                  onClick={reset}
                  disabled={busy}
                  style={{
                    background: "none",
                    color: "var(--t3)",
                    border: "none",
                    borderRadius: 6,
                    padding: "8px 12px",
                    fontSize: 13,
                    cursor: busy ? "not-allowed" : "pointer",
                  }}
                >
                  later
                </button>
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
