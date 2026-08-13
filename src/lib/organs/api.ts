import { fleetChat, type Msg } from "../core";
import { buildUiKit, type LoomUiKit } from "./uikit";
import { KIT_TOKENS } from "./uikitSrc";

export type { LoomUiKit };
export { KIT_TOKENS };

export type LoomApi = {
  storage: { get<T>(k: string, fallback: T): T; set(k: string, v: unknown): void; del(k: string): void };
  model: { chat(messages: Msg[]): Promise<string> };
  ui: LoomUiKit;
  notify: (text: string) => void;
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
    ui: buildUiKit(KIT_TOKENS),
    notify: (text) => {
      need("notify");
      (deps.notify ?? ((t: string) => console.info("[notify]", t)))(text);
    },
  };
}
