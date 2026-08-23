import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { purgeOrganStorage, addOrganTombstone, makeLoomApi, clearOrganPulses, organPulseCount, PULSE_MIN_MS, PULSE_MAX_PER_ORGAN } from "./api";
import { makeLedger } from "./budgets";
import { isLiveNotifyToken } from "./notifyGate";
import type { ScoredEvent } from "../watch/types";

beforeEach(() => { localStorage.clear(); });
afterEach(() => { localStorage.clear(); vi.useRealTimers(); });

describe("purgeOrganStorage", () => {
  it("removes all organ.id.* keys from localStorage", () => {
    localStorage.setItem("organ.notes.data", JSON.stringify({ foo: 1 }));
    localStorage.setItem("organ.notes.prefs", JSON.stringify({ bar: 2 }));
    localStorage.setItem("organ.timeline.data", JSON.stringify({ other: 3 }));
    localStorage.setItem("loom.win.notes", JSON.stringify({ x: 40 }));
    purgeOrganStorage("notes");
    expect(localStorage.getItem("organ.notes.data")).toBeNull();
    expect(localStorage.getItem("organ.notes.prefs")).toBeNull();
    expect(localStorage.getItem("loom.win.notes")).toBeNull();
    // other organ's keys untouched
    expect(localStorage.getItem("organ.timeline.data")).not.toBeNull();
  });

  it("is safe when no keys exist for the organ", () => {
    expect(() => purgeOrganStorage("nonexistent")).not.toThrow();
  });
});

describe("addOrganTombstone", () => {
  it("adds id to loom.organs.deleted", () => {
    addOrganTombstone("notes");
    const raw = localStorage.getItem("loom.organs.deleted");
    expect(raw).not.toBeNull();
    const list = JSON.parse(raw!);
    expect(list).toContain("notes");
  });

  it("does not duplicate ids", () => {
    addOrganTombstone("notes");
    addOrganTombstone("notes");
    const list = JSON.parse(localStorage.getItem("loom.organs.deleted")!);
    expect(list.filter((id: string) => id === "notes").length).toBe(1);
  });

  it("accumulates multiple ids", () => {
    addOrganTombstone("notes");
    addOrganTombstone("timeline");
    const list = JSON.parse(localStorage.getItem("loom.organs.deleted")!);
    expect(list).toContain("notes");
    expect(list).toContain("timeline");
  });
});

// ── The six powers ─────────────────────────────────────────────────────────────

const SCORED: ScoredEvent[] = [
  { id: "e1", title: "BTC slides 5%", source: "auspex", category: "finance", publishedAt: "2026-08-22T00:00:00Z", score: 0.9, reasons: ["watchlist: bitcoin"] },
  { id: "e2", title: "M6.1 quake", source: "quakes", category: "seismic", publishedAt: "2026-08-22T00:01:00Z", score: 0.7, reasons: ["magnitude"] },
];

