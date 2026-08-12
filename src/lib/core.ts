import { invoke } from "@tauri-apps/api/core";

export type RoleStatus = { role: string; model: string; present: boolean };
export type Msg = { role: "system" | "user" | "assistant"; content: string };
export type Commit = { sha: string; message: string };

export const fleetStatus = () => invoke<RoleStatus[]>("fleet_status");
export const fleetChat = (role: string, messages: Msg[]) =>
  invoke<string>("fleet_chat", { role, messages });

export const timelineInit = () => invoke<void>("timeline_init");
export const timelineCommit = (message: string) => invoke<string>("timeline_commit", { message });
export const timelineLog = (limit = 20) => invoke<Commit[]>("timeline_log", { limit });
export const timelineRollback = (sha: string) => invoke<void>("timeline_rollback", { sha });
