import { fleetChat, fleetStatus, voiceStatus as coreVoiceStatus, voiceSetup as coreVoiceSetup, sttTranscribe, ttsSpeak, timelineLog as coreTimelineLog, kernelIdentity, threadStatus as coreThreadStatus, THREAD_EVENT, FLEET_DEFAULTS, type Msg, type VoiceStatus, type Commit, type Identity, type ThreadStatus, type ThreadEvent, type Generation } from "../core";
import { listGenerations } from "../loom/generations";
import { type StartResult } from "../loom/reweave";
import { requestBody, BodyRequestDeclined } from "./bodyGate";
import { getSetting, setSetting, isValidModelTag, VOICE_IDS, VOICE_LABELS, resetAllSettings as resetAllSettingsFn } from "../voice/settings";
import { startRecording } from "../voice/recorder";
import { playWav } from "../voice/player";
import { makeLedger, type BudgetLedger, type BudgetedPower } from "./budgets";
import { mintNotifyToken, revokeNotifyToken } from "./notifyGate";
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
  resetAll(): Promise<void>;
};

/**
 * The `self` power (Rebirth): LOOM's own body, READ directly and MOVED only by
 * asking. Reads sit behind `need("self")` and answer straight away. The three
 * acts — thread, reweave, return — do not touch the protected orchestration at
 * all: each dispatches a `loom-body-request` (see bodyGate.ts) and waits for
 * chrome to render the owner's consent card and answer. Round-1 review: organs
 * share the shell's JS realm, so a capability any organ holds is a capability
 * every organ's code can reach — the grant decides who may ask through this
 * api, and the card is where the owner decides.
 *
 * That is honesty-enforcement, not a sandbox: same-realm code can dispatch the
 * request itself or skip the api entirely and invoke the Tauri command. See the
 * docblock in `bodyGate.ts` for the whole statement.
 */
export type LoomSelfApi = {
  /** `{ mode, genomeSha, generation, threaded, loomhome, loomhomeBytes }`. */
  identity(): Promise<Identity>;
  /** The tool table, what is missing, what drifted. */
  threads(): Promise<ThreadStatus>;
  /** Every kept generation, newest first. */
  generations(): Promise<Generation[]>;
  /** Ask the owner to run the one-time ceremony. `onEvent` gets every
   *  `loom-thread` line once it starts. Resolves on `done`; rejects with the
   *  detail on `failed`, and with the calm refusal if the owner declines. */
  thread(onEvent?: (e: ThreadEvent) => void): Promise<void>;
  /** Ask the owner to start a reweave — `{ ok: true }` once it is running,
   *  `{ ok: false, reason }` when the core refuses, and a rejection carrying
   *  the calm refusal line when the owner says not now. */
  reweave(): Promise<StartResult>;
  /** Ask the owner to become `sha` again. LOOM will close and return. */
  returnTo(sha: string): Promise<void>;
  /** Arm or disarm the standing yes: after an approved CORE edit, weave without
   *  a second card. A body decision, so it lives here and not in `settings`. */
  setAutoReweave(on: boolean): Promise<void>;
};

/** The one settings key that moves the body, so the body power owns it. */
export const AUTO_REWEAVE_KEY = "kernel.autoReweave";
/** Copy law (docs/BRAND.md): fact — hinge — remedy. */
export const LINE_AUTO_REWEAVE_IS_BODY =
  "kernel.autoReweave arms a body change — it lives behind the self power, not settings";

export type LoomApi = {
  storage: { get<T>(k: string, fallback: T): T; set(k: string, v: unknown): void; del(k: string): void };
  model: { chat(messages: Msg[]): Promise<string> };
  ui: LoomUiKit;
  /** Notify power — glass toast via the `loom-notify` event. Old organs may still call it with one arg. */
  notify: (title: string, body?: string) => void;
  settings: LoomSettingsApi;
  self: LoomSelfApi;
  timeline: { log(n?: number): Promise<Commit[]> };
  voice: { say(text: string): Promise<void> };
  pulse: { every(ms: number, fn: () => void): () => void };
};

export type ApiDeps = {
  chat?: typeof fleetChat;
  notify?: (t: string) => void;
  timelineLog?: typeof coreTimelineLog;
  /** Injectable budget ledger — tests pass makeLedger(fakeClock). */
  ledger?: BudgetLedger;
  voiceStatus?: typeof coreVoiceStatus;
  voiceSetup?: typeof coreVoiceSetup;
  sttTranscribe?: typeof sttTranscribe;
  ttsSpeak?: typeof ttsSpeak;
  startRecording?: typeof startRecording;
  playWav?: typeof playWav;
  listenProgress?: (cb: (pct: number) => void) => Promise<() => void>;
  fleetStatus?: typeof fleetStatus;
  resetAllSettings?: () => void;
  // self power seams — reads only. The three ACTS have no seam here on
  // purpose: they go through bodyGate, and only chrome can answer.
  identity?: typeof kernelIdentity;
  threadStatus?: typeof coreThreadStatus;
  generationsList?: typeof listGenerations;
  listenThread?: (cb: (e: ThreadEvent) => void) => Promise<() => void>;
  /** The ask itself — injectable so tests need no chrome. */
  requestBody?: typeof requestBody;
};