describe("power: market", () => {
  it("every market call throws without the market grant", async () => {
    const api = makeLoomApi("x", [], { ledger: makeLedger(() => 0) });
    await expect(api.market.chart("SPY")).rejects.toThrow(/permission "market" not granted/);
    await expect(api.market.crypto("BTC-USD")).rejects.toThrow(/not granted/);
    await expect(api.market.book("BTC-USD")).rejects.toThrow(/not granted/);
    await expect(api.market.trades("BTC-USD")).rejects.toThrow(/not granted/);
    await expect(api.market.fx("USD", ["EUR"])).rejects.toThrow(/not granted/);
  });

  it("wraps the core market fns thinly when granted", async () => {
    const marketChart = vi.fn().mockResolvedValue({ symbol: "SPY", price: 500 });
    const marketCrypto = vi.fn().mockResolvedValue({ product: "BTC-USD", price: 50000 });
    const marketBook = vi.fn().mockResolvedValue({ product: "BTC-USD", bids: [], asks: [] });
    const marketTrades = vi.fn().mockResolvedValue([]);
    const marketFx = vi.fn().mockResolvedValue({ base: "USD", date: "2026-08-22", rates: { EUR: 0.9 } });
    const api = makeLoomApi("x", ["market"], { marketChart, marketCrypto, marketBook, marketTrades, marketFx, ledger: makeLedger(() => 0) });
    await expect(api.market.chart("SPY")).resolves.toMatchObject({ symbol: "SPY" });
    await api.market.crypto("BTC-USD");
    await api.market.book("BTC-USD");
    await api.market.trades("BTC-USD");
    await api.market.fx("USD", ["EUR"]);
    expect(marketChart).toHaveBeenCalledWith("SPY");
    expect(marketBook).toHaveBeenCalledWith("BTC-USD", 10); // default depth
  });

  it("throttles after 30 calls in a minute and dispatches loom-throttled", async () => {
    const marketCrypto = vi.fn().mockResolvedValue({ product: "BTC-USD", price: 1 });
    const api = makeLoomApi("btc", ["market"], { marketCrypto, ledger: makeLedger(() => 0) });
    const events: unknown[] = [];
    const onThrottle = (e: Event) => events.push((e as CustomEvent).detail);
    window.addEventListener("loom-throttled", onThrottle);
    try {
      for (let i = 0; i < 30; i++) await api.market.crypto("BTC-USD");
      await expect(api.market.crypto("BTC-USD")).rejects.toThrow(/"market" budget spent/);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ id: "btc", power: "market" });
      expect((events[0] as { retryMs: number }).retryMs).toBeGreaterThan(0);
      expect(marketCrypto).toHaveBeenCalledTimes(30); // the 31st never reached the engine
    } finally {
      window.removeEventListener("loom-throttled", onThrottle);
    }
  });
});

describe("power: watch", () => {
  it("throws without the watch grant", () => {
    const api = makeLoomApi("x", []);
    expect(() => api.watch.top()).toThrow(/permission "watch" not granted/);
    expect(() => api.watch.list()).toThrow(/not granted/);
  });

  it("top(n) returns the ranked title/source/score/reasons shape only", () => {
    const api = makeLoomApi("x", ["watch"], { getSalient: (k = 10) => SCORED.slice(0, k) });
    const top = api.watch.top(1);
    expect(top).toEqual([{ title: "BTC slides 5%", source: "auspex", score: 0.9, reasons: ["watchlist: bitcoin"] }]);
    // no leakage of ids/coords/urls
    expect(Object.keys(top[0]).sort()).toEqual(["reasons", "score", "source", "title"]);
  });

  it("list() returns the watchlist as copies", () => {
    const entries = [{ kind: "topic" as const, value: "bitcoin" }];
    const api = makeLoomApi("x", ["watch"], { getWatchlist: () => entries });
    const list = api.watch.list();
    expect(list).toEqual(entries);
    expect(list[0]).not.toBe(entries[0]); // organ mutation never reaches the store
  });
});

describe("power: timeline", () => {
  it("throws without the timeline grant", async () => {
    const api = makeLoomApi("x", []);
    await expect(api.timeline.log()).rejects.toThrow(/permission "timeline" not granted/);
  });

  it("log(n) reads via timelineLog", async () => {
    const timelineLog = vi.fn().mockResolvedValue([{ sha: "abc1234", message: "weave" }]);
    const api = makeLoomApi("x", ["timeline"], { timelineLog });
    await expect(api.timeline.log(5)).resolves.toEqual([{ sha: "abc1234", message: "weave" }]);
    expect(timelineLog).toHaveBeenCalledWith(5);
  });
});

describe("power: voice", () => {
  it("throws without the voice grant", async () => {
    const api = makeLoomApi("x", []);
    await expect(api.voice.say("hi")).rejects.toThrow(/permission "voice" not granted/);
  });

  it("say() speaks through the TTS path with a 300-char cap", async () => {
    const ttsSpeak = vi.fn().mockResolvedValue([0, 0]);
    const playWav = vi.fn().mockResolvedValue(undefined);
    const api = makeLoomApi("x", ["voice"], { ttsSpeak, playWav, ledger: makeLedger(() => 0) });
    await api.voice.say("a".repeat(500));
    expect(ttsSpeak).toHaveBeenCalledTimes(1);
    expect(ttsSpeak.mock.calls[0][0]).toHaveLength(300);
    expect(playWav).toHaveBeenCalledTimes(1);
  });

  it("budget: one utterance per 30s, refills", async () => {
    let now = 0;
    const ttsSpeak = vi.fn().mockResolvedValue([]);
    const playWav = vi.fn().mockResolvedValue(undefined);
    const api = makeLoomApi("x", ["voice"], { ttsSpeak, playWav, ledger: makeLedger(() => now) });
    await api.voice.say("one");
    await expect(api.voice.say("two")).rejects.toThrow(/"voice" budget spent/);
    now = 30_000;
    await expect(api.voice.say("three")).resolves.toBeUndefined();
  });
});

