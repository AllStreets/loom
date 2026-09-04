import { invoke } from "@tauri-apps/api/core";
import { getSetting } from "./voice/settings";

// ── Shell availability ─────────────────────────────────────────────────────────

export class ShellUnavailableError extends Error {
  constructor() {
    super("This surface needs the desktop shell.");
    this.name = "ShellUnavailableError";
  }
}

function isTauriAvailable(): boolean {
  return typeof window !== "undefined" &&
    // @tauri-apps/api v2 uses __TAURI_INTERNALS__; v1 used __TAURI__
    (
      "__TAURI_INTERNALS__" in window ||
      "__TAURI__" in window
    );
}

async function safeInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriAvailable()) {
    return Promise.reject(new ShellUnavailableError());
  }
  // Pass args only when provided — avoids changing the call signature for
  // no-arg commands (which tests assert via toHaveBeenCalledWith(cmd) only).
  return args !== undefined ? invoke<T>(cmd, args) : invoke<T>(cmd);
}

// ── Voice types ────────────────────────────────────────────────────────────────

export type VoicePresence = { id: string; label: string; present: boolean };
export type VoiceStatus = {
  ready: boolean;
  whisper: boolean;
  voices: VoicePresence[];
  missing_bytes_hint: string | null;
};

export type RoleStatus = { role: string; model: string; present: boolean };
export type Msg = { role: "system" | "user" | "assistant"; content: string };
export type Commit = { sha: string; message: string };

export type ChatOpts = { numCtx?: number; temperature?: number };
export type ModelOverrides = { builder?: string; companion?: string; rewriter?: string };

/** Rust-side defaults, mirrored here as a single source of truth for the UI. */
export const FLEET_DEFAULTS = {
  builder: "qwen3-coder:30b-a3b-q4_K_M",
  companion: "gpt-oss:20b",
  rewriter: "qwen3:1.7b",
} as const;

/**
 * Read model.* settings and build an overrides object, omitting empty values.
 * Empty = unset = Rust will use its own default.
 */
export function modelOverrides(): ModelOverrides {
  const result: ModelOverrides = {};
  const builder = getSetting("model.builder");
  const companion = getSetting("model.companion");
  const rewriter = getSetting("model.rewriter");
  if (builder) result.builder = builder;
  if (companion) result.companion = companion;
  if (rewriter) result.rewriter = rewriter;
  return result;
}

export const fleetStatus = () =>
  safeInvoke<RoleStatus[]>("fleet_status", { overrides: modelOverrides() });

export const fleetChat = (role: string, messages: Msg[], opts?: ChatOpts) =>
  safeInvoke<string>("fleet_chat", {
    role, messages,
    opts: opts ? { num_ctx: opts.numCtx ?? null, temperature: opts.temperature ?? null } : null,
    overrides: modelOverrides(),
  });

export const timelineInit = () => safeInvoke<void>("timeline_init");
export const timelineCommit = (message: string) => safeInvoke<string>("timeline_commit", { message });
export const timelineLog = (limit = 20) => safeInvoke<Commit[]>("timeline_log", { limit });
export const timelineRollback = (sha: string) => safeInvoke<void>("timeline_rollback", { sha });

export type OrganFile = { name: string; content: string };
export type OrganEntry = { id: string; manifest: string; granted: string | null };

export const organWrite = (id: string, files: OrganFile[], message: string) =>
  safeInvoke<string>("organ_write", { id, files, message });
export const organList = () => safeInvoke<OrganEntry[]>("organ_list");
export const organRead = (id: string, name: string) => safeInvoke<string>("organ_read", { id, name });
export const organGrant = (id: string, grantedJson: string) =>
  safeInvoke<string>("organ_grant", { id, grantedJson });
export const organDelete = (id: string) => safeInvoke<string>("organ_delete", { id });

