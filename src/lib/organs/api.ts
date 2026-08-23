import { fleetChat, fleetStatus, voiceStatus as coreVoiceStatus, voiceSetup as coreVoiceSetup, sttTranscribe, ttsSpeak, cloudKeyPresent as coreCloudKeyPresent, cloudKeySet as coreCloudKeySet, cloudKeyClear as coreCloudKeyClear, marketChart as coreMarketChart, marketCrypto as coreMarketCrypto, marketBook as coreMarketBook, marketTrades as coreMarketTrades, marketFx as coreMarketFx, timelineLog as coreTimelineLog, FLEET_DEFAULTS, type Msg, type VoiceStatus, type MarketChart, type MarketCrypto, type MarketBook, type MarketTrade, type MarketFx, type Commit } from "../core";
import { getSetting, setSetting, isValidModelTag, VOICE_IDS, VOICE_LABELS, resetAllSettings as resetAllSettingsFn } from "../voice/settings";
import { startRecording } from "../voice/recorder";
import { playWav } from "../voice/player";
import { getSalient } from "../watch/runtime";
import { getWatchlist, type WatchlistEntry } from "../watch/store";
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
  cloudKeyPresent(): Promise<boolean>;
  cloudKeySet(key: string): Promise<void>;
  cloudKeyClear(): Promise<void>;
  resetAll(): Promise<void>;
};

/** One ranked watch item — the read-only shape organs see. */
export type WatchTopItem = { title: string; source: string; score: number; reasons: string[] };

export type LoomApi = {
  storage: { get<T>(k: string, fallback: T): T; set(k: string, v: unknown): void; del(k: string): void };
  model: { chat(messages: Msg[]): Promise<string> };
  ui: LoomUiKit;
  /** Notify power — glass toast via the `loom-notify` event. Old organs may still call it with one arg. */
  notify: (title: string, body?: string) => void;
  settings: LoomSettingsApi;
  market: {
    chart(symbol: string): Promise<MarketChart>;
    crypto(product: string): Promise<MarketCrypto>;
    book(product: string, depth?: number): Promise<MarketBook>;
    trades(product: string): Promise<MarketTrade[]>;
    fx(base: string, symbols: string[]): Promise<MarketFx>;
  };
  watch: {
    top(n?: number): WatchTopItem[];
    list(): WatchlistEntry[];
  };
  timeline: { log(n?: number): Promise<Commit[]> };
  voice: { say(text: string): Promise<void> };
  pulse: { every(ms: number, fn: () => void): () => void };
};

export type ApiDeps = {
  chat?: typeof fleetChat;
  notify?: (t: string) => void;
  marketChart?: typeof coreMarketChart;
  marketCrypto?: typeof coreMarketCrypto;
  marketBook?: typeof coreMarketBook;
  marketTrades?: typeof coreMarketTrades;
  marketFx?: typeof coreMarketFx;
  timelineLog?: typeof coreTimelineLog;
  getSalient?: typeof getSalient;
  getWatchlist?: typeof getWatchlist;
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
  cloudKeyPresent?: typeof coreCloudKeyPresent;
  cloudKeySet?: typeof coreCloudKeySet;
  cloudKeyClear?: typeof coreCloudKeyClear;
  resetAllSettings?: () => void;
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
  const _cloudKeyPresent = deps.cloudKeyPresent ?? coreCloudKeyPresent;
  const _cloudKeySet = deps.cloudKeySet ?? coreCloudKeySet;
  const _cloudKeyClear = deps.cloudKeyClear ?? coreCloudKeyClear;
  const _marketChart = deps.marketChart ?? coreMarketChart;
  const _marketCrypto = deps.marketCrypto ?? coreMarketCrypto;
  const _marketBook = deps.marketBook ?? coreMarketBook;
  const _marketTrades = deps.marketTrades ?? coreMarketTrades;
  const _marketFx = deps.marketFx ?? coreMarketFx;
  const _timelineLog = deps.timelineLog ?? coreTimelineLog;
  const _getSalient = deps.getSalient ?? getSalient;
  const _getWatchlist = deps.getWatchlist ?? getWatchlist;
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
    market: {
      async chart(symbol) {
        need("market");
        spend("market");
        return _marketChart(symbol);
      },
      async crypto(product) {
        need("market");
        spend("market");
        return _marketCrypto(product);
      },
      async book(product, depth = 10) {
        need("market");
        spend("market");
        return _marketBook(product, depth);
      },
      async trades(product) {
        need("market");
        spend("market");
        return _marketTrades(product);
      },
      async fx(base, symbols) {
        need("market");
        spend("market");
        return _marketFx(base, symbols);
      },
    },
    watch: {
      top(n = 10) {
        need("watch");
        return _getSalient(n).map(({ title, source, score, reasons }) => ({
          title, source, score, reasons: [...reasons],
        }));
      },
      list() {
        need("watch");
        return _getWatchlist().map((e) => ({ ...e }));
      },
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
      async cloudKeyPresent() {
        need("settings");
        return _cloudKeyPresent();
      },
      async cloudKeySet(key) {
        need("settings");
        return _cloudKeySet(key);
      },
      async cloudKeyClear() {
        need("settings");
        return _cloudKeyClear();
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