describe("power: notify", () => {
  it("throws without the notify grant", () => {
    const api = makeLoomApi("x", []);
    expect(() => api.notify("hello")).toThrow(/permission "notify" not granted/);
  });

  it("dispatches loom-notify with title + body, the organ id, and a live token", () => {
    const api = makeLoomApi("btc", ["notify"], { ledger: makeLedger(() => 0) });
    const seen: { id: string; title: string; body?: string; token: string }[] = [];
    const onNotify = (e: Event) => seen.push((e as CustomEvent<{ id: string; title: string; body?: string; token: string }>).detail);
    window.addEventListener("loom-notify", onNotify);
    try {
      api.notify("BTC alert", "down 5% in the hour");
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ id: "btc", title: "BTC alert", body: "down 5% in the hour" });
      expect(isLiveNotifyToken(seen[0].token)).toBe(true);
    } finally {
      window.removeEventListener("loom-notify", onNotify);
    }
  });

  it("legacy grants that stored notify as a permission-era string still pass need()", () => {
    // Grants are plain strings — an organ approved back when "notify" lived in
    // the permissions catalog keeps its toast without any re-approval.
    const api = makeLoomApi("old-timer", ["storage", "notify"], { ledger: makeLedger(() => 0) });
    expect(() => api.notify("still here")).not.toThrow();
  });

  it("the per-mount token is not reachable through the api object", () => {
    const api = makeLoomApi("btc-t", ["notify"], { ledger: makeLedger(() => 0) });
    const seen: { token: string }[] = [];
    const onNotify = (e: Event) => seen.push((e as CustomEvent<{ token: string }>).detail);
    window.addEventListener("loom-notify", onNotify);
    try {
      api.notify("probe");
    } finally {
      window.removeEventListener("loom-notify", onNotify);
    }
    const token = seen[0].token;
    expect(token.length).toBeGreaterThan(0);
    // Organ code holds only the api object — serializing every enumerable
    // property must never surface the token (it lives in a closure + the
    // module-private notifyGate registry).
    expect(JSON.stringify(api)).not.toContain(token);
  });

  it("a forged token is not live; a remount invalidates the previous token", () => {
    expect(isLiveNotifyToken("forged")).toBe(false);
    expect(isLiveNotifyToken(undefined)).toBe(false);
    const seen: { token: string }[] = [];
    const onNotify = (e: Event) => seen.push((e as CustomEvent<{ token: string }>).detail);
    window.addEventListener("loom-notify", onNotify);
    try {
      const first = makeLoomApi("remount", ["notify"], { ledger: makeLedger(() => 0) });
      first.notify("one");
      const firstToken = seen[0].token;
      expect(isLiveNotifyToken(firstToken)).toBe(true);
      makeLoomApi("remount", ["notify"], { ledger: makeLedger(() => 0) }); // remount mints anew
      expect(isLiveNotifyToken(firstToken)).toBe(false);
    } finally {
      window.removeEventListener("loom-notify", onNotify);
    }
  });

  it("purgeOrganStorage revokes the organ's notify token", () => {
    const api = makeLoomApi("purged", ["notify"], { ledger: makeLedger(() => 0) });
    const seen: { token: string }[] = [];
    const onNotify = (e: Event) => seen.push((e as CustomEvent<{ token: string }>).detail);
    window.addEventListener("loom-notify", onNotify);
    try {
      api.notify("last words");
    } finally {
      window.removeEventListener("loom-notify", onNotify);
    }
    expect(isLiveNotifyToken(seen[0].token)).toBe(true);
    purgeOrganStorage("purged");
    expect(isLiveNotifyToken(seen[0].token)).toBe(false);
  });

  it("budget: 6 per hour, then the calm budget error", () => {
    const api = makeLoomApi("btc", ["notify"], { ledger: makeLedger(() => 0) });
    for (let i = 0; i < 6; i++) api.notify(`n${i}`);
    expect(() => api.notify("n7")).toThrow(/"notify" budget spent/);
  });
});

