import { fleetChat, type Msg } from "../core";

export type LoomApi = {
  storage: { get<T>(k: string, fallback: T): T; set(k: string, v: unknown): void; del(k: string): void };
  model: { chat(messages: Msg[]): Promise<string> };
  ui: { tokens: Record<string, string> };
  notify: (text: string) => void;
};

const TOKENS = {
  bg: "#060b18",
  panel: "#0d1424",
  t1: "#e8edf7",
  t2: "#9fb0cc",
  t3: "#5f6f8c",
  accent: "#22d3ee",
  go: "#4ade80",
  warn: "#fbbf24",
  danger: "#f87171",
};

export function makeLoomApi(
  organId: string,
  granted: string[],
  deps: { chat?: typeof fleetChat; notify?: (t: string) => void } = {},
): LoomApi {
  const need = (p: string) => {
    if (!granted.includes(p)) throw new Error(`permission "${p}" not granted`);
  };
  const key = (k: string) => `organ.${organId}.${k}`;
  const chat = deps.chat ?? fleetChat;
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
        localStorage.setItem(key(k), JSON.stringify(v));
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
    ui: { tokens: TOKENS },
    notify: (text) => {
      need("notify");
      (deps.notify ?? ((t: string) => console.info("[notify]", t)))(text);
    },
  };
}
