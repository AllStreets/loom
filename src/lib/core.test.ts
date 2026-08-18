import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { fleetStatus, fleetChat, organWrite, voiceStatus, voiceSetup, sttTranscribe, ttsSpeak, modelOverrides, FLEET_DEFAULTS, builderChat, cloudKeySet, cloudKeyPresent, cloudKeyClear } from "./core";

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
