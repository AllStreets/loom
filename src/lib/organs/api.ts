import { fleetChat, fleetStatus, voiceStatus as coreVoiceStatus, voiceSetup as coreVoiceSetup, sttTranscribe, ttsSpeak, FLEET_DEFAULTS, type Msg, type VoiceStatus } from "../core";
import { getSetting, setSetting, isValidModelTag, VOICE_IDS, VOICE_LABELS } from "../voice/settings";
import { startRecording } from "../voice/recorder";
import { playWav } from "../voice/player";
import { buildUiKit, type LoomUiKit } from "./uikit";
import { KIT_TOKENS } from "./uikitSrc";

export type { LoomUiKit };
export { KIT_TOKENS };

export type VoiceEntry = { id: string; label: string; present: boolean };

export type ModelRole = "builder" | "companion" | "rewriter";
export type ModelEntry = {
  role: ModelRole;
  model: string;       // effective model (override if set+valid, else default)
  default: string;     // fleet default for this role
  override: string;    // raw setting value ("" if unset)
  present: boolean;    // whether Ollama reports this model installed
};

export type LoomSettingsApi = {
  get(key: string): string;
  set(key: string, value: string): void;
  voices(): Promise<VoiceEntry[]>;
  audition(voiceId: string): Promise<void>;
  micTest(): Promise<string>;
  voiceStatus(): Promise<VoiceStatus>;
  setup(onPct?: (pct: number) => void): Promise<void>;
  models(): Promise<ModelEntry[]>;
  setModel(role: string, tag: string): Promise<{ ok: boolean; error?: string }>;
};

export type LoomApi = {
  storage: { get<T>(k: string, fallback: T): T; set(k: string, v: unknown): void; del(k: string): void };
  model: { chat(messages: Msg[]): Promise<string> };
  ui: LoomUiKit;
  notify: (text: string) => void;
  settings: LoomSettingsApi;
};

export type ApiDeps = {
  chat?: typeof fleetChat;
  notify?: (t: string) => void;
  voiceStatus?: typeof coreVoiceStatus;
  voiceSetup?: typeof coreVoiceSetup;
  sttTranscribe?: typeof sttTranscribe;
  ttsSpeak?: typeof ttsSpeak;
  startRecording?: typeof startRecording;
  playWav?: typeof playWav;
  listenProgress?: (cb: (pct: number) => void) => Promise<() => void>;
  fleetStatus?: typeof fleetStatus;
};

export function makeLoomApi(
  organId: string,
  granted: string[],
  deps: ApiDeps = {},
): LoomApi {
  const need = (p: string) => {
    if (!granted.includes(p)) throw new Error(`permission "${p}" not granted`);
  };
  const key = (k: string) => `organ.${organId}.${k}`;
  const chat = deps.chat ?? fleetChat;

  const _voiceStatus = deps.voiceStatus ?? coreVoiceStatus;
  const _voiceSetup = deps.voiceSetup ?? coreVoiceSetup;
  const _fleetStatus = deps.fleetStatus ?? fleetStatus;
  const _sttTranscribe = deps.sttTranscribe ?? sttTranscribe;
  const _ttsSpeak = deps.ttsSpeak ?? ttsSpeak;
  const _startRecording = deps.startRecording ?? startRecording;
  const _playWav = deps.playWav ?? playWav;

  // Default progress listener uses Tauri event system
  const _listenProgress = deps.listenProgress ?? (async (cb: (pct: number) => void) => {
    const { listen } = await import("@tauri-apps/api/event");
    const unlisten = await listen<{ pct: number }>("voice-setup-progress", (e) => {
      cb(e.payload.pct);
    });
    return unlisten;
  });

  return {
    storage: {
      get(k, fallback) {
        need("storage");
        const raw = localStorage.getItem(key(k));
        if (raw == null) return fallback;
        try { return JSON.parse(raw); } catch { return fallback; }
      },
      set(k, v) {
        need("storage");
        // Quota exhaustion must not throw into organ render/handler code
        try { localStorage.setItem(key(k), JSON.stringify(v)); } catch { /* full quota */ }
      },
      del(k) {
        need("storage");
        localStorage.removeItem(key(k));
      },
    },
    model: {
      async chat(messages) {
        need("model");
        return chat("companion", messages);
      },
    },
    ui: buildUiKit(KIT_TOKENS),
    notify: (text) => {
      need("notify");
      (deps.notify ?? ((t: string) => console.info("[notify]", t)))(text);
    },
    settings: {
      get(k) {
        need("settings");
        return getSetting(k);
      },
      set(k, v) {
        need("settings");
        setSetting(k, v);
      },
      async voices() {
        need("settings");
        const status = await _voiceStatus();
        // Build a lookup from voice id to present flag
        const presentMap = new Map(status.voices.map((v) => [v.id, v.present]));
        return (VOICE_IDS as readonly string[]).map((id) => ({
          id,
          label: VOICE_LABELS[id as keyof typeof VOICE_LABELS],
          present: presentMap.get(id) ?? false,
        }));
      },
      async audition(voiceId) {
        need("settings");
        const raw = await _ttsSpeak("Hello — I am LOOM. This is my voice.", voiceId);
        await _playWav(new Uint8Array(raw));
      },
      async micTest() {
        need("settings");
        try {
          const handle = await _startRecording();
          await new Promise<void>((resolve) => setTimeout(resolve, 2000));
          const samples = handle.stop();
          const text = await _sttTranscribe(Array.from(samples));
          return text.trim() || "ok";
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      },
      async voiceStatus() {
        need("settings");
        return _voiceStatus();
      },
      async setup(onPct) {
        need("settings");
        const unlisten = await _listenProgress((pct) => {
          onPct?.(pct);
        });
        try {
          await _voiceSetup();
        } finally {
          unlisten();
        }
      },
      async models() {
        need("settings");
        const roles: ModelRole[] = ["builder", "companion", "rewriter"];
        // Fetch fleet status; gracefully degrade on error (Ollama may not be running)
        let statusRows: { role: string; model: string; present: boolean }[] = [];
        try {
          statusRows = await _fleetStatus();
        } catch {
          // absent Ollama → present defaults to false for all roles
        }
        const presentMap = new Map(statusRows.map((r) => [r.role, r.present]));
        return roles.map((role): ModelEntry => {
          const override = getSetting(`model.${role}`);
          const def = FLEET_DEFAULTS[role];
          const model = (override && isValidModelTag(override)) ? override : def;
          return {
            role,
            model,
            default: def,
            override,
            present: presentMap.get(role) ?? false,
          };
        });
      },
      async setModel(role, tag) {
        need("settings");
        const validRoles: ModelRole[] = ["builder", "companion", "rewriter"];
        if (!validRoles.includes(role as ModelRole)) {
          return { ok: false, error: `unknown role "${role}"` };
        }
        // Empty string = reset to default (allowed); non-empty must be a valid tag
        if (tag !== "" && !isValidModelTag(tag)) {
          return { ok: false, error: "invalid tag" };
        }
        try {
          setSetting(`model.${role}`, tag);
          return { ok: true };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
  };
}