// ── Pulse registry — live intervals per organ, cleared on unmount/delete ──────

const pulseRegistry = new Map<string, Set<ReturnType<typeof setInterval>>>();

/** Minimum pulse interval — nothing runs more often than every 30s. */
export const PULSE_MIN_MS = 30_000;

/** Maximum concurrent pulses per organ. */
export const PULSE_MAX_PER_ORGAN = 4;

/** Cancel and forget every pulse an organ has registered. Idempotent. */
export function clearOrganPulses(id: string): void {
  const set = pulseRegistry.get(id);
  if (!set) return;
  for (const handle of set) clearInterval(handle);
  pulseRegistry.delete(id);
}

/** How many pulses an organ currently keeps (for tests and chrome). */
export function organPulseCount(id: string): number {
  return pulseRegistry.get(id)?.size ?? 0;
}

// ── Budgets — one module-level ledger shared by every real organ ──────────────

const defaultLedger = makeLedger();

/** The calm budget error every throttled power throws. */
export function budgetError(power: string): Error {
  return new Error(`"${power}" budget spent — it refills on its own, try again soon`);
}

export function purgeOrganStorage(id: string): void {
  clearOrganPulses(id);
  revokeNotifyToken(id);
  const prefix = `organ.${id}.`;
  const toRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(prefix)) toRemove.push(k);
  }
  toRemove.forEach((k) => localStorage.removeItem(k));
  localStorage.removeItem(`loom.win.${id}`);
}

export function addOrganTombstone(id: string): void {
  try {
    const raw = localStorage.getItem("loom.organs.deleted");
    const list: string[] = raw ? JSON.parse(raw) : [];
    if (!list.includes(id)) {
      list.push(id);
      localStorage.setItem("loom.organs.deleted", JSON.stringify(list));
    }
  } catch {
    // ignore
  }
}

