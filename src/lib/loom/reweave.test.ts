/**
 * reweave.test.ts — the TS side of the reweave job (PROTECTED, see reweave.ts).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const core = vi.hoisted(() => ({
  reweaveStart: vi.fn(),
  reweaveState: vi.fn(),
  kernelIdentity: vi.fn(),
}));
vi.mock("../core", () => ({
  ...core,
  ShellUnavailableError: class ShellUnavailableError extends Error {
    constructor() {
      super("This surface needs the desktop shell.");
      this.name = "ShellUnavailableError";
    }
  },
}));

const tauriEvent = vi.hoisted(() => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauriEvent.listen }));

import { ShellUnavailableError, type Identity, type ReweaveState } from "../core";
import {
  REWEAVE_EVENT,
  STATIONS,
  stationIndex,
  startReweave,
  subscribe,
  REASON_UNTHREADED,
  REASON_NOTHING_NEW,
  REASON_IN_FLIGHT,
  reweaveReadiness,
  shouldAutoReweave,
} from "./reweave";

const identity = (over: Partial<Identity> = {}): Identity => ({
  mode: "packaged",
  genomeSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  generation: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  threaded: true,
  loomhome: "/home/loom",
  loomhomeBytes: 0,
  canSwap: true,
  ...over,
});

const state = (over: Partial<ReweaveState> = {}): ReweaveState => ({
  stage: "idle",
  targetSha: null,
  startedAt: null,
  elapsedMs: 0,
  tail: [],
  outcome: null,
  cancellable: false,
  mode: "packaged",
  ...over,
});

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  core.reweaveStart.mockReset();
  core.reweaveState.mockReset();
  core.kernelIdentity.mockReset();
  tauriEvent.listen.mockReset();
});

describe("startReweave", () => {
  it("refuses when unthreaded with the settings line", async () => {
    const start = vi.fn();
    const id = vi.fn(async () => identity({ threaded: false, generation: null }));
    const out = await startReweave({ start, identity: id });
    expect(out).toEqual({ ok: false, reason: REASON_UNTHREADED });
    expect(out.ok === false && out.reason).toBe("the loom isn't threaded — open Settings");
    expect(start).not.toHaveBeenCalled();
  });

  it("refuses when head equals generation", async () => {
    const start = vi.fn();
    const sha = "3f2a1c3f2a1c3f2a1c3f2a1c3f2a1c3f2a1c3f2a";
    const id = vi.fn(async () => identity({ genomeSha: sha, generation: sha }));
    const out = await startReweave({ start, identity: id });
    expect(out).toEqual({ ok: false, reason: REASON_NOTHING_NEW });
    expect(out.ok === false && out.reason).toBe(
      "nothing new to weave — the body already matches the genome",
    );
    expect(start).not.toHaveBeenCalled();
  });

  it("starts when the genome is ahead of the running generation", async () => {
    const start = vi.fn(async () => undefined);
    const id = vi.fn(async () => identity());
    const out = await startReweave({ start, identity: id });
    expect(out).toEqual({ ok: true });
    expect(start).toHaveBeenCalledWith(false);
  });

  it("starts when no generation has been woven yet (generation null, threaded)", async () => {
    const start = vi.fn(async () => undefined);
    const id = vi.fn(async () => identity({ generation: null }));
    const out = await startReweave({ start, identity: id });
    expect(out).toEqual({ ok: true });
  });

  it("passes force through, even when head equals generation", async () => {
    const start = vi.fn(async () => undefined);
    const sha = "3f2a1c3f2a1c3f2a1c3f2a1c3f2a1c3f2a1c3f2a";
    const id = vi.fn(async () => identity({ genomeSha: sha, generation: sha }));
    const out = await startReweave({ start, identity: id }, true);
    expect(out).toEqual({ ok: true });
    expect(start).toHaveBeenCalledWith(true);
  });

  it("reports the in-flight line when the core refuses because a job is running", async () => {
    const start = vi.fn(async () => {
      throw { kind: "parse", message: "parse: a weave is already under way" };
    });
    const id = vi.fn(async () => identity());
    const out = await startReweave({ start, identity: id });
    expect(out).toEqual({ ok: false, reason: REASON_IN_FLIGHT });
    expect(out.ok === false && out.reason).toBe("a weave is already under way");
  });

  it("passes any other core refusal through as the reason, stripped of its kind prefix", async () => {
    const start = vi.fn(async () => {
      throw { kind: "unsupported", message: "unsupported: the swap is macOS-only for now" };
    });
    const id = vi.fn(async () => identity());
    const out = await startReweave({ start, identity: id });
    expect(out).toEqual({ ok: false, reason: "the swap is macOS-only for now" });
  });

  it("uses the core wrappers by default", async () => {
    core.kernelIdentity.mockResolvedValue(identity());
    core.reweaveStart.mockResolvedValue(undefined);
    const out = await startReweave();
    expect(out).toEqual({ ok: true });
    expect(core.reweaveStart).toHaveBeenCalledWith(false);
  });

  it("outside the shell, the identity rejection becomes a calm reason", async () => {
    core.kernelIdentity.mockRejectedValue(new ShellUnavailableError());
    const out = await startReweave();
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toBe("This surface needs the desktop shell.");
  });
});

describe("reweaveReadiness — the dry run the companion asks before consent", () => {
  it("unthreaded → the settings line", async () => {
    const id = vi.fn(async () => identity({ threaded: false }));
    expect(await reweaveReadiness({ identity: id })).toEqual({ ok: false, reason: REASON_UNTHREADED });
  });

  it("head equals generation → nothing new", async () => {
    const sha = "3f2a1c3f2a1c3f2a1c3f2a1c3f2a1c3f2a1c3f2a";
    const id = vi.fn(async () => identity({ genomeSha: sha, generation: sha }));
    expect(await reweaveReadiness({ identity: id })).toEqual({ ok: false, reason: REASON_NOTHING_NEW });
  });

  it("head ahead → ok with generation, genomeSha and mode; nothing is started", async () => {
    const id = vi.fn(async () => identity());
    expect(await reweaveReadiness({ identity: id })).toEqual({
      ok: true,
      generation: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      genomeSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      // the consent line needs both: in dev nothing is swapped, and off
      // macOS the swap is refused even when packaged
      mode: "packaged",
      canSwap: true,
    });
    expect(core.reweaveStart).not.toHaveBeenCalled();
  });

  it("no generation yet → ok with generation null", async () => {
    const id = vi.fn(async () => identity({ generation: null }));
    const out = await reweaveReadiness({ identity: id });
    expect(out.ok).toBe(true);
    expect(out.ok && out.generation).toBeNull();
  });

  it("force skips the nothing-new check", async () => {
    const sha = "3f2a1c3f2a1c3f2a1c3f2a1c3f2a1c3f2a1c3f2a";
    const id = vi.fn(async () => identity({ genomeSha: sha, generation: sha }));
    expect((await reweaveReadiness({ identity: id }, true)).ok).toBe(true);
  });

  it("uses kernelIdentity by default and turns a shell rejection into a calm reason", async () => {
    core.kernelIdentity.mockRejectedValue(new ShellUnavailableError());
    const out = await reweaveReadiness();
    expect(out).toEqual({ ok: false, reason: "This surface needs the desktop shell." });
  });
});

describe("subscribe", () => {
  it("delivers initial state then events, and unlistens on unsubscribe", async () => {
    const unlisten = vi.fn();
    let handler: ((e: { payload: ReweaveState }) => void) | null = null;
    tauriEvent.listen.mockImplementation(
      async (_name: string, cb: (e: { payload: ReweaveState }) => void) => {
        handler = cb;
        return unlisten;
      },
    );
    core.reweaveState.mockResolvedValue(state({ stage: "assets", cancellable: true }));

    const seen: ReweaveState[] = [];
    const off = subscribe((s) => seen.push(s));
    await flush();

    expect(tauriEvent.listen).toHaveBeenCalledWith(REWEAVE_EVENT, expect.any(Function));
    expect(seen.map((s) => s.stage)).toEqual(["assets"]);

    handler!({ payload: state({ stage: "core", cancellable: true }) });
    handler!({ payload: state({ stage: "done", outcome: "woven" }) });
    expect(seen.map((s) => s.stage)).toEqual(["assets", "core", "done"]);

    off();
    expect(unlisten).toHaveBeenCalledTimes(1);
    handler!({ payload: state({ stage: "failed" }) });
    expect(seen.map((s) => s.stage)).toEqual(["assets", "core", "done"]);
  });

  it("is a no-op outside the shell", async () => {
    core.reweaveState.mockRejectedValue(new ShellUnavailableError());
    const onState = vi.fn();
    const off = subscribe(onState);
    await flush();
    expect(onState).not.toHaveBeenCalled();
    expect(tauriEvent.listen).not.toHaveBeenCalled();
    expect(() => off()).not.toThrow();
  });

  it("still listens when the initial fetch fails for a reason other than the missing shell", async () => {
    core.reweaveState.mockRejectedValue({ kind: "not_found", message: "not found: reweave.json" });
    tauriEvent.listen.mockResolvedValue(() => {});
    const onState = vi.fn();
    subscribe(onState);
    await flush();
    expect(onState).not.toHaveBeenCalled();
    expect(tauriEvent.listen).toHaveBeenCalledWith(REWEAVE_EVENT, expect.any(Function));
  });

  it("unsubscribing before listen resolves still releases the listener", async () => {
    const unlisten = vi.fn();
    let resolveListen: ((u: () => void) => void) | null = null;
    tauriEvent.listen.mockImplementation(
      () => new Promise<() => void>((r) => { resolveListen = r; }),
    );
    core.reweaveState.mockResolvedValue(state());
    const off = subscribe(() => {});
    await flush();
    off();
    resolveListen!(unlisten);
    await flush();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});

describe("stations", () => {
  it("STATIONS is the five-station rail in order", () => {
    expect(STATIONS).toEqual(["assets", "core", "stage", "swap", "relaunch"]);
  });

  it("stationIndex maps stages", () => {
    expect(stationIndex("assets")).toBe(0);
    expect(stationIndex("core")).toBe(1);
    expect(stationIndex("stage")).toBe(2);
    expect(stationIndex("swap")).toBe(3);
    expect(stationIndex("relaunch")).toBe(4);
    expect(stationIndex("idle")).toBe(-1);
    expect(stationIndex("done")).toBe(-1);
    expect(stationIndex("failed")).toBe(-1);
    expect(stationIndex("cancelled")).toBe(-1);
  });
});

// ── canSwap — what the consent line may promise about the swap ──────────────

describe("readiness carries canSwap from the core", () => {
  it("passes the core's answer through rather than guessing it", async () => {
    for (const canSwap of [true, false]) {
      const r = await reweaveReadiness({
        identity: async () => identity({ canSwap }),
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.canSwap).toBe(canSwap);
    }
  });
});

// ── shouldAutoReweave — the packaged apply that may start a weave on its own ──

describe("shouldAutoReweave", () => {
  it("a packaged CORE apply with the setting on starts the weave", () => {
    expect(shouldAutoReweave({ mode: "packaged", isCore: true }, "on")).toBe(true);
  });

  it("a packaged TypeScript apply never starts a weave — the toggle says core", () => {
    expect(shouldAutoReweave({ mode: "packaged", isCore: false }, "on")).toBe(false);
  });

  it("the setting off never starts a weave", () => {
    expect(shouldAutoReweave({ mode: "packaged", isCore: true }, "off")).toBe(false);
  });

  it("dev never starts a weave — tauri dev owns the binary", () => {
    expect(shouldAutoReweave({ mode: "dev", isCore: true }, "on")).toBe(false);
  });
});
