import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { fleetStatus, fleetChat, organWrite, voiceStatus, voiceSetup, sttTranscribe, ttsSpeak, modelOverrides, FLEET_DEFAULTS, builderChat, ShellUnavailableError, kernelEditable, kernelRead, kernelPropose, kernelValidate, kernelApply, kernelDiscard, kernelRollback, kernelBootOk, kernelBootCheck, kernelIdentity, generationsList, threadStatus, reweaveStart, reweaveCancel, reweaveState, generationsReturn, threadLoom, threadCancel, THREAD_EVENT } from "./core";

beforeEach(() => {
  invoke.mockReset();
  localStorage.clear();
});

describe("core wrappers", () => {
  it("fleetStatus calls the right command with camelCase overrides and returns typed rows", async () => {
    invoke.mockResolvedValue([{ role: "companion", model: "gpt-oss:20b", present: true }]);
    const rows = await fleetStatus();
    expect(invoke).toHaveBeenCalledWith("fleet_status", { overrides: {} });
    expect(rows[0].role).toBe("companion");
  });
  it("fleetChat passes role, messages, snake_case opts, and camelCase overrides", async () => {
    invoke.mockResolvedValue("hi");
    const out = await fleetChat("builder", [{ role: "user", content: "hey" }], { numCtx: 8192, temperature: 0.2 });
    expect(invoke).toHaveBeenCalledWith("fleet_chat", {
      role: "builder",
      messages: [{ role: "user", content: "hey" }],
      opts: { num_ctx: 8192, temperature: 0.2 },
      overrides: {},
    });
    expect(out).toBe("hi");
  });
  it("organWrite passes id, files and message", async () => {
    invoke.mockResolvedValue("abc123");
    const files = [{ name: "organ.js", content: "export default {}" }];
    const sha = await organWrite("runs", files, "organ: runs");
    expect(invoke).toHaveBeenCalledWith("organ_write", { id: "runs", files, message: "organ: runs" });
    expect(sha).toBe("abc123");
  });
});

describe("modelOverrides", () => {
  it("returns empty object when no model settings are set", () => {
    expect(modelOverrides()).toEqual({});
  });

  it("includes only set (non-empty) keys", () => {
    localStorage.setItem("model.builder", "llama3.2");
    expect(modelOverrides()).toEqual({ builder: "llama3.2" });
  });

  it("includes all three when all are set", () => {
    localStorage.setItem("model.builder", "qwen2.5-coder:14b");
    localStorage.setItem("model.companion", "mistral:7b");
    localStorage.setItem("model.rewriter", "qwen3:0.6b");
    expect(modelOverrides()).toEqual({
      builder: "qwen2.5-coder:14b",
      companion: "mistral:7b",
      rewriter: "qwen3:0.6b",
    });
  });

  it("fleetStatus payload uses camelCase 'overrides' key with set model", async () => {
    localStorage.setItem("model.rewriter", "phi3:3.8b");
    invoke.mockResolvedValue([]);
    await fleetStatus();
    const call = invoke.mock.calls[0];
    expect(call[0]).toBe("fleet_status");
    expect(call[1]).toHaveProperty("overrides");
    expect(call[1].overrides).toEqual({ rewriter: "phi3:3.8b" });
    // Ensure it is NOT snake_case
    expect(call[1]).not.toHaveProperty("over_rides");
  });

  it("fleetChat payload carries overrides under camelCase key", async () => {
    localStorage.setItem("model.builder", "qwen2.5-coder:7b");
    invoke.mockResolvedValue("response");
    await fleetChat("builder", [{ role: "user", content: "hello" }]);
    const call = invoke.mock.calls[0];
    expect(call[1].overrides).toEqual({ builder: "qwen2.5-coder:7b" });
  });
});

describe("FLEET_DEFAULTS", () => {
  it("exposes the three default model strings", () => {
    expect(FLEET_DEFAULTS.builder).toBe("qwen3-coder:30b-a3b-q4_K_M");
    expect(FLEET_DEFAULTS.companion).toBe("gpt-oss:20b");
    expect(FLEET_DEFAULTS.rewriter).toBe("qwen3:1.7b");
  });
});

