import { invoke } from "@tauri-apps/api/core";

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