// ── Kernel self-edit wrappers (Phase 21 — the safety core) ──────────────────────
//
// These drive LOOM editing its own TypeScript kernel behind the five walls.
// The live source tree is NEVER written until validate passes in an isolated
// worktree AND the owner approves (approval is enforced by the Task-2 pipeline;
// kernelApply is the ONLY wrapper that touches the live tree).
//
// `sourceRepo` is an optional dev override (Rust falls back to the process cwd
// and asserts it's a git work dir). It maps to the Rust `source_repo` arg.

export type KernelEdit = { path: string; search: string; replace: string };
export type EditableMeta = { root: string; protected: string[] };
export type KernelProposal = { worktreeId: string; diff: string };
export type KernelValidation = {
  ok: boolean;
  stage: "tsc" | "vitest" | "cargo-check" | "cargo-test" | "ok";
  output: string;
};
export type KernelApplied = { sha: string; prevSha: string };
export type KernelBootCheck = { rolledBackTo: string | null; rollbackFailed: boolean };

/** Meta for the UI/prompt: resolved source-repo root + the protected carve-out. */
export const kernelEditable = (sourceRepo?: string) =>
  safeInvoke<EditableMeta>("kernel_editable", { sourceRepo: sourceRepo ?? null });

/** Read an editable kernel file's current contents (rejected for protected paths). */
export const kernelRead = (path: string, sourceRepo?: string) =>
  safeInvoke<string>("kernel_read", { path, sourceRepo: sourceRepo ?? null });

/** Isolate: create a worktree, apply the edits there, return the unified diff. */
export const kernelPropose = (edits: KernelEdit[], sourceRepo?: string) =>
  safeInvoke<KernelProposal>("kernel_propose", { edits, sourceRepo: sourceRepo ?? null });

/**
 * Validate in the worktree; first failure wins. TS edits → tsc then vitest;
 * Rust edits → cargo check then cargo test (minutes, not seconds); a mixed edit
 * set runs both. The stage names the first failing wall.
 */
export const kernelValidate = (worktreeId: string) =>
  safeInvoke<KernelValidation>("kernel_validate", { worktreeId });

/**
 * Approve a validated proposal (the explicit gate the KernelDiff "approve the
 * change" button triggers). Rust refuses this unless the proposal has already
 * passed validation, and refuses kernel_apply unless BOTH validated AND
 * approved are true — so the wall ordering is structural in Rust, not just here.
 */
export const kernelApprove = (worktreeId: string) =>
  safeInvoke<void>("kernel_approve", { worktreeId });

/** Commit: apply the validated patch to the LIVE tree + commit + write sentinel. */
export const kernelApply = (worktreeId: string, message: string) =>
  safeInvoke<KernelApplied>("kernel_apply", { worktreeId, message });

/** Discard a proposal and remove its worktree (no live-tree effect). */
export const kernelDiscard = (worktreeId: string) =>
  safeInvoke<void>("kernel_discard", { worktreeId });

/** Hard-reset the source repo to a sha. */
export const kernelRollback = (sha: string, sourceRepo?: string) =>
  safeInvoke<void>("kernel_rollback", { sha, sourceRepo: sourceRepo ?? null });

/** Confirm a good boot after an edit → clears the pending sentinel. */
export const kernelBootOk = () => safeInvoke<void>("kernel_boot_ok");

/** Startup guard: if a prior edit never confirmed, rolls back and reports the sha. */
export const kernelBootCheck = (sourceRepo?: string) =>
  safeInvoke<KernelBootCheck>("kernel_boot_check", { sourceRepo: sourceRepo ?? null });

// ── Identity (Phase 23 — Rebirth) ──────────────────────────────────────────────

/**
 * Who this binary is: `dev` (tauri dev owns the binary; source is the cwd) or
 * `packaged` (a built app; source is `loomhome/source`). `genomeSha` is the
 * sha the binary was woven from (`unknown` outside a repo); `generation` is
 * the ledger's current sha, null before the first reweave.
 */
export type Identity = {
  mode: "dev" | "packaged";
  genomeSha: string;
  generation: string | null;
  threaded: boolean;
  loomhome: string;
};

/** Read by the Settings organ and the Shuttle ("which generation is this"). */
export const kernelIdentity = () => safeInvoke<Identity>("kernel_identity");

