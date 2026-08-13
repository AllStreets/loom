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

// ── Space PTT handler factory (exported for tests) ────────────────────────────

export function makeSpacePttHandlers(voice: Pick<UseVoiceResult, "start" | "stop">) {
  function onKeyDown(e: KeyboardEvent) {
    if (e.code !== "Space" || e.repeat) return;
    const target = e.target as HTMLElement;
    if (
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable ||
      target.contentEditable === "true"
    ) return;
    e.preventDefault();
    void voice.start();
  }
  function onKeyUp(e: KeyboardEvent) {
    if (e.code !== "Space") return;
    void voice.stop();
  }
  return { onKeyDown, onKeyUp };
}

// ── Module-level cache ─────────────────────────────────────────────────────────

// Shared 60s voiceStatus cache for production use (real deps path only)
const _realStatusCache = { result: null as { ready: boolean } | null, ts: 0 };
const STATUS_TTL_MS = 60_000;

// ── Transcription timeout ──────────────────────────────────────────────────────

const TRANSCRIBE_TIMEOUT_MS = 20_000;

// ── Hook ───────────────────────────────────────────────────────────────────────

export function useVoice(deps?: VoiceDeps): UseVoiceResult {
  const [state, setState] = useState<VoiceState>("idle");
  const [error, setError] = useState<string | null>(null);

  const handleRef = useRef<RecHandle | null>(null);
  // stateRef kept in sync with state for guards that must read current value
  const stateRef = useRef<VoiceState>("idle");
  const cancelledRef = useRef<boolean>(false);
  // startingRef prevents concurrent start() calls from both proceeding
  const startingRef = useRef<boolean>(false);

  function syncState(s: VoiceState) {
    stateRef.current = s;
    setState(s);
  }

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
    // C2: double-start guard — read stateRef to avoid stale closure
    const cur = stateRef.current;
    if (cur !== "idle" && cur !== "unavailable") return;
    if (startingRef.current) return;
    startingRef.current = true;

    try {
      // Reset cancelled flag for this new recording session
      cancelledRef.current = false;

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
          syncState("idle");
          setError(err instanceof Error ? err.message : String(err));
          return;
        }
      }

      if (!status.ready) {
        syncState("unavailable");
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
          syncState("unavailable");
          setError(err.message);
          return;
        }
        syncState("idle");
        setError(err instanceof Error ? err.message : String(err));
        return;
      }

      handleRef.current = handle;
      dispatchMood("listening");
      syncState("listening");
    } finally {
      startingRef.current = false;
    }
  }

  async function stop(): Promise<void> {
    const handle = handleRef.current;
    if (!handle) return;
    handleRef.current = null;

    const samples = handle.stop();

    const MIN_SAMPLES = 6400; // 0.4s at 16kHz
    if (samples.length < MIN_SAMPLES) {
      syncState("idle");
      dispatchMood("idle");
      setError(null);
      return;
    }

    syncState("transcribing");
    dispatchMood("thinking");

    // C1: race transcribe against a 20s timeout
    let text: string;
    try {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Transcription timed out.")), TRANSCRIBE_TIMEOUT_MS)
      );
      text = await Promise.race([getTranscribe(Array.from(samples)), timeoutPromise]);
    } catch (err) {
      // I1: if cancelled while transcribing, discard silently
      if (cancelledRef.current) {
        syncState("idle");
        dispatchMood("idle");
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
      syncState("idle");
      dispatchMood("idle");
      return;
    }

    // I1: discard result if cancelled during transcription
    if (cancelledRef.current) {
      syncState("idle");
      dispatchMood("idle");
      return;
    }

    if (text && text.trim().length > 0) {
      window.dispatchEvent(
        new CustomEvent("loom-utterance", { detail: { text, spoken: true } })
      );
      syncState("idle");
      dispatchMood("idle");
      setError(null);
    } else {
      setError("Didn't catch that.");
      syncState("idle");
      dispatchMood("idle");
    }
  }

  function cancel(): void {
    cancelledRef.current = true;
    const handle = handleRef.current;
    if (handle) {
      handle.cancel();
      handleRef.current = null;
    }
    syncState("idle");
    dispatchMood("idle");
    setError(null);
  }

  return { state, start, stop, cancel, error };
}
