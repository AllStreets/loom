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

// ── Quote proxy ────────────────────────────────────────────────────────────────

/**
 * Fetch Yahoo chart data for the given symbols via LOOM's own Rust proxy.
 * Returns the raw JSON array string produced by quotes.rs:
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
