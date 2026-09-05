/**
 * threading.test.ts — the TS side of the threading ceremony (PROTECTED, see
 * threading.ts).
 *
 * Proves: the six-station rail and its cursor; the feed (the `thread_status`
 * seed first, then every `loom-thread` event, silent outside the shell);
 * the elapsed formatter; and the cancel seam — including the calm answer
 * when `thread_cancel` refuses because nothing is being threaded.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const core = vi.hoisted(() => ({
  threadStatus: vi.fn(),
  threadCancel: vi.fn(),
}));
vi.mock("../core", () => ({
  ...core,
  THREAD_EVENT: "loom-thread",
  ShellUnavailableError: class ShellUnavailableError extends Error {
    constructor() {
      super("This surface needs the desktop shell.");
      this.name = "ShellUnavailableError";
    }
  },
}));

const tauriEvent = vi.hoisted(() => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauriEvent.listen }));

import { ShellUnavailableError, type ThreadEvent, type ThreadStatus } from "../core";
import {
  THREAD_EVENT,
  STATIONS,
  stationIndex,
  stationState,
  formatElapsed,
  subscribe,
  cancelThreading,
  NETWORK_ONCE,
  CANCEL_MEANS,
  NOTHING_TO_CANCEL,
  type ThreadFeedMsg,
} from "./threading";

const status = (over: Partial<ThreadStatus> = {}): ThreadStatus => ({
  threaded: false,
  tools: [],
  missing: [],
  drifted: [],
  steps: { seed: false, deps: false, vendor: false, warm: false, register: false },
  needsNetwork: true,
  sherpaCache: null,
  ...over,
});

const event = (over: Partial<ThreadEvent> = {}): ThreadEvent => ({
  step: "seed",
  detail: "cloning the bundled genome into source/",
  tail: [],
  ...over,
});

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  core.threadStatus.mockReset();
  core.threadCancel.mockReset();
  tauriEvent.listen.mockReset();
});

describe("the rail", () => {
  it("names the ceremony's six stations in the spec's order", () => {
    expect(STATIONS).toEqual(["seed", "deps", "vendor", "warm", "register", "stamp"]);
  });

  it("stationIndex places each station and refuses the terminal steps", () => {
    expect(stationIndex("seed")).toBe(0);
    expect(stationIndex("warm")).toBe(3);
    expect(stationIndex("stamp")).toBe(5);
    expect(stationIndex("done")).toBe(-1);
    expect(stationIndex("failed")).toBe(-1);
  });

  it("colours the rail: before the cursor done, at it active, after it pending", () => {
    expect(stationState("seed", "vendor", 2)).toBe("done");
    expect(stationState("vendor", "vendor", 2)).toBe("active");
    expect(stationState("warm", "vendor", 2)).toBe("pending");
  });

  it("a failure marks the station it died at and keeps the ones before it done", () => {
    expect(stationState("deps", "failed", 1)).toBe("failed");
    expect(stationState("seed", "failed", 1)).toBe("done");
    expect(stationState("vendor", "failed", 1)).toBe("pending");
  });

  it("done marks every station the ceremony reached", () => {
    expect(stationState("stamp", "done", 5)).toBe("done");
    expect(stationState("seed", "done", 5)).toBe("done");
  });
});

describe("formatElapsed", () => {
  it("reads m:ss, floored, uncapped in minutes", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(9_000)).toBe("0:09");
    expect(formatElapsed(61_500)).toBe("1:01");
    expect(formatElapsed(3_723_000)).toBe("62:03");
  });

  it("never reads negative", () => {
    expect(formatElapsed(-5000)).toBe("0:00");
  });
});

describe("subscribe", () => {
  it("delivers the thread_status seed first, then every loom-thread event", async () => {
    const s = status({ needsNetwork: false });
    core.threadStatus.mockResolvedValue(s);
    let emit: ((e: { payload: ThreadEvent }) => void) | null = null;
    const off = vi.fn();
    tauriEvent.listen.mockImplementation(
      async (_n: string, cb: (e: { payload: ThreadEvent }) => void) => {
        emit = cb;
        return off;
      },
    );

    const got: ThreadFeedMsg[] = [];
    const stop = subscribe((m) => got.push(m));
    await flush();

    expect(tauriEvent.listen).toHaveBeenCalledWith(THREAD_EVENT, expect.any(Function));
    expect(got[0]).toEqual({ kind: "seed", status: s });
    const e = event({ step: "warm", detail: "compiling the core" });
    emit!({ payload: e });
    expect(got[1]).toEqual({ kind: "event", event: e });

    stop();
    expect(off).toHaveBeenCalledTimes(1);
  });

  it("delivers nothing and listens for nothing outside the shell", async () => {
    core.threadStatus.mockRejectedValue(new ShellUnavailableError());
    const got: ThreadFeedMsg[] = [];
    subscribe((m) => got.push(m));
    await flush();
    expect(got).toEqual([]);
    expect(tauriEvent.listen).not.toHaveBeenCalled();
  });

  it("still subscribes when the seeding read fails for any other reason", async () => {
    core.threadStatus.mockRejectedValue(new Error("no threads.json yet"));
    tauriEvent.listen.mockResolvedValue(vi.fn());
    const got: ThreadFeedMsg[] = [];
    subscribe((m) => got.push(m));
    await flush();
    expect(got).toEqual([]);
    expect(tauriEvent.listen).toHaveBeenCalled();
  });

  it("delivers nothing after the caller has unsubscribed", async () => {
    core.threadStatus.mockResolvedValue(status());
    tauriEvent.listen.mockResolvedValue(vi.fn());
    const got: ThreadFeedMsg[] = [];
    const stop = subscribe((m) => got.push(m));
    stop();
    await flush();
    expect(got).toEqual([]);
  });

  it("survives a missing event bridge", async () => {
    core.threadStatus.mockResolvedValue(status());
    tauriEvent.listen.mockRejectedValue(new Error("no bridge"));
    const stop = subscribe(() => {});
    await flush();
    expect(() => stop()).not.toThrow();
  });
});

describe("cancelThreading", () => {
  it("calls thread_cancel and reports ok", async () => {
    core.threadCancel.mockResolvedValue(undefined);
    await expect(cancelThreading()).resolves.toEqual({ ok: true });
    expect(core.threadCancel).toHaveBeenCalledTimes(1);
  });

  it("turns the core's nothing-to-cancel refusal into one calm sentence", async () => {
    core.threadCancel.mockRejectedValue({
      kind: "parse",
      message: "parse: nothing to cancel — the loom isn't being threaded",
    });
    await expect(cancelThreading()).resolves.toEqual({ ok: false, reason: NOTHING_TO_CANCEL });
  });

  it("passes any other refusal through, without its error kind", async () => {
    core.threadCancel.mockRejectedValue({ kind: "parse", message: "parse: the job slot is gone" });
    await expect(cancelThreading()).resolves.toEqual({ ok: false, reason: "the job slot is gone" });
  });

  it("says something calm when the shell is not there at all", async () => {
    core.threadCancel.mockRejectedValue(new ShellUnavailableError());
    const out = await cancelThreading();
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason.length).toBeGreaterThan(0);
  });
});

describe("copy law", () => {
  it("every exported sentence is lowercase-leaning and free of exclamation marks", () => {
    for (const line of [NETWORK_ONCE, CANCEL_MEANS, NOTHING_TO_CANCEL]) {
      expect(line).not.toMatch(/!/);
      expect(line[0]).toBe(line[0].toLowerCase());
    }
  });

  it("the network line is said in the core's own words", () => {
    expect(NETWORK_ONCE).toContain("needs the network once");
  });

  it("the cancel line says the ceremony resumes rather than restarts", () => {
    expect(CANCEL_MEANS).toMatch(/resum/);
  });
});
