import { describe, it, expect, vi, beforeEach } from "vitest";
import { startRecording } from "./recorder";
import { audioLevel } from "../orb/audioLevel";

beforeEach(() => {
  audioLevel.current = 0;
});

// ── Fake MediaStream / AudioContext helpers ────────────────────────────────────

function makeTrack() {
  return { stop: vi.fn() };
}

function makeStream(tracks = [makeTrack()]) {
  return { getTracks: () => tracks } as unknown as MediaStream;
}

interface FakeProcessorNode {
  onaudioprocess: ((e: AudioProcessingEvent) => void) | null;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  _fireChunk: (data: Float32Array) => void;
}

interface FakeSourceNode {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

interface FakeCtx {
  createMediaStreamSource: () => FakeSourceNode;
  createScriptProcessor: () => FakeProcessorNode;
  destination: object;
  close: ReturnType<typeof vi.fn>;
}

function makeCtx(): { ctx: FakeCtx; processor: FakeProcessorNode } {
  const processor: FakeProcessorNode = {
    onaudioprocess: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
    _fireChunk(data: Float32Array) {
      const e = {
        inputBuffer: {
          getChannelData: (_ch: number) => data,
        },
      } as unknown as AudioProcessingEvent;
      this.onaudioprocess?.(e);
    },
  };

  const source: FakeSourceNode = {
    connect: vi.fn(),
    disconnect: vi.fn(),
  };

  const ctx: FakeCtx = {
    createMediaStreamSource: () => source,
    createScriptProcessor: () => processor,
    destination: {},
    close: vi.fn(),
  };

  return { ctx, processor };
}

function makeDeps(stream: MediaStream, ctx: FakeCtx) {
  return {
    getMedia: async () => stream,
    createCtx: () => ctx as unknown as AudioContext,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("recorder — chunk accumulation + stop", () => {
  it("stop() concatenates accumulated chunks into a Float32Array", async () => {
    const stream = makeStream();
    const { ctx, processor } = makeCtx();

    const handle = await startRecording(makeDeps(stream, ctx));

    const chunk1 = new Float32Array([0.1, 0.2, 0.3]);
    const chunk2 = new Float32Array([0.4, 0.5]);
    processor._fireChunk(chunk1);
    processor._fireChunk(chunk2);

    const result = handle.stop();

    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(5);
    // Float32 precision — use closeTo for each element
    expect(result[0]).toBeCloseTo(0.1, 5);
    expect(result[1]).toBeCloseTo(0.2, 5);
    expect(result[2]).toBeCloseTo(0.3, 5);
    expect(result[3]).toBeCloseTo(0.4, 5);
    expect(result[4]).toBeCloseTo(0.5, 5);
  });

  it("cancel() tears down without returning audio", async () => {
    const tracks = [makeTrack()];
    const stream = makeStream(tracks);
    const { ctx, processor } = makeCtx();

    const handle = await startRecording(makeDeps(stream, ctx));
    processor._fireChunk(new Float32Array([0.1, 0.2]));
    handle.cancel();

    expect(ctx.close).toHaveBeenCalled();
    expect(tracks[0].stop).toHaveBeenCalled();
  });

  it("stop() tears down tracks and ctx", async () => {
    const tracks = [makeTrack()];
    const stream = makeStream(tracks);
    const { ctx, processor } = makeCtx();

    const handle = await startRecording(makeDeps(stream, ctx));
    processor._fireChunk(new Float32Array([0.5]));
    handle.stop();

    expect(ctx.close).toHaveBeenCalled();
    expect(tracks[0].stop).toHaveBeenCalled();
  });

  it("drives audioLevel.current after each chunk", async () => {
    const stream = makeStream();
    const { ctx, processor } = makeCtx();

    const handle = await startRecording(makeDeps(stream, ctx));
    expect(audioLevel.current).toBe(0);

    processor._fireChunk(new Float32Array([1, 1, 1, 1])); // rms = 1.0
    expect(audioLevel.current).toBeGreaterThan(0);

    handle.cancel();
  });
});

describe("recorder — 30s cap auto-stop", () => {
  it("auto-stop fires and calls onAutoStop callback when cap reached", async () => {
    const stream = makeStream();
    const { ctx, processor } = makeCtx();

    const handle = await startRecording(makeDeps(stream, ctx));

    const cbSpy = vi.fn();
    handle.onAutoStop?.(cbSpy);

    // Fire enough chunks to exceed 480_000 samples
    // 4096 * 118 = 483328 > 480000
    const chunk = new Float32Array(4096).fill(0.1);
    for (let i = 0; i < 118; i++) {
      processor._fireChunk(chunk);
    }

    expect(cbSpy).toHaveBeenCalledOnce();
  });

  it("stops accumulating samples after cap", async () => {
    const stream = makeStream();
    const { ctx, processor } = makeCtx();

    const handle = await startRecording(makeDeps(stream, ctx));
    handle.onAutoStop?.(() => {});

    const chunk = new Float32Array(4096).fill(0.1);
    for (let i = 0; i < 120; i++) {
      processor._fireChunk(chunk);
    }

    const result = handle.stop();
    // Should be capped at exactly 480_000
    expect(result.length).toBeLessThanOrEqual(480_000);
  });
});

describe("recorder — mic denial", () => {
  it("throws MicDenied error for NotAllowedError", async () => {
    const notAllowed = new DOMException("", "NotAllowedError");
    const deps = {
      getMedia: async () => { throw notAllowed; },
      createCtx: () => ({} as AudioContext),
    };

    await expect(startRecording(deps)).rejects.toMatchObject({
      name: "MicDenied",
    });
  });

  it("includes a human-readable message in MicDenied", async () => {
    const notAllowed = new DOMException("", "NotAllowedError");
    const deps = {
      getMedia: async () => { throw notAllowed; },
      createCtx: () => ({} as AudioContext),
    };

    await expect(startRecording(deps)).rejects.toMatchObject({
      name: "MicDenied",
      message: expect.stringContaining("Microphone"),
    });
  });

  it("re-throws non-denial errors as-is", async () => {
    const other = new Error("device not found");
    other.name = "NotFoundError";
    const deps = {
      getMedia: async () => { throw other; },
      createCtx: () => ({} as AudioContext),
    };

    await expect(startRecording(deps)).rejects.toMatchObject({
      name: "NotFoundError",
    });
  });
});
