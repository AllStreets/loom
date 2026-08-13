/**
 * recorder.ts — 16kHz mono microphone capture
 *
 * Uses ScriptProcessorNode for webview simplicity (AudioWorklet would require
 * a separate worklet file and a secure context import; ScriptProcessor is
 * synchronous and works fine in Tauri's webview for this use-case).
 *
 * All Web Audio / getUserMedia calls are injectable via the `deps` parameter
 * so tests can run under jsdom without a real audio stack.
 */

import { audioLevel, envelope } from "../orb/audioLevel";

const SAMPLE_RATE = 16_000;
const PROCESSOR_SIZE = 4096;
const CAP_SAMPLES = 480_000; // 30s at 16kHz

export interface RecHandle {
  /** Stops recording, concatenates all chunks, tears down tracks + ctx. */
  stop(): Float32Array;
  /** Tears down tracks + ctx without returning audio. */
  cancel(): void;
  /** Called when the 30s cap is reached (auto-stop). */
  onAutoStop?: (cb: () => void) => void;
}

export interface RecorderDeps {
  getMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createCtx: (opts: { sampleRate: number }) => AudioContext;
}

function rms(chunk: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < chunk.length; i++) {
    sum += chunk[i] * chunk[i];
  }
  return Math.sqrt(sum / chunk.length);
}

/**
 * Start recording microphone audio.
 *
 * @param deps - Injectable factories for testing. Defaults to real Web Audio.
 * @throws Error with name="MicDenied" if the user denies mic permission.
 */
export async function startRecording(deps?: Partial<RecorderDeps>): Promise<RecHandle> {
  const getMedia =
    deps?.getMedia ??
    ((c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c));
  const createCtx =
    deps?.createCtx ??
    ((opts: { sampleRate: number }) => new AudioContext(opts));

  let stream: MediaStream;
  try {
    stream = await getMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
  } catch (err) {
    if (
      err != null &&
      typeof (err as { name?: unknown }).name === "string" &&
      ((err as { name: string }).name === "NotAllowedError" ||
        (err as { name: string }).name === "PermissionDeniedError")
    ) {
      const denied = new Error(
        "Microphone access was denied. Open System Settings > Privacy > Microphone and allow LOOM."
      );
      denied.name = "MicDenied";
      throw denied;
    }
    throw err;
  }

  const ctx = createCtx({ sampleRate: SAMPLE_RATE });
  const source = ctx.createMediaStreamSource(stream);
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const processor = ctx.createScriptProcessor(PROCESSOR_SIZE, 1, 1);

  const chunks: Float32Array[] = [];
  let totalSamples = 0;
  let capped = false;
  let autoStopCb: (() => void) | undefined;

  processor.onaudioprocess = (e: AudioProcessingEvent) => {
    if (capped) return;

    const input = e.inputBuffer.getChannelData(0);
    const remaining = CAP_SAMPLES - totalSamples;
    const slice =
      input.length <= remaining
        ? input.slice()
        : input.slice(0, remaining);

    chunks.push(slice);
    totalSamples += slice.length;

    // Drive audioLevel envelope
    audioLevel.current = envelope(audioLevel.current, rms(slice));

    if (totalSamples >= CAP_SAMPLES) {
      capped = true;
      teardown();
      autoStopCb?.();
    }
  };

  source.connect(processor);
  processor.connect(ctx.destination);

  function teardown() {
    try {
      source.disconnect();
      processor.disconnect();
      for (const track of stream.getTracks()) {
        track.stop();
      }
      ctx.close();
    } catch {
      // Ignore teardown errors (already closed, etc.)
    }
  }

  function concat(): Float32Array {
    const out = new Float32Array(totalSamples);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  const handle: RecHandle = {
    stop() {
      teardown();
      return concat();
    },
    cancel() {
      teardown();
    },
    onAutoStop(cb) {
      autoStopCb = cb;
    },
  };

  return handle;
}
