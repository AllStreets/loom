import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { fleetStatus, fleetChat, organWrite, voiceStatus, voiceSetup, sttTranscribe, ttsSpeak } from "./core";

beforeEach(() => invoke.mockReset());

describe("core wrappers", () => {
  it("fleetStatus calls the right command and returns typed rows", async () => {
    invoke.mockResolvedValue([{ role: "companion", model: "gpt-oss:20b", present: true }]);
    const rows = await fleetStatus();
    expect(invoke).toHaveBeenCalledWith("fleet_status");
    expect(rows[0].role).toBe("companion");
  });
  it("fleetChat passes role, messages and snake_case opts", async () => {
    invoke.mockResolvedValue("hi");
    const out = await fleetChat("builder", [{ role: "user", content: "hey" }], { numCtx: 8192, temperature: 0.2 });
    expect(invoke).toHaveBeenCalledWith("fleet_chat", {
      role: "builder",
      messages: [{ role: "user", content: "hey" }],
      opts: { num_ctx: 8192, temperature: 0.2 },
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

  it("ttsSpeak passes text and voice_id (snake_case) to tts_speak", async () => {
    invoke.mockResolvedValue([1, 2, 3]);
    const bytes = await ttsSpeak("Hello", "en_US-lessac-medium");
    expect(invoke).toHaveBeenCalledWith("tts_speak", {
      text: "Hello",
      voice_id: "en_US-lessac-medium",
    });
    expect(bytes).toEqual([1, 2, 3]);
  });
});