// ── builderChat — one brain ────────────────────────────────────────────────────

describe("builderChat", () => {
  it("routes to fleet_chat with the builder role and returns the text", async () => {
    invoke.mockResolvedValueOnce("fleet reply");
    const result = await builderChat([{ role: "user", content: "build it" }]);
    expect(invoke).toHaveBeenCalledWith("fleet_chat", expect.objectContaining({ role: "builder" }));
    expect(result).toBe("fleet reply");
  });

  it("never invokes a cloud command", async () => {
    localStorage.setItem("model.cloudBuilder", "anthropic"); // a retired key, ignored
    invoke.mockResolvedValueOnce("fleet reply");
    await builderChat([{ role: "user", content: "build it" }]);
    for (const call of invoke.mock.calls) expect(String(call[0])).not.toMatch(/cloud/);
  });
});


// ── Kernel self-edit wrappers (Phase 21) ────────────────────────────────────────

describe("kernel self-edit wrappers", () => {
  it("kernelEditable passes sourceRepo (null when omitted) and returns meta", async () => {
    invoke.mockResolvedValue({ root: "/repo", protected: ["src/main.tsx"] });
    const meta = await kernelEditable();
    expect(invoke).toHaveBeenCalledWith("kernel_editable", { sourceRepo: null });
    expect(meta.root).toBe("/repo");
    expect(meta.protected).toContain("src/main.tsx");
  });

  it("kernelEditable forwards a supplied sourceRepo override", async () => {
    invoke.mockResolvedValue({ root: "/x", protected: [] });
    await kernelEditable("/x");
    expect(invoke).toHaveBeenCalledWith("kernel_editable", { sourceRepo: "/x" });
  });

  it("kernelRead passes path + null sourceRepo and returns contents", async () => {
    invoke.mockResolvedValue("export const n = 1;");
    const src = await kernelRead("src/hello.ts");
    expect(invoke).toHaveBeenCalledWith("kernel_read", { path: "src/hello.ts", sourceRepo: null });
    expect(src).toContain("const n");
  });

  it("kernelPropose passes edits and returns { worktreeId, diff }", async () => {
    invoke.mockResolvedValue({ worktreeId: "wt1", diff: "--- a\n+++ b" });
    const edits = [{ path: "src/hello.ts", search: "1", replace: "2" }];
    const out = await kernelPropose(edits);
    expect(invoke).toHaveBeenCalledWith("kernel_propose", { edits, sourceRepo: null });
    expect(out.worktreeId).toBe("wt1");
    expect(out.diff).toContain("+++");
  });

  it("kernelValidate passes worktreeId and returns { ok, stage, output }", async () => {
    invoke.mockResolvedValue({ ok: false, stage: "tsc", output: "error TS2322" });
    const v = await kernelValidate("wt1");
    expect(invoke).toHaveBeenCalledWith("kernel_validate", { worktreeId: "wt1" });
    expect(v.ok).toBe(false);
    expect(v.stage).toBe("tsc");
  });

  it("kernelApply passes worktreeId + message and returns { sha, prevSha }", async () => {
    invoke.mockResolvedValue({ sha: "newsha", prevSha: "oldsha" });
    const a = await kernelApply("wt1", "tidy hello");
    expect(invoke).toHaveBeenCalledWith("kernel_apply", { worktreeId: "wt1", message: "tidy hello" });
    expect(a.sha).toBe("newsha");
    expect(a.prevSha).toBe("oldsha");
  });

  it("kernelDiscard passes worktreeId", async () => {
    invoke.mockResolvedValue(undefined);
    await kernelDiscard("wt1");
    expect(invoke).toHaveBeenCalledWith("kernel_discard", { worktreeId: "wt1" });
  });

  it("kernelRollback passes sha + null sourceRepo", async () => {
    invoke.mockResolvedValue(undefined);
    await kernelRollback("abc123");
    expect(invoke).toHaveBeenCalledWith("kernel_rollback", { sha: "abc123", sourceRepo: null });
  });

  it("kernelBootOk invokes kernel_boot_ok with no args", async () => {
    invoke.mockResolvedValue(undefined);
    await kernelBootOk();
    expect(invoke).toHaveBeenCalledWith("kernel_boot_ok");
  });

  it("kernelBootCheck passes null sourceRepo and returns { rolledBackTo }", async () => {
    invoke.mockResolvedValue({ rolledBackTo: "prev7" });
    const b = await kernelBootCheck();
    expect(invoke).toHaveBeenCalledWith("kernel_boot_check", { sourceRepo: null });
    expect(b.rolledBackTo).toBe("prev7");
  });

  it("kernelIdentity invokes kernel_identity with no args and returns the camelCase identity", async () => {
    invoke.mockResolvedValue({ mode: "packaged", genomeSha: "deadbeef", generation: "deadbeef", threaded: true, loomhome: "/x/loom", loomhomeBytes: 2_300_000_000 });
    const id = await kernelIdentity();
    expect(invoke).toHaveBeenCalledWith("kernel_identity");
    expect(id.mode).toBe("packaged");
    expect(id.loomhomeBytes).toBe(2_300_000_000);
    expect(id.genomeSha).toBe("deadbeef");
    expect(id.generation).toBe("deadbeef");
    expect(id.threaded).toBe(true);
    expect(id.loomhome).toBe("/x/loom");
  });

  it("generationsList invokes generations_list with no args and returns the camelCase rows", async () => {
    invoke.mockResolvedValue([
      { sha: "b".repeat(40), wovenAt: "2026-09-02T12:00:00Z", sizeBytes: 42, reason: "reweave", commitSubject: "feat: second weave", isCurrent: true, isPrevious: false },
      { sha: "a".repeat(40), wovenAt: "2026-09-01T12:00:00Z", sizeBytes: 41, reason: "reweave", commitSubject: "unknown", isCurrent: false, isPrevious: true },
    ]);
    const rows = await generationsList();
    expect(invoke).toHaveBeenCalledWith("generations_list");
    expect(rows).toHaveLength(2);
    expect(rows[0].isCurrent).toBe(true);
    expect(rows[0].commitSubject).toBe("feat: second weave");
    expect(rows[1].isPrevious).toBe(true);
    expect(rows[1].sizeBytes).toBe(41);
  });

  it("reweaveStart passes force (false by default)", async () => {
    invoke.mockResolvedValue(undefined);
    await reweaveStart();
    expect(invoke).toHaveBeenCalledWith("reweave_start", { force: false });
    await reweaveStart(true);
    expect(invoke).toHaveBeenCalledWith("reweave_start", { force: true });
  });

  it("reweaveCancel invokes reweave_cancel with no args", async () => {
    invoke.mockResolvedValue(undefined);
    await reweaveCancel();
    expect(invoke).toHaveBeenCalledWith("reweave_cancel");
  });

  it("reweaveState invokes reweave_state and returns the camelCase state", async () => {
    invoke.mockResolvedValue({
      stage: "core", targetSha: "abc", startedAt: "2026-09-02T10:00:00Z", elapsedMs: 1200,
      tail: ["Compiling loom"], outcome: null, cancellable: true, mode: "packaged",
    });
    const s = await reweaveState();
    expect(invoke).toHaveBeenCalledWith("reweave_state");
    expect(s.stage).toBe("core");
    expect(s.targetSha).toBe("abc");
    expect(s.elapsedMs).toBe(1200);
    expect(s.cancellable).toBe(true);
    expect(s.tail).toEqual(["Compiling loom"]);
  });

  it("generationsReturn passes the sha", async () => {
    invoke.mockResolvedValue(undefined);
    await generationsReturn("3f2a1c");
    expect(invoke).toHaveBeenCalledWith("generations_return", { sha: "3f2a1c" });
  });
});