describe("power: pulse", () => {
  it("throws without the pulse grant", () => {
    const api = makeLoomApi("x", []);
    expect(() => api.pulse.every(60_000, () => {})).toThrow(/permission "pulse" not granted/);
  });

  it("clamps intervals below 30s up to 30s", () => {
    vi.useFakeTimers();
    const api = makeLoomApi("p1", ["pulse"]);
    const fn = vi.fn();
    const cancel = api.pulse.every(1_000, fn);
    vi.advanceTimersByTime(PULSE_MIN_MS - 1);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    cancel();
  });

  it("returns a cancel fn that stops the pulse and frees the slot", () => {
    vi.useFakeTimers();
    const api = makeLoomApi("p2", ["pulse"]);
    const fn = vi.fn();
    const cancel = api.pulse.every(30_000, fn);
    expect(organPulseCount("p2")).toBe(1);
    cancel();
    expect(organPulseCount("p2")).toBe(0);
    vi.advanceTimersByTime(120_000);
    expect(fn).not.toHaveBeenCalled();
  });

  it("allows at most 4 pulses per organ", () => {
    vi.useFakeTimers();
    const api = makeLoomApi("p3", ["pulse"]);
    for (let i = 0; i < PULSE_MAX_PER_ORGAN; i++) api.pulse.every(30_000, () => {});
    expect(() => api.pulse.every(30_000, () => {})).toThrow(/pulse limit reached/);
    clearOrganPulses("p3");
  });

  it("clearOrganPulses stops everything for that organ only", () => {
    vi.useFakeTimers();
    const a = makeLoomApi("pa", ["pulse"]);
    const b = makeLoomApi("pb", ["pulse"]);
    const fa = vi.fn();
    const fb = vi.fn();
    a.pulse.every(30_000, fa);
    b.pulse.every(30_000, fb);
    clearOrganPulses("pa");
    vi.advanceTimersByTime(30_000);
    expect(fa).not.toHaveBeenCalled();
    expect(fb).toHaveBeenCalledTimes(1);
    clearOrganPulses("pb");
  });

  it("a throwing pulse callback never escapes the interval", () => {
    vi.useFakeTimers();
    const api = makeLoomApi("p4", ["pulse"]);
    api.pulse.every(30_000, () => { throw new Error("organ bug"); });
    expect(() => vi.advanceTimersByTime(30_000)).not.toThrow();
    clearOrganPulses("p4");
  });

  it("purgeOrganStorage clears the organ's pulses (delete path)", () => {
    vi.useFakeTimers();
    const api = makeLoomApi("p5", ["pulse"]);
    const fn = vi.fn();
    api.pulse.every(30_000, fn);
    purgeOrganStorage("p5");
    expect(organPulseCount("p5")).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(fn).not.toHaveBeenCalled();
  });

  it("revocation mid-flight: splicing the granted array makes the next call throw", () => {
    const granted = ["watch"];
    const api = makeLoomApi("x", granted, { getSalient: (k = 10) => SCORED.slice(0, k) });
    expect(api.watch.top(1)).toHaveLength(1);
    granted.splice(granted.indexOf("watch"), 1); // what the POWERS row revoke does
    expect(() => api.watch.top(1)).toThrow(/permission "watch" not granted/);
  });
});

describe("makeLoomApi settings.resetAll", () => {
  it("throws without settings permission", async () => {
    const api = makeLoomApi("test", []);
    await expect(api.settings.resetAll()).rejects.toThrow(/permission "settings" not granted/);
  });

  it("calls resetAllSettings dep and does not throw", async () => {
    let called = false;
    const api = makeLoomApi("test", ["settings"], {
      resetAllSettings: () => { called = true; },
    });
    // location.reload will throw in jsdom — catch it
    try { await api.settings.resetAll(); } catch { /* jsdom throws on location.reload */ }
    expect(called).toBe(true);
  });
});
