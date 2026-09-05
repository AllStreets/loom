import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { purgeOrganStorage, addOrganTombstone, makeLoomApi, clearOrganPulses, organPulseCount, PULSE_MIN_MS, PULSE_MAX_PER_ORGAN } from "./api";
import { makeLedger } from "./budgets";
import { isLiveNotifyToken } from "./notifyGate";
import { BodyRequestDeclined, LINE_DECLINED, LINE_NO_CHROME } from "./bodyGate";

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

// ── The four powers ────────────────────────────────────────────────────────────

describe("retired powers (Rebirth)", () => {
  it("the api object carries no market or watch surface at all", () => {
    const api = makeLoomApi("x", ["market", "watch"]) as unknown as Record<string, unknown>;
    expect(api.market).toBeUndefined();
    expect(api.watch).toBeUndefined();
  });

  it("throttles notify after 6 calls in an hour and dispatches loom-throttled", () => {
    const api = makeLoomApi("nudge", ["notify"], { ledger: makeLedger(() => 0) });
    const events: unknown[] = [];
    const onThrottle = (e: Event) => events.push((e as CustomEvent).detail);
    window.addEventListener("loom-throttled", onThrottle);
    try {
      for (let i = 0; i < 6; i++) api.notify("stand", "up");
      expect(() => api.notify("stand", "up")).toThrow(/"notify" budget spent/);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ id: "nudge", power: "notify" });
      expect((events[0] as { retryMs: number }).retryMs).toBeGreaterThan(0);
    } finally {
      window.removeEventListener("loom-throttled", onThrottle);
    }
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

  it("revocation mid-flight: splicing the granted array makes the next call throw", async () => {
    const granted = ["timeline"];
    const api = makeLoomApi("x", granted, { timelineLog: async () => [{ sha: "a", message: "m" }] });
    await expect(api.timeline.log(1)).resolves.toHaveLength(1);
    granted.splice(granted.indexOf("timeline"), 1); // what the POWERS row revoke does
    await expect(api.timeline.log(1)).rejects.toThrow(/permission "timeline" not granted/);
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

/**
 * Round-2 finding 6: `kernel.autoReweave` decides whether an approved core edit
 * weaves the body with no card at all. It was writable by anything holding the
 * generic `settings` grant — a body change armed from behind an innocuous
 * permission. It belongs to the body, so it sits behind the `self` power, whose
 * grant card is the one that says this organ may ask about LOOM's body.
 */
describe("kernel.autoReweave is not a plain setting", () => {
  it("the settings power cannot write it", () => {
    const api = makeLoomApi("notes", ["settings"]);
    expect(() => api.settings.set("kernel.autoReweave", "on")).toThrow(
      "kernel.autoReweave arms a body change — it lives behind the self power, not settings",
    );
    expect(localStorage.getItem("kernel.autoReweave")).toBeNull();
  });

  it("the settings power still reads it, and still writes every other key", () => {
    const api = makeLoomApi("notes", ["settings"]);
    expect(api.settings.get("kernel.autoReweave")).toBe("off");
    api.settings.set("voice.speakReplies", "never");
    expect(api.settings.get("voice.speakReplies")).toBe("never");
  });

  it("the self power arms and disarms it", async () => {
    const api = makeLoomApi("settings", ["settings", "self"]);
    await api.self.setAutoReweave(true);
    expect(api.settings.get("kernel.autoReweave")).toBe("on");
    await api.self.setAutoReweave(false);
    expect(api.settings.get("kernel.autoReweave")).toBe("off");
  });

  it("without the self grant nothing can arm it", async () => {
    const api = makeLoomApi("notes", ["settings"]);
    await expect(api.self.setAutoReweave(true)).rejects.toThrow(/permission "self" not granted/);
    expect(localStorage.getItem("kernel.autoReweave")).toBeNull();
  });
});

// ── power: self (Rebirth — Settings → LOOM) ────────────────────────────────────

const IDENTITY = {
  mode: "packaged" as const,
  genomeSha: "a".repeat(40),
  generation: "b".repeat(40),
  threaded: true,
  loomhome: "/home/loom",
  loomhomeBytes: 1_000,
};

type TEvent = { step: string; detail: string; tail: string[] };

describe("power: self", () => {
  it("every read and action throws without the self grant", async () => {
    const api = makeLoomApi("x", ["settings"]);
    await expect(api.self.identity()).rejects.toThrow(/permission "self" not granted/);
    await expect(api.self.threads()).rejects.toThrow(/permission "self" not granted/);
    await expect(api.self.generations()).rejects.toThrow(/permission "self" not granted/);
    await expect(api.self.thread()).rejects.toThrow(/permission "self" not granted/);
    await expect(api.self.reweave()).rejects.toThrow(/permission "self" not granted/);
    await expect(api.self.returnTo("abc")).rejects.toThrow(/permission "self" not granted/);
  });

  it("identity / threads / generations read through their deps", async () => {
    const identity = vi.fn().mockResolvedValue(IDENTITY);
    const threadStatus = vi.fn().mockResolvedValue({ threaded: true, tools: [], missing: [], drifted: [], steps: { seed: true, deps: true, vendor: true, warm: true, register: true }, needsNetwork: false });
    const generationsList = vi.fn().mockResolvedValue([]);
    const api = makeLoomApi("x", ["self"], { identity, threadStatus, generationsList });
    await expect(api.self.identity()).resolves.toEqual(IDENTITY);
    await expect(api.self.threads()).resolves.toMatchObject({ threaded: true });
    await expect(api.self.generations()).resolves.toEqual([]);
  });

  it("thread() listens before it ASKS, streams loom-thread events, resolves on done, and unlistens", async () => {
    const order: string[] = [];
    let emit: ((e: TEvent) => void) | null = null;
    const unlisten = vi.fn(() => { order.push("unlisten"); });
    const listenThread = vi.fn(async (cb: (e: TEvent) => void) => { order.push("listen"); emit = cb; return unlisten; });
    const requestBody = vi.fn(async () => { order.push("ask"); });
    const api = makeLoomApi("x", ["self"], { listenThread, requestBody, ledger: makeLedger(() => 0) });
    const seen: string[] = [];
    const done = api.self.thread((e) => seen.push(e.step + ":" + e.detail));
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["listen", "ask"]);
    expect(requestBody).toHaveBeenCalledWith("thread", "x");
    emit!({ step: "seed", detail: "cloning the genome", tail: [] });
    emit!({ step: "done", detail: "the loom is threaded", tail: [] });
    await expect(done).resolves.toBeUndefined();
    expect(seen).toEqual(["seed:cloning the genome", "done:the loom is threaded"]);
    expect(order).toEqual(["listen", "ask", "unlisten"]);
  });

  it("thread() rejects with the failure detail when the ceremony fails", async () => {
    let emit: ((e: TEvent) => void) | null = null;
    const listenThread = vi.fn(async (cb: (e: TEvent) => void) => { emit = cb; return () => {}; });
    const requestBody = vi.fn(async () => {});
    const api = makeLoomApi("x", ["self"], { listenThread, requestBody, ledger: makeLedger(() => 0) });
    const done = api.self.thread();
    await new Promise((r) => setTimeout(r, 0));
    emit!({ step: "failed", detail: "threading needs the network once — after that LOOM weaves offline.", tail: [] });
    await expect(done).rejects.toThrow(/needs the network once/);
  });

  it("thread() unlistens and rejects when the owner declines", async () => {
    const unlisten = vi.fn();
    const listenThread = vi.fn(async () => unlisten);
    const requestBody = vi.fn(async () => { throw new BodyRequestDeclined(); });
    const api = makeLoomApi("x", ["self"], { listenThread, requestBody, ledger: makeLedger(() => 0) });
    await expect(api.self.thread()).rejects.toThrow(LINE_DECLINED);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});

// ── the body gate: an organ asks, chrome acts (round-1 finding 1) ─────────────

describe("power: self — the three acts only ever ASK", () => {
  it("reweave() dispatches a body request and never reaches the orchestration", async () => {
    const requestBody = vi.fn(async () => {});
    const api = makeLoomApi("notes", ["self"], { requestBody, ledger: makeLedger(() => 0) });
    await expect(api.self.reweave()).resolves.toEqual({ ok: true });
    expect(requestBody).toHaveBeenCalledWith("reweave", "notes");
  });

  it("returnTo(sha) asks with the sha and the organ that asked", async () => {
    const requestBody = vi.fn(async () => {});
    const api = makeLoomApi("notes", ["self"], { requestBody, ledger: makeLedger(() => 0) });
    await api.self.returnTo("c".repeat(40));
    expect(requestBody).toHaveBeenCalledWith("return", "notes", "c".repeat(40));
  });

  it("a declined reweave REJECTS with the calm refusal — never a quiet ok", async () => {
    const requestBody = vi.fn(async () => { throw new BodyRequestDeclined(); });
    const api = makeLoomApi("notes", ["self"], { requestBody, ledger: makeLedger(() => 0) });
    await expect(api.self.reweave()).rejects.toThrow(LINE_DECLINED);
  });

  it("a declined return rejects too", async () => {
    const requestBody = vi.fn(async () => { throw new BodyRequestDeclined(); });
    const api = makeLoomApi("notes", ["self"], { requestBody, ledger: makeLedger(() => 0) });
    await expect(api.self.returnTo("abc")).rejects.toThrow(LINE_DECLINED);
  });

  it("the core's own refusal keeps the StartResult shape Settings reads", async () => {
    const requestBody = vi.fn(async () => { throw new Error("a weave is already under way"); });
    const api = makeLoomApi("notes", ["self"], { requestBody, ledger: makeLedger(() => 0) });
    await expect(api.self.reweave()).resolves.toEqual({
      ok: false,
      reason: "a weave is already under way",
    });
  });

  it("with no chrome mounted, the real gate refuses at once rather than hanging", async () => {
    const api = makeLoomApi("notes", ["self"], { ledger: makeLedger(() => 0) });
    await expect(api.self.reweave()).resolves.toEqual({ ok: false, reason: LINE_NO_CHROME });
  });

  it("api.ts holds no path to the orchestration at all — the ask is the only door", async () => {
    // Structural, not behavioural: the finding was that an organ could reach
    // `startReweave` through the api at all. If someone reintroduces the import
    // this fails, whatever the call site looks like.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(path.resolve("src/lib/organs/api.ts"), "utf8");
    expect(src).not.toMatch(/startReweave/);
    expect(src).not.toMatch(/returnToGeneration/);
    expect(src).not.toMatch(/threadLoom/);
  });

  it("budget: three asks a minute, then the calm budget error", async () => {
    let now = 0;
    const requestBody = vi.fn(async () => {});
    const api = makeLoomApi("x", ["self"], { requestBody, ledger: makeLedger(() => now) });
    await api.self.returnTo("a");
    await api.self.reweave();
    await api.self.returnTo("b");
    await expect(api.self.reweave()).rejects.toThrow(/"self" budget spent/);
    now = 60_000;
    await expect(api.self.reweave()).resolves.toEqual({ ok: true });
  });
});
