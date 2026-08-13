import { describe, it, expect, vi, beforeEach } from "vitest";
import { playWav, stopPlayback } from "./player";
import { audioLevel } from "../orb/audioLevel";

beforeEach(() => {
  audioLevel.current = 0;
});

// ── Fake AudioContext helpers ──────────────────────────────────────────────────

interface FakeSource {
  buffer: AudioBuffer | null;
  connect: ReturnType<typeof vi.fn>;
  onended: (() => void) | null;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  _triggerEnded: () => void;
}

interface FakeAnalyser {
  fftSize: number;
  frequencyBinCount: number;
  connect: ReturnType<typeof vi.fn>;
  getByteTimeDomainData: ReturnType<typeof vi.fn>;
}

interface FakeCtxInstance {
  decodeAudioData: ReturnType<typeof vi.fn>;
  createBufferSource: () => FakeSource;
  createAnalyser: () => FakeAnalyser;
  destination: object;
  _source: FakeSource;
  _analyser: FakeAnalyser;
}

function makeFakeCtx(): FakeCtxInstance {
  const source: FakeSource = {
    buffer: null,
    connect: vi.fn(),
    onended: null,
    start: vi.fn(),
    stop: vi.fn(),
    _triggerEnded() {
      this.onended?.();
    },
  };

  const analyser: FakeAnalyser = {
    fftSize: 256,
    frequencyBinCount: 128,
    connect: vi.fn(),
    getByteTimeDomainData: vi.fn((arr: Uint8Array) => {
      // Fill with 128 (silence) — rms will be ~0
      arr.fill(128);
    }),
  };

  const fakeBuffer = {} as AudioBuffer;

  const ctx: FakeCtxInstance = {
    decodeAudioData: vi.fn(async () => fakeBuffer),
    createBufferSource: () => source,
    createAnalyser: () => analyser,
    destination: {},
    _source: source,
    _analyser: analyser,
  };

  return ctx;
}

// Flush microtask queue (lets async/await internals settle one tick at a time)
const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));

// Minimal RAF shim — calls callback once synchronously so we can verify it runs
function makeRaf() {
  let counter = 0;
  const calls = new Map<number, FrameRequestCallback>();
  const raf = vi.fn((cb: FrameRequestCallback) => {
    const id = ++counter;
    calls.set(id, cb);
    return id;
  });
  const caf = vi.fn((id: number) => {
    calls.delete(id);
  });
  // Drain all pending rAF callbacks (simulate one frame)
  function flush(ts = 0) {
    const pending = Array.from(calls.entries());
    calls.clear();
    for (const [, cb] of pending) {
      cb(ts);
    }
  }
  return { raf, caf, flush };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("player — resolves on ended", () => {
  it("resolves the promise when source onended fires", async () => {
    const ctx = makeFakeCtx();
    const { raf, caf } = makeRaf();

    const promise = playWav(new Uint8Array(44), {
      createCtx: () => ctx as unknown as import("./player").PlayerCtx,
      requestAnimationFrame: raf,
      cancelAnimationFrame: caf,
    });

    // Flush microtasks so decodeAudioData resolves and source is wired up
    await flushMicrotasks();

    // Trigger ended
    ctx._source._triggerEnded();

    await expect(promise).resolves.toBeUndefined();
  });

  it("calls decodeAudioData with the provided buffer", async () => {
    const ctx = makeFakeCtx();
    const { raf, caf } = makeRaf();
    const bytes = new Uint8Array([1, 2, 3, 4]);

    const promise = playWav(bytes, {
      createCtx: () => ctx as unknown as import("./player").PlayerCtx,
      requestAnimationFrame: raf,
      cancelAnimationFrame: caf,
    });

    await flushMicrotasks();
    ctx._source._triggerEnded();
    await promise;

    expect(ctx.decodeAudioData).toHaveBeenCalled();
  });

  it("calls source.start()", async () => {
    const ctx = makeFakeCtx();
    const { raf, caf } = makeRaf();

    const promise = playWav(new Uint8Array(44), {
      createCtx: () => ctx as unknown as import("./player").PlayerCtx,
      requestAnimationFrame: raf,
      cancelAnimationFrame: caf,
    });

    await flushMicrotasks();
    ctx._source._triggerEnded();
    await promise;

    expect(ctx._source.start).toHaveBeenCalled();
  });
});

describe("player — stopPlayback stops current and resolves promise", () => {
  it("resolves the pending promise when stopPlayback() is called", async () => {
    const ctx = makeFakeCtx();
    const { raf, caf } = makeRaf();

    const promise = playWav(new Uint8Array(44), {
      createCtx: () => ctx as unknown as import("./player").PlayerCtx,
      requestAnimationFrame: raf,
      cancelAnimationFrame: caf,
    });

    // Let decodeAudioData settle so currentResolve is set
    await flushMicrotasks();

    stopPlayback();

    await expect(promise).resolves.toBeUndefined();
  });
});

describe("player — double-start stops previous", () => {
  it("starting a second playWav stops and resolves the first", async () => {
    const ctx1 = makeFakeCtx();
    const ctx2 = makeFakeCtx();
    const { raf: raf1, caf: caf1 } = makeRaf();
    const { raf: raf2, caf: caf2 } = makeRaf();

    const promise1 = playWav(new Uint8Array(44), {
      createCtx: () => ctx1 as unknown as import("./player").PlayerCtx,
      requestAnimationFrame: raf1,
      cancelAnimationFrame: caf1,
    });

    // Let first decodeAudioData settle so currentResolve is registered
    await flushMicrotasks();

    // Start second — should stop first
    const promise2 = playWav(new Uint8Array(44), {
      createCtx: () => ctx2 as unknown as import("./player").PlayerCtx,
      requestAnimationFrame: raf2,
      cancelAnimationFrame: caf2,
    });

    // First promise should resolve (was stopped by second)
    await expect(promise1).resolves.toBeUndefined();

    // Clean up second
    await flushMicrotasks();
    ctx2._source._triggerEnded();
    await promise2;
  });
});

describe("player — drives audioLevel via rAF", () => {
  it("schedules requestAnimationFrame while playing", async () => {
    const ctx = makeFakeCtx();
    const { raf, caf } = makeRaf();

    const promise = playWav(new Uint8Array(44), {
      createCtx: () => ctx as unknown as import("./player").PlayerCtx,
      requestAnimationFrame: raf,
      cancelAnimationFrame: caf,
    });

    // Flush so decodeAudioData resolves and source.start + raf are called
    await flushMicrotasks();

    expect(raf).toHaveBeenCalled();

    ctx._source._triggerEnded();
    await promise;
  });
});