// ── Voice wrappers ─────────────────────────────────────────────────────────────

export const voiceStatus = () => safeInvoke<VoiceStatus>("voice_status");
export const voiceSetup = () => safeInvoke<void>("voice_setup");
export const sttTranscribe = (samples: number[]) =>
  safeInvoke<string>("stt_transcribe", { samples });
export const ttsSpeak = (text: string, voiceId: string) =>
  safeInvoke<number[]>("tts_speak", { text, voiceId });

// ── builderChat — the single builder-role seam ─────────────────────────────────
//
// This is the ONLY entry point for builder-role model calls. There is one
// brain: the local fleet. Companion/rewriter roles call fleetChat directly.

export async function builderChat(messages: Msg[], opts?: ChatOpts): Promise<string> {
  return fleetChat("builder", messages, opts);
}

// ── Generations (Phase 23 — Rebirth) ───────────────────────────────────────────

/**
 * One woven body on the shelf: the ledger's row plus the genome's memory of
 * the commit it came from (`commitSubject` is `"unknown"` when the genome or
 * the commit is missing). `isCurrent` is the running body; `isPrevious` is the
 * one the warden returns to.
 */
export type Generation = {
  sha: string;
  wovenAt: string;
  sizeBytes: number;
  reason: string;
  commitSubject: string;
  isCurrent: boolean;
  isPrevious: boolean;
};

/** Every kept generation, newest first. Read by Settings → LOOM and the Shuttle. */
export const generationsList = () => safeInvoke<Generation[]>("generations_list");
// ── Threading (Phase 23 — Rebirth) ─────────────────────────────────────────────

/** One tool from the threads table: where it is, which version answered, and
 *  the exact install line if it is missing. `version` is `"present"` for a
 *  tool with no `--version` (codesign). */
export type Tool = {
  name: string;
  path: string | null;
  version: string | null;
  requiredFor: string;
  install: string;
};

export type ThreadSteps = {
  seed: boolean;
  deps: boolean;
  vendor: boolean;
  warm: boolean;
  register: boolean;
};

/**
 * What the threading card reads. `missing` = not found now; `drifted` = a
 * recorded tool whose path is gone or whose version changed; `needsNetwork`
 * = deps or vendor have not completed (the only steps that touch the net).
 */
export type ThreadStatus = {
  threaded: boolean;
  tools: Tool[];
  missing: string[];
  drifted: string[];
  steps: ThreadSteps;
  needsNetwork: boolean;
};

/** Discover the machine's tools now and compare with `threads.json`. */
export const threadStatus = () => safeInvoke<ThreadStatus>("thread_status");

// ── Reweave (Phase 23 — Rebirth) ───────────────────────────────────────────────

/**
 * The build job's state as Rust persists it to `reweave.json` and emits it on
 * `loom-reweave`. `tail` is the last ≤ 400 lines of the current tool; `outcome`
 * is the calm sentence for `done`/`failed`/`cancelled`; `cancellable` goes
 * false at the point of return (swap). Same shape in dev and packaged mode.
 */
export type ReweaveState = {
  stage: "idle" | "assets" | "core" | "stage" | "swap" | "relaunch" | "done" | "failed" | "cancelled";
  targetSha: string | null;
  startedAt: string | null;
  elapsedMs: number;
  tail: string[];
  outcome: string | null;
  cancellable: boolean;
  mode: "dev" | "packaged";
};

/** Start the job. `force` weaves even when the genome matches the body. */
export const reweaveStart = (force = false) => safeInvoke<void>("reweave_start", { force });
/** Kill the job tree — refused past the point of return. */
export const reweaveCancel = () => safeInvoke<void>("reweave_cancel");
/** The persisted state, for the initial paint before events arrive. */
export const reweaveState = () => safeInvoke<ReweaveState>("reweave_state");
/** Return to a kept generation: the same job with the build stages skipped. */
export const generationsReturn = (sha: string) => safeInvoke<void>("generations_return", { sha });
