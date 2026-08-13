import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useVoice } from "./useVoice";

describe("useVoice state machine", () => {
  let dispatchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dispatchSpy = vi.spyOn(window, "dispatchEvent");
  });
  afterEach(() => {
    dispatchSpy.mockRestore();
    vi.clearAllMocks();
  });

  function moodEvents() {
    return dispatchSpy.mock.calls
      .map((c) => c[0] as CustomEvent)
      .filter((e) => e.type === "loom-mood")
      .map((e) => (e as CustomEvent<{ mood: string }>).detail.mood);
  }

  it("starts idle", () => {
    const { result } = renderHook(() => useVoice({
      status: async () => ({ ready: true }),
      record: async () => ({ stop: () => new Float32Array(0), cancel: vi.fn() }),
      transcribe: async () => "",
    }));
    expect(result.current.state).toBe("idle");
    expect(result.current.error).toBeNull();
  });

  it("not-ready: start() -> unavailable + error, never enters listening", async () => {
    const { result } = renderHook(() => useVoice({
      status: async () => ({ ready: false }),
      record: vi.fn(),
      transcribe: vi.fn(),
    }));
    await act(async () => { await result.current.start(); });
    expect(result.current.state).toBe("unavailable");
    expect(result.current.error).toMatch(/Voice isn't set up/);
    // moodEvents should NOT contain "listening"
    expect(moodEvents()).not.toContain("listening");
  });

  it("mic denied: start() -> unavailable with denied message", async () => {
    const micDenied = new Error("Microphone access was denied.");
    micDenied.name = "MicDenied";
    const { result } = renderHook(() => useVoice({
      status: async () => ({ ready: true }),
      record: async () => { throw micDenied; },
      transcribe: vi.fn(),
    }));
    await act(async () => { await result.current.start(); });
    expect(result.current.state).toBe("unavailable");
    expect(result.current.error).toMatch(/Microphone access was denied/);
  });

  it("short audio (<6400 samples): stop() -> idle, no loom-utterance", async () => {
    const shortSamples = new Float32Array(100);
    const utteranceSpy = vi.fn();
    window.addEventListener("loom-utterance", utteranceSpy);

    const { result } = renderHook(() => useVoice({
      status: async () => ({ ready: true }),
      record: async () => ({ stop: () => shortSamples, cancel: vi.fn() }),
      transcribe: async () => "hello",
    }));

    await act(async () => { await result.current.start(); });
    expect(result.current.state).toBe("listening");

    await act(async () => { await result.current.stop(); });
    expect(result.current.state).toBe("idle");
    expect(utteranceSpy).not.toHaveBeenCalled();

    window.removeEventListener("loom-utterance", utteranceSpy);
  });

  it("normal path: start -> listening -> stop -> transcribing -> idle, dispatches loom-utterance", async () => {
    const bigSamples = new Float32Array(16000); // 1s
    const utteranceSpy = vi.fn();
    window.addEventListener("loom-utterance", utteranceSpy);

    const { result } = renderHook(() => useVoice({
      status: async () => ({ ready: true }),
      record: async () => ({ stop: () => bigSamples, cancel: vi.fn() }),
      transcribe: async () => "hello world",
    }));

    await act(async () => { await result.current.start(); });
    expect(result.current.state).toBe("listening");
    expect(moodEvents()).toContain("listening");

    await act(async () => { await result.current.stop(); });
    expect(result.current.state).toBe("idle");
    expect(utteranceSpy).toHaveBeenCalledTimes(1);
    const detail = (utteranceSpy.mock.calls[0][0] as CustomEvent<{ text: string; spoken: boolean }>).detail;
    expect(detail.text).toBe("hello world");
    expect(detail.spoken).toBe(true);

    window.removeEventListener("loom-utterance", utteranceSpy);
  });

  it("empty transcription: stop() -> idle with 'Didn't catch that.' error", async () => {
    const bigSamples = new Float32Array(16000);
    const { result } = renderHook(() => useVoice({
      status: async () => ({ ready: true }),
      record: async () => ({ stop: () => bigSamples, cancel: vi.fn() }),
      transcribe: async () => "",
    }));

    await act(async () => { await result.current.start(); });
    await act(async () => { await result.current.stop(); });
    expect(result.current.state).toBe("idle");
    expect(result.current.error).toMatch(/Didn't catch that/);
  });

  it("transcribe throws: stop() -> idle with error set (never stuck)", async () => {
    const bigSamples = new Float32Array(16000);
    const { result } = renderHook(() => useVoice({
      status: async () => ({ ready: true }),
      record: async () => ({ stop: () => bigSamples, cancel: vi.fn() }),
      transcribe: async () => { throw new Error("STT engine failed"); },
    }));

    await act(async () => { await result.current.start(); });
    await act(async () => { await result.current.stop(); });
    expect(result.current.state).toBe("idle");
    expect(result.current.error).toMatch(/STT engine failed/);
  });

  it("cancel() -> idle + loom-mood idle", async () => {
    const cancelFn = vi.fn();
    const { result } = renderHook(() => useVoice({
      status: async () => ({ ready: true }),
      record: async () => ({ stop: () => new Float32Array(16000), cancel: cancelFn }),
      transcribe: async () => "x",
    }));

    await act(async () => { await result.current.start(); });
    expect(result.current.state).toBe("listening");

    act(() => { result.current.cancel(); });
    expect(result.current.state).toBe("idle");
    expect(cancelFn).toHaveBeenCalled();
    expect(moodEvents()).toContain("idle");
  });
});
