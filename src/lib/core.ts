import { invoke } from "@tauri-apps/api/core";

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

export const fleetStatus = () => invoke<RoleStatus[]>("fleet_status");
export const fleetChat = (role: string, messages: Msg[], opts?: ChatOpts) =>
  invoke<string>("fleet_chat", {
    role, messages,
    opts: opts ? { num_ctx: opts.numCtx ?? null, temperature: opts.temperature ?? null } : null,
  });

export const timelineInit = () => invoke<void>("timeline_init");
export const timelineCommit = (message: string) => invoke<string>("timeline_commit", { message });
export const timelineLog = (limit = 20) => invoke<Commit[]>("timeline_log", { limit });
export const timelineRollback = (sha: string) => invoke<void>("timeline_rollback", { sha });

export type OrganFile = { name: string; content: string };
export type OrganEntry = { id: string; manifest: string; granted: string | null };

export const organWrite = (id: string, files: OrganFile[], message: string) =>
  invoke<string>("organ_write", { id, files, message });
export const organList = () => invoke<OrganEntry[]>("organ_list");
export const organRead = (id: string, name: string) => invoke<string>("organ_read", { id, name });
export const organGrant = (id: string, grantedJson: string) =>
  invoke<string>("organ_grant", { id, grantedJson });
export const organDelete = (id: string) => invoke<string>("organ_delete", { id });

// ── Voice wrappers ─────────────────────────────────────────────────────────────

export const voiceStatus = () => invoke<VoiceStatus>("voice_status");
export const voiceSetup = () => invoke<void>("voice_setup");
export const sttTranscribe = (samples: number[]) =>
  invoke<string>("stt_transcribe", { samples });
export const ttsSpeak = (text: string, voiceId: string) =>
  invoke<number[]>("tts_speak", { text, voiceId });
