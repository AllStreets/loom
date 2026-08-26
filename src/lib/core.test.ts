import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { fleetStatus, fleetChat, organWrite, voiceStatus, voiceSetup, sttTranscribe, ttsSpeak, modelOverrides, FLEET_DEFAULTS, builderChat, cloudKeySet, cloudKeyPresent, cloudKeyClear, ShellUnavailableError, quoteFetch, marketChart, marketCrypto, marketBook, marketTrades, marketFx, kernelEditable, kernelRead, kernelPropose, kernelValidate, kernelApply, kernelDiscard, kernelRollback, kernelBootOk, kernelBootCheck } from "./core";

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

// ── builderChat routing ────────────────────────────────────────────────────────

describe("builderChat routing", () => {
  it("(a) cloudBuilder='anthropic' + key present → cloud_chat invoked, brain='cloud'", async () => {
    localStorage.setItem("model.cloudBuilder", "anthropic");
    // cloudKeyPresent returns true
    invoke.mockResolvedValueOnce(true);
    // cloud_chat returns text
    invoke.mockResolvedValueOnce("cloud reply");
    const result = await builderChat([{ role: "user", content: "build it" }]);
    expect(invoke).toHaveBeenCalledWith("cloud_key_present");
    expect(invoke).toHaveBeenCalledWith("cloud_chat", expect.objectContaining({ system: "", messages: [{ role: "user", content: "build it" }] }));
    expect(result.brain).toBe("cloud");
    expect(result.text).toBe("cloud reply");
  });

  it("(b) cloudBuilder='off' → fleet_chat invoked, brain='local'", async () => {
    localStorage.setItem("model.cloudBuilder", "off");
    invoke.mockResolvedValueOnce("fleet reply");
    const result = await builderChat([{ role: "user", content: "build it" }]);
    expect(invoke).toHaveBeenCalledWith("fleet_chat", expect.objectContaining({ role: "builder" }));
    expect(result.brain).toBe("local");
    expect(result.text).toBe("fleet reply");
  });

  it("(c) cloud_chat rejects → fleet_chat fallback, brain='local'", async () => {
    localStorage.setItem("model.cloudBuilder", "anthropic");
    // cloudKeyPresent returns true
    invoke.mockResolvedValueOnce(true);
    // cloud_chat throws
    invoke.mockRejectedValueOnce(new Error("cloud error"));
    // fleet_chat fallback
    invoke.mockResolvedValueOnce("fallback reply");
    const result = await builderChat([{ role: "user", content: "build it" }]);
    expect(result.brain).toBe("local");
    expect(result.text).toBe("fallback reply");
  });
});

// ── cloudKey wrappers ──────────────────────────────────────────────────────────

describe("cloudKey wrappers", () => {
  it("cloudKeySet invokes 'cloud_key_set' with { key }", async () => {
    invoke.mockResolvedValueOnce(undefined);
    await cloudKeySet("sk-ant-test");
    expect(invoke).toHaveBeenCalledWith("cloud_key_set", { key: "sk-ant-test" });
  });

  it("cloudKeyPresent invokes 'cloud_key_present' with no args", async () => {
    invoke.mockResolvedValueOnce(true);
    const present = await cloudKeyPresent();
    expect(invoke).toHaveBeenCalledWith("cloud_key_present");
    expect(present).toBe(true);
  });

  it("cloudKeyClear invokes 'cloud_key_clear' with no args", async () => {
    invoke.mockResolvedValueOnce(undefined);
    await cloudKeyClear();
    expect(invoke).toHaveBeenCalledWith("cloud_key_clear");
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

  it("quoteFetch invokes quote_fetch with camelCase symbols arg", async () => {
    invoke.mockResolvedValue('[{"symbol":"SPY","body":null}]');
    const result = await quoteFetch(["SPY"]);
    expect(invoke).toHaveBeenCalledWith("quote_fetch", { symbols: ["SPY"] });
    expect(result).toBe('[{"symbol":"SPY","body":null}]');
  });

  it("quoteFetch passes multiple symbols as an array", async () => {
    invoke.mockResolvedValue('[{"symbol":"SPY","body":null},{"symbol":"^VIX","body":null}]');
    await quoteFetch(["SPY", "^VIX"]);
    expect(invoke).toHaveBeenCalledWith("quote_fetch", { symbols: ["SPY", "^VIX"] });
  });
});

// ── Market engine wrappers ─────────────────────────────────────────────────────

describe("market engine wrappers", () => {
  it("marketChart invokes market_chart with symbol and returns the typed shape", async () => {
    const chart = { symbol: "SPY", name: "S&P 500", price: 450.5, prevClose: 445, open: 447.5, high: 451.5, low: 447, volume: 4500, closes: [448, 450.5], timestamps: [1000, 1120] };
    invoke.mockResolvedValue(chart);
    const out = await marketChart("SPY");
    expect(invoke).toHaveBeenCalledWith("market_chart", { symbol: "SPY" });
    expect(out.prevClose).toBe(445);
    expect(out.closes).toHaveLength(2);
  });

  it("marketCrypto invokes market_crypto with product", async () => {
    invoke.mockResolvedValue({ product: "BTC-USD", price: 77361.43, changePct24h: -0.02 });
    const out = await marketCrypto("BTC-USD");
    expect(invoke).toHaveBeenCalledWith("market_crypto", { product: "BTC-USD" });
    expect(out.price).toBe(77361.43);
  });

  it("marketBook passes product and depth", async () => {
    invoke.mockResolvedValue({ product: "BTC-USD", bids: [], asks: [] });
    await marketBook("BTC-USD", 12);
    expect(invoke).toHaveBeenCalledWith("market_book", { product: "BTC-USD", depth: 12 });
  });

  it("marketTrades invokes market_trades with product and returns the array", async () => {
    invoke.mockResolvedValue([{ tradeId: 1, time: "t", price: 1, size: 2, side: "buy" }]);
    const out = await marketTrades("ETH-USD");
    expect(invoke).toHaveBeenCalledWith("market_trades", { product: "ETH-USD" });
    expect(out[0].tradeId).toBe(1);
  });

  it("marketFx passes base and symbols array", async () => {
    invoke.mockResolvedValue({ base: "USD", date: "2026-08-21", rates: { EUR: 0.85 } });
    const out = await marketFx("USD", ["EUR", "GBP", "JPY"]);
    expect(invoke).toHaveBeenCalledWith("market_fx", { base: "USD", symbols: ["EUR", "GBP", "JPY"] });
    expect(out.rates.EUR).toBe(0.85);
  });
});
