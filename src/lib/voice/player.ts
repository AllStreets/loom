/**
 * player.ts — WAV bytes → AudioContext playback
 *
 * Drives audioLevel via an AnalyserNode each animation frame while playing.
 * Starting a new playWav() stops any currently playing audio.
 *
 * ctx creation is injectable via `deps` for tests (jsdom has no AudioContext).
 */

import { audioLevel, envelope } from "../orb/audioLevel";

export interface PlayerCtx {
  decodeAudioData(buffer: ArrayBuffer): Promise<AudioBuffer>;
  createBufferSource(): AudioBufferSourceNode;
  createAnalyser(): AnalyserNode;
  destination: AudioNode;
}

export interface PlayerDeps {
  createCtx: () => PlayerCtx;
  requestAnimationFrame: (cb: FrameRequestCallback) => number;
  cancelAnimationFrame: (id: number) => void;
}

// Currently active playback — used by stopPlayback() and by guard-doubles logic
let currentResolve: (() => void) | null = null;
let currentSource: AudioBufferSourceNode | null = null;
let currentRafId: number | null = null;
let currentRafCancel: ((id: number) => void) | null = null;

function stopCurrent() {
  if (currentSource) {
    try {
      currentSource.onended = null;
      currentSource.stop();
    } catch {
      // Already stopped
    }
    currentSource = null;
  }
  if (currentRafId !== null && currentRafCancel) {
    currentRafCancel(currentRafId);
    currentRafId = null;
  }
  if (currentResolve) {
    currentResolve();
    currentResolve = null;
  }
}

/**
 * Decode and play WAV bytes. Resolves when playback ends naturally or
 * when stopPlayback() is called. Starting a second playWav() stops the first.
 */
export async function playWav(bytes: Uint8Array, deps?: Partial<PlayerDeps>): Promise<void> {
  // Guard doubles — stop any in-flight playback first
  stopCurrent();

  const createCtx = deps?.createCtx ?? (() => new AudioContext() as unknown as PlayerCtx);
  const raf = deps?.requestAnimationFrame ?? ((cb: FrameRequestCallback) => requestAnimationFrame(cb));
  const caf = deps?.cancelAnimationFrame ?? ((id: number) => cancelAnimationFrame(id));

  const ctx = createCtx();
  const buffer = await ctx.decodeAudioData(bytes.buffer.slice(0) as ArrayBuffer);

  const source = ctx.createBufferSource();
  source.buffer = buffer;

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  const data = new Uint8Array(analyser.frequencyBinCount);

  source.connect(analyser);
  analyser.connect(ctx.destination);

  return new Promise<void>((resolve) => {
    currentResolve = resolve;
    currentSource = source;
    currentRafCancel = caf;

    function tick() {
      if (!currentSource) return; // stopped externally
      analyser.getByteTimeDomainData(data);
      // Convert 0-255 domain data to 0-1 amplitude and feed envelope
      let sumSq = 0;
      for (let i = 0; i < data.length; i++) {
        const s = (data[i] - 128) / 128;
        sumSq += s * s;
      }
      const rmsVal = Math.sqrt(sumSq / data.length);
      audioLevel.current = envelope(audioLevel.current, rmsVal);
      currentRafId = raf(tick);
    }

    source.onended = () => {
      // Clean up rAF
      if (currentRafId !== null) {
        caf(currentRafId);
        currentRafId = null;
      }
      currentSource = null;
      currentResolve = null;
      resolve();
    };

    source.start();
    currentRafId = raf(tick);
  });
}

/**
 * Stop the currently playing audio (if any) and resolve its promise.
 */
export function stopPlayback(): void {
  stopCurrent();
}