describe("voice wrappers", () => {
  it("voiceStatus calls voice_status with no args", async () => {
    invoke.mockResolvedValue({ ready: false, whisper: false, voices: [], missing_bytes_hint: null });
    const status = await voiceStatus();
    expect(invoke).toHaveBeenCalledWith("voice_status");
    expect(status.ready).toBe(false);
  });

  it("voiceSetup calls voice_setup with no args", async () => {
    invoke.mockResolvedValue(undefined);
    await voiceSetup();
    expect(invoke).toHaveBeenCalledWith("voice_setup");
  });

  it("sttTranscribe passes samples array under the key 'samples'", async () => {
    invoke.mockResolvedValue("hello world");
    const text = await sttTranscribe([0.1, 0.2, 0.3]);
    expect(invoke).toHaveBeenCalledWith("stt_transcribe", { samples: [0.1, 0.2, 0.3] });
    expect(text).toBe("hello world");
  });

  it("ttsSpeak passes text and voiceId (camelCase) to tts_speak", async () => {
    invoke.mockResolvedValue([1, 2, 3]);
    const bytes = await ttsSpeak("Hello", "en_US-lessac-medium");
    expect(invoke).toHaveBeenCalledWith("tts_speak", {
      text: "Hello",
      voiceId: "en_US-lessac-medium",
    });
    expect(bytes).toEqual([1, 2, 3]);
  });
});

