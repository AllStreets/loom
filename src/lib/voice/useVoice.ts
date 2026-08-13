/**
 * useVoice.ts — push-to-talk state machine hook
 *
 * States: idle | listening | transcribing | speaking | unavailable
 * Every path ends in idle or unavailable — never stuck.
 */

import { useRef, useState } from "react";
import { voiceStatus, sttTranscribe } from "../core";
import { startRecording } from "./recorder";
import { dispatchMood } from "../orb/moods";
import type { RecHandle } from "./recorder";

// ── Types ──────────────────────────────────────────────────────────────────────

export type VoiceState = "idle" | "listening" | "transcribing" | "speaking" | "unavailable";

export interface VoiceDeps {
  status?: () => Promise<{ ready: boolean }>;
  record?: (deps?: unknown) => Promise<{ stop(): Float32Array; cancel(): void }>;
  transcribe?: (samples: number[]) => Promise<string>;
}

export interface UseVoiceResult {
  state: VoiceState;
  start(): Promise<void>;
  stop(): Promise<void>;
  cancel(): void;
  error: string | null;
}

// ── Module-level cache ─────────────────────────────────────────────────────────

// Shared 60s voiceStatus cache for production use (real deps path only)
const _realStatusCache = { result: null as { ready: boolean } | null, ts: 0 };
const STATUS_TTL_MS = 60_000;

// ── Hook ───────────────────────────────────────────────────────────────────────

export function useVoice(deps?: VoiceDeps): UseVoiceResult {
  const [state, setState] = useState<VoiceState>("idle");
  const [error, setError] = useState<string | null>(null);

  const handleRef = useRef<RecHandle | null>(null);

  // Resolve injectable deps
  const getStatus = deps?.status ?? voiceStatus;
  const getRecord = deps?.record ?? startRecording;
  const getTranscribe = deps?.transcribe ?? sttTranscribe;

  // Use per-instance cache when injected deps are provided (tests),
  // use the shared module-level cache for real production use.
  const instanceCacheRef = useRef<{ result: { ready: boolean } | null; ts: number }>(
    deps?.status ? { result: null, ts: 0 } : _realStatusCache
  );

  async function start(): Promise<void> {
    // Fetch voiceStatus with 60s cache
    let status: { ready: boolean };
    const cache = instanceCacheRef.current;
    const now = Date.now();
    if (cache.result !== null && now - cache.ts < STATUS_TTL_MS) {
      status = cache.result;
    } else {
      try {
        status = await getStatus();
        cache.result = status;
        cache.ts = Date.now();
      } catch (err) {
        setState("idle");
        setError(err instanceof Error ? err.message : String(err));
        return;
      }
    }

    if (!status.ready) {
      setState("unavailable");
      setError("Voice isn't set up — open Settings");
      window.dispatchEvent(new CustomEvent("organ-focus", { detail: { id: "settings" } }));
      return;
    }

    // Attempt to start recording
    let handle: RecHandle;
    try {
      handle = await (getRecord as typeof startRecording)();
    } catch (err) {
      if (err instanceof Error && err.name === "MicDenied") {
        setState("unavailable");
        setError(err.message);
        return;
      }
      setState("idle");
      setError(err instanceof Error ? err.message : String(err));
      return;
    }

    handleRef.current = handle;
    dispatchMood("listening");
    setState("listening");
  }

  async function stop(): Promise<void> {
    const handle = handleRef.current;
    if (!handle) return;
    handleRef.current = null;

    const samples = handle.stop();

    const MIN_SAMPLES = 6400; // 0.4s at 16kHz
    if (samples.length < MIN_SAMPLES) {
      setState("idle");
      dispatchMood("idle");
      setError(null);
      return;
    }

    setState("transcribing");
    dispatchMood("thinking");

    let text: string;
    try {
      text = await getTranscribe(Array.from(samples));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState("idle");
      dispatchMood("idle");
      return;
    }

    if (text && text.trim().length > 0) {
      window.dispatchEvent(
        new CustomEvent("loom-utterance", { detail: { text, spoken: true } })
      );
      setState("idle");
      dispatchMood("idle");
      setError(null);
    } else {
      setError("Didn't catch that.");
      setState("idle");
      dispatchMood("idle");
    }
  }

  function cancel(): void {
    const handle = handleRef.current;
    if (handle) {
      handle.cancel();
      handleRef.current = null;
    }
    setState("idle");
    dispatchMood("idle");
    setError(null);
  }

  return { state, start, stop, cancel, error };
}
