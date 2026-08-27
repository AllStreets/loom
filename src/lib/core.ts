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

// ── Cloud builder types ────────────────────────────────────────────────────────

export type Brain = "local" | "cloud";
export type BuilderChatResult = { text: string; brain: Brain };

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
export type KernelValidation = { ok: boolean; stage: "tsc" | "vitest" | "ok"; output: string };
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

/** Validate: run tsc then targeted vitest in the worktree; first failure wins. */
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

// ── Voice wrappers ─────────────────────────────────────────────────────────────

export const voiceStatus = () => safeInvoke<VoiceStatus>("voice_status");
export const voiceSetup = () => safeInvoke<void>("voice_setup");
export const sttTranscribe = (samples: number[]) =>
  safeInvoke<string>("stt_transcribe", { samples });
export const ttsSpeak = (text: string, voiceId: string) =>
  safeInvoke<number[]>("tts_speak", { text, voiceId });

// ── Cloud builder wrappers ─────────────────────────────────────────────────────

export const cloudChat = (system: string, messages: Msg[], maxTokens?: number) =>
  safeInvoke<string>("cloud_chat", { system, messages, maxTokens: maxTokens ?? null });

export const cloudKeySet = (key: string) =>
  safeInvoke<void>("cloud_key_set", { key });

export const cloudKeyPresent = () =>
  safeInvoke<boolean>("cloud_key_present");

export const cloudKeyClear = () =>
  safeInvoke<void>("cloud_key_clear");

// ── Market engine (market.rs) ──────────────────────────────────────────────────
//
// Typed keyless sources: Yahoo chart (browser UA — the 429 fix), Coinbase
// Exchange, Frankfurter. Hosts hardcoded in Rust; inputs validated there.
// All shapes are serialized camelCase by market.rs.

/** Yahoo intraday chart, normalized. */
export type MarketChart = {
  symbol: string;
  name: string | null;
  price: number;
  prevClose: number;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  /** Intraday closes with epoch-second timestamps — same length, nulls dropped. */
  closes: number[];
  timestamps: number[];
};

/** Coinbase spot ticker merged with 24h stats. */
export type MarketCrypto = {
  product: string;
  price: number;
  bid: number | null;
  ask: number | null;
  open24h: number | null;
  high24h: number | null;
  low24h: number | null;
  volume24h: number | null;
  changePct24h: number | null;
  time: string | null;
};

export type BookLevel = { price: number; size: number };

/** Coinbase level-2 order book, truncated per side. */
export type MarketBook = { product: string; bids: BookLevel[]; asks: BookLevel[] };

/** One Coinbase trade (side is the maker side, raw). */
export type MarketTrade = {
  tradeId: number;
  time: string;
  price: number;
  size: number;
  side: string;
};

/** Frankfurter daily FX rates. */
export type MarketFx = { base: string; date: string; rates: Record<string, number> };

export const marketChart = (symbol: string) =>
  safeInvoke<MarketChart>("market_chart", { symbol });

export const marketCrypto = (product: string) =>
  safeInvoke<MarketCrypto>("market_crypto", { product });

export const marketBook = (product: string, depth: number) =>
  safeInvoke<MarketBook>("market_book", { product, depth });

export const marketTrades = (product: string) =>
  safeInvoke<MarketTrade[]>("market_trades", { product });

export const marketFx = (base: string, symbols: string[]) =>
  safeInvoke<MarketFx>("market_fx", { base, symbols });

/**
 * Legacy batch chart fetch (market.rs, folded in from quotes.rs — command name
 * unchanged). Returns the raw JSON array string:
 *   `[{"symbol":"SPY","body":<raw JSON or null>},...]`
 * Rejects with ShellUnavailableError in the browser (safeInvoke contract).
 */
export const quoteFetch = (symbols: string[]) =>
  safeInvoke<string>("quote_fetch", { symbols });

// ── builderChat — the single cloud-override seam ────────────────────────────────
//
// This is the ONLY entry point for builder-role model calls.
// - When model.cloudBuilder == "anthropic" AND a key is present → tries cloud first,
//   falls back to fleetChat on any cloud error (emits brain "local").
// - Otherwise → fleetChat (brain "local").
// Companion/rewriter roles NEVER flow through here (they call fleetChat directly).
//
// The `system` and `messages` arguments mirror what fleet_chat receives:
// - system is passed as the first system-role message when using cloud
// - For cloud: system is extracted from messages[0] if role="system", else passed as ""

export async function builderChat(
  messages: Msg[],
  opts?: ChatOpts,
): Promise<BuilderChatResult> {
  const cloudSetting = getSetting("model.cloudBuilder");

  if (cloudSetting === "anthropic") {
    // Extract system message if present as first message
    let systemMsg = "";
    let chatMessages = messages;
    if (messages.length > 0 && messages[0].role === "system") {
      systemMsg = messages[0].content;
      chatMessages = messages.slice(1);
    }

    // Check if key is configured — avoid a round-trip if not
    let keyPresent = false;
    try {
      keyPresent = await cloudKeyPresent();
    } catch {
      // cloud not available — fall through to local
    }

    if (keyPresent) {
      try {
        // max_tokens fixed at cloud.rs DEFAULT_MAX_TOKENS
        const text = await cloudChat(systemMsg, chatMessages, undefined);
        return { text, brain: "cloud" };
      } catch {
        // Cloud error → fall back to local; caller will log "cloud unavailable"
        const text = await fleetChat("builder", messages, opts);
        return { text, brain: "local" };
      }
    }
  }

  // Default: local fleet
  const text = await fleetChat("builder", messages, opts);
  return { text, brain: "local" };
}