// ── ShellUnavailableError / safeInvoke browser-mode rejection ─────────────────

describe("ShellUnavailableError: browser-mode rejection", () => {
  it("fleetStatus rejects with ShellUnavailableError when Tauri is absent", async () => {
    // Simulate browser environment: remove Tauri globals
    const origInternals = (window as Record<string, unknown>).__TAURI_INTERNALS__;
    const origTauri = (window as Record<string, unknown>).__TAURI__;
    delete (window as Record<string, unknown>).__TAURI_INTERNALS__;
    delete (window as Record<string, unknown>).__TAURI__;
    try {
      await expect(fleetStatus()).rejects.toThrow("This surface needs the desktop shell.");
    } finally {
      if (origInternals !== undefined) (window as Record<string, unknown>).__TAURI_INTERNALS__ = origInternals;
      if (origTauri !== undefined) (window as Record<string, unknown>).__TAURI__ = origTauri;
    }
  });

  it("ShellUnavailableError message matches the LOOM-voice copy exactly", () => {
    const e = new ShellUnavailableError();
    expect(e.message).toBe("This surface needs the desktop shell.");
    expect(e.name).toBe("ShellUnavailableError");
  });
});


// ── Threading wrappers (Phase 23) ───────────────────────────────────────────────

describe("threading wrappers", () => {
  it("threadStatus invokes thread_status with no args and returns the camelCase status", async () => {
    invoke.mockResolvedValue({
      threaded: false,
      tools: [{ name: "cmake", path: null, version: null, requiredFor: "native deps (whisper.cpp)", install: "brew install cmake" }],
      missing: ["cmake"],
      drifted: [],
      steps: { seed: true, deps: false, vendor: false, warm: false, register: false },
      needsNetwork: true,
    });
    const s = await threadStatus();
    expect(invoke).toHaveBeenCalledWith("thread_status");
    expect(s.threaded).toBe(false);
    expect(s.missing).toEqual(["cmake"]);
    expect(s.tools[0].install).toBe("brew install cmake");
    expect(s.tools[0].requiredFor).toContain("native deps");
    expect(s.steps.seed).toBe(true);
    expect(s.needsNetwork).toBe(true);
  });

  it("threadLoom invokes thread_loom with no args and resolves once the job is spawned", async () => {
    invoke.mockResolvedValue(undefined);
    await expect(threadLoom()).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("thread_loom");
  });

  it("threadLoom surfaces the in-flight refusal as-is", async () => {
    invoke.mockRejectedValue({ kind: "parse", message: "threading already in flight" });
    await expect(threadLoom()).rejects.toEqual({ kind: "parse", message: "threading already in flight" });
  });

  it("threadCancel invokes thread_cancel with no args", async () => {
    invoke.mockResolvedValue(undefined);
    await expect(threadCancel()).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("thread_cancel");
  });

  it("THREAD_EVENT names the loom-thread channel", () => {
    expect(THREAD_EVENT).toBe("loom-thread");
  });
});