export function makeLoomApi(
  organId: string,
  granted: string[],
  deps: ApiDeps = {},
): LoomApi {
  const need = (p: string) => {
    if (!granted.includes(p)) throw new Error(`permission "${p}" not granted`);
  };
  // BE HONEST ABOUT THE THREAT MODEL: organs run in the shell's own JS realm,
  // so nothing here stops organ code from calling window.dispatchEvent itself —
  // same-realm organs are honesty-enforced, not security-sandboxed (the real
  // walls are the gate + owner approval). This per-mount token lives only in
  // this closure and the module-private notifyGate registry — it is never
  // exposed on the api object — and Notices ignores untokened events, so the
  // only notify path that renders is the one that passed need() + spend().
  const notifyToken = mintNotifyToken(organId);
  const key = (k: string) => `organ.${organId}.${k}`;
  const chat = deps.chat ?? fleetChat;

  const _voiceStatus = deps.voiceStatus ?? coreVoiceStatus;
  const _voiceSetup = deps.voiceSetup ?? coreVoiceSetup;
  const _fleetStatus = deps.fleetStatus ?? fleetStatus;
  const _sttTranscribe = deps.sttTranscribe ?? sttTranscribe;
  const _ttsSpeak = deps.ttsSpeak ?? ttsSpeak;
  const _startRecording = deps.startRecording ?? startRecording;
  const _playWav = deps.playWav ?? playWav;
  const _timelineLog = deps.timelineLog ?? coreTimelineLog;
  const ledger = deps.ledger ?? defaultLedger;

  // Spend one budget token or throw calmly — and tell the organ's window so it
  // can show (and later clear) its dim THROTTLED chip.
  const spend = (power: BudgetedPower) => {
    const r = ledger.take(organId, power);
    if (!r.ok) {
      window.dispatchEvent(new CustomEvent("loom-throttled", {
        detail: { id: organId, power, retryMs: r.retryMs },
      }));
      throw budgetError(power);
    }
  };

  // Default progress listener uses Tauri event system
  const _listenProgress = deps.listenProgress ?? (async (cb: (pct: number) => void) => {
    const { listen } = await import("@tauri-apps/api/event");
    const unlisten = await listen<{ pct: number }>("voice-setup-progress", (e) => {
      cb(e.payload.pct);
    });
    return unlisten;
  });

  // self power seams — the reads go straight to the core; the three acts go
  // through the body gate, where only chrome can answer.
  const _identity = deps.identity ?? kernelIdentity;
  const _threadStatus = deps.threadStatus ?? coreThreadStatus;
  const _generationsList = deps.generationsList ?? listGenerations;
  const _requestBody = deps.requestBody ?? requestBody;
  const _listenThread = deps.listenThread ?? (async (cb: (e: ThreadEvent) => void) => {
    const { listen } = await import("@tauri-apps/api/event");
    return listen<ThreadEvent>(THREAD_EVENT, (e) => { cb(e.payload); });
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
    notify: (title, body) => {
      need("notify");
      spend("notify");
      window.dispatchEvent(new CustomEvent("loom-notify", {
        detail: { id: organId, title: String(title), body: body === undefined ? undefined : String(body), token: notifyToken },
      }));
      deps.notify?.(String(title));
    },
    timeline: {
      async log(n = 20) {
        need("timeline");
        return _timelineLog(n);
      },
    },
    voice: {
      async say(text) {
        need("voice");
        spend("voice");
        const capped = String(text).slice(0, 300);
        const raw = await _ttsSpeak(capped, getSetting("voice.default"));
        await _playWav(new Uint8Array(raw));
      },
    },
    self: {
      async identity() {
        need("self");
        return _identity();
      },
      async threads() {
        need("self");
        return _threadStatus();
      },
      async generations() {
        need("self");
        return _generationsList();
      },
      async thread(onEvent) {
        need("self");
        spend("self");
        // Listen BEFORE asking so the first line is never missed; the organ
        // only ever asks — chrome runs the ceremony after the owner agrees.
        // Settle on the ceremony's own terminal step; always let the listener go.
        let settle: { resolve: () => void; reject: (e: Error) => void } | null = null;
        const finished = new Promise<void>((resolve, reject) => { settle = { resolve, reject }; });
        const unlisten = await _listenThread((e) => {
          try { onEvent?.(e); } catch { /* an organ's handler must never stop the ceremony */ }
          if (e.step === "done") settle?.resolve();
          else if (e.step === "failed") settle?.reject(new Error(e.detail));
        });
        try {
          await _requestBody("thread", organId);
        } catch (err) {
          unlisten();
          throw err;
        }
        try {
          await finished;
        } finally {
          unlisten();
        }
      },
      async reweave() {
        need("self");
        spend("self");
        try {
          await _requestBody("reweave", organId);
          return { ok: true };
        } catch (e) {
          // The owner saying not now is a refusal of the ASK — it rejects, so
          // an organ cannot mistake it for "the weave could not start". The
          // core's own refusal keeps the StartResult shape it always had.
          if (e instanceof BodyRequestDeclined) throw e;
          return { ok: false, reason: e instanceof Error ? e.message : String(e) };
        }
      },
      async returnTo(sha) {
        need("self");
        spend("self");
        return _requestBody("return", organId, String(sha));
      },
      async setAutoReweave(on) {
        // A preference, not an act: no card, no budget token. What it costs is
        // the `self` grant, because arming it is a standing yes about the body.
        need("self");
        setSetting(AUTO_REWEAVE_KEY, on ? "on" : "off");
      },
    },
    pulse: {
      every(ms, fn) {
        need("pulse");
        let set = pulseRegistry.get(organId);
        if (!set) {
          set = new Set();
          pulseRegistry.set(organId, set);
        }
        if (set.size >= PULSE_MAX_PER_ORGAN) {
          throw new Error(`pulse limit reached — an organ keeps at most ${PULSE_MAX_PER_ORGAN} pulses`);
        }
        const interval = Math.max(PULSE_MIN_MS, Number(ms) || 0);
        const handle = setInterval(() => {
          try { fn(); } catch { /* an organ's pulse must never crash the shell */ }
        }, interval);
        set.add(handle);
        return () => {
          clearInterval(handle);
          pulseRegistry.get(organId)?.delete(handle);
        };
      },
    },
    settings: {
      get(k) {
        need("settings");
        return getSetting(k);
      },
      set(k, v) {
        need("settings");
        // `kernel.autoReweave` decides whether an approved core edit weaves the
        // body with NO card at all. Round-2 review: any organ holding the
        // generic `settings` grant could arm that from behind a permission the
        // owner reads as harmless. It is a decision about the body, so it lives
        // on the `self` power — the grant whose card says this organ may ask
        // about LOOM's body. (Settings are localStorage-backed and organs share
        // the realm, so this is honesty-enforcement, not a wall: it keeps the
        // API from handing the key out, nothing more.)
        if (k === AUTO_REWEAVE_KEY) throw new Error(LINE_AUTO_REWEAVE_IS_BODY);
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
      async resetAll() {
        need("settings");
        const _resetAll = deps.resetAllSettings ?? resetAllSettingsFn;
        _resetAll();
        location.reload();
      },
    },
  };
}
