# LOOM Voice (Phase 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give LOOM ears and a voice — fully offline (whisper STT + piper-class TTS in the Rust core), **push-to-talk that never half-works** (hold the orb = primary; hold Space = shortcut), three auditionable voices, replies spoken aloud, and a **Settings organ** (Loom-editable like everything else) that owns voice choice and all user preferences via a new `settings` permission.

**Architecture:** The Rust core gains `voice.rs`: a voice-model manager (registry of 1 whisper model + 3 TTS voices with exact HF URLs; `voice_status` / `voice_setup` one-time downloads into the app-data dir — the same networked-setup precedent as `ollama pull`), `stt_transcribe(samples: Vec<f32>) -> String`, and `tts_speak(text, voice_id) -> Vec<u8>` (16-bit WAV). STT/TTS engine crates: prefer `whisper-rs` (whisper.cpp bindings, Metal) + `piper-rs`; if either fails to build cleanly, fall back to `sherpa-rs` (sherpa-onnx; supports both whisper ASR and piper/vits TTS) — the implementer verifies with real `cargo build` and documents the choice. The frontend gains `src/lib/voice/`: a **recorder** (getUserMedia, 16kHz mono Float32, feeding the existing `audioLevel` envelope so the orb visibly hears you) and a **player** (WAV → AudioContext, driving `audioLevel` + the `speaking` mood). PTT: pointer-hold on the orb or held Space (never while typing) → `listening` mood + record → release → transcribe → submit through the Companion; replies are spoken per the `voice.speakReplies` setting. A kernel **settings store** (whitelisted localStorage keys) is exposed to organs via a new `settings` permission (`loom.settings.get/set/voices/audition/micTest`), and the **Settings seed organ** (permissions `["settings"]`) provides: voice picker with per-voice Audition buttons, speak-replies mode, orb renderer tier, review-before-save default, and voice-model status + Download setup — all editable by the Loom because it's just an organ.

**Tech Stack:** Rust: `whisper-rs` + `piper-rs` (or `sherpa-rs` fallback), `reqwest` (downloads), existing `serde`; frontend: WebAudio (no new npm deps).

## Global Constraints

- Runtime is fully offline. The ONE networked step is `voice_setup` (first-time model downloads, exact pinned URLs below), identical in spirit to pulling the Ollama fleet. Everything else must work with networking gone (absent models → clear "voice not set up" state, never a hang or crash).
- **Never half-works:** every voice state is explicit and visible — `idle / listening (recording) / transcribing / speaking / unavailable(reason)`. Errors surface as text near the orb/settings, never silent. Mic permission denial → a clear message with the fix. PTT release always ends recording (pointercancel/blur included).
- PTT: primary = press-and-hold the orb (pointerdown→up/cancel); shortcut = hold Space when not typing (existing Enter behavior in inputs unchanged). Space PTT must not scroll the page (preventDefault) and must not fire when any input/textarea/contenteditable has focus.
- Voices (exact ids + files): `en_US-lessac-medium` (default), `en_GB-alba-medium`, `en_US-libritts-high`. Whisper model: `ggml-base.en.bin`. URLs (pin exactly):
  - `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin`
  - `https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx` (+ same path `.onnx.json`)
  - `https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alba/medium/en_GB-alba-medium.onnx` (+ `.onnx.json`)
  - `https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/libritts/high/en_US-libritts-high.onnx` (+ `.onnx.json`)
- Settings store keys (whitelist — organs can touch ONLY these via loom.settings): `voice.default`, `voice.speakReplies` ("always" | "whenSpoken" | "never"; default "whenSpoken"), `orb.tier` ("auto" | "flat"), `loom.reviewBeforeSave` ("0"|"1"). The kernel reads the same keys (single source of truth = localStorage).
- The `settings` permission joins the catalog (`storage`, `model`, `notify`, `settings`); the sandbox mock provides an inert `loom.settings` (get/set on a Map, `voices()` returns the 3 ids, `audition/micTest` no-op resolve) so settings-organs validate in the gate.
- macOS mic permission: add `NSMicrophoneUsageDescription` via tauri.conf Info.plist config.
- Audio buffers cross IPC as arrays — cap recordings at 30s (16000*30 samples) with a visible cap notice.
- DRY, YAGNI, TDD, frequent commits. No emojis. Navy/cyan brand.

---

## File Structure

```
src-tauri/src/voice.rs        # CREATE: registry, paths, voice_status/voice_setup/stt_transcribe/tts_speak
src-tauri/src/lib.rs          # MODIFY: mod voice + commands
src-tauri/tauri.conf.json     # MODIFY: NSMicrophoneUsageDescription (Info.plist)
src-tauri/Cargo.toml          # MODIFY: whisper-rs + piper-rs (or sherpa-rs) + futures-util (download stream)
src/lib/voice/recorder.ts     # CREATE: getUserMedia 16k mono capture → Float32Array + audioLevel drive
src/lib/voice/player.ts       # CREATE: wav bytes → AudioContext playback + audioLevel + completion promise
src/lib/voice/settings.ts     # CREATE: typed kernel settings store (whitelisted keys, defaults)
src/lib/voice/*.test.ts
src/lib/core.ts               # MODIFY: voiceStatus/voiceSetup/sttTranscribe/ttsSpeak wrappers
src/lib/organs/api.ts         # MODIFY: loom.settings (gated by "settings" permission)
src/lib/loom/prompts.ts       # MODIFY: catalog + contract gains "settings" + loom.settings docs
src/lib/loom/sandbox.ts       # MODIFY: mock loom.settings in freshLoom
src/components/orb/Orb*.tsx   # MODIFY: press-and-hold handlers (delegated via props from Shell)
src/components/Shell.tsx      # MODIFY: PTT orchestration (orb hold + Space), voice state line under orb
src/components/Companion.tsx  # MODIFY: acceptExternal utterance submit; speak replies per setting
src/organs/seeds/settings.ts  # CREATE: the Settings organ (voice picker/audition/speakReplies/orb tier/review/status+setup)
src/organs/seeds/install.ts   # MODIFY: register the settings seed
```

---

### Task 1: Rust voice core

**Contract:**
- Cargo deps: `whisper-rs` (with metal feature if available) + `piper-rs`; BUILD-VERIFY IMMEDIATELY (`cargo build`) before writing logic — if either fails on macOS, substitute `sherpa-rs = { features = ["tts", ...] }` for the failing side (sherpa supports whisper ASR + vits/piper TTS with the same .onnx voices) and document the substitution in the report. `futures-util` for streamed downloads.
- `voice.rs`:
  - `pub struct VoiceDef { pub id: &'static str, pub label: &'static str, pub files: &'static [(&'static str, &'static str)] }` — registry `VOICES: [VoiceDef; 3]` (exact URLs above; files = (filename, url)) + `WHISPER: (&str, &str)`.
  - `pub fn voice_dir(app) -> PathBuf` (`loom_dir/voice/`, created).
  - `pub fn missing_files(dir: &Path) -> Vec<(String, String)>` (pure: which registry files absent).
  - Commands: `voice_status(app) -> VoiceStatus { ready: bool, whisper: bool, voices: Vec<{id,label,present}> , missing_bytes_hint: Option<String> }`; `voice_setup(app, window) -> Result<(), LoomError>` — downloads each missing file (reqwest stream → temp file → rename), emitting Tauri events `voice-setup-progress { file, pct }`; idempotent; network errors → clear LoomError.
  - `stt_transcribe(app, samples: Vec<f32>) -> Result<String, LoomError>` — 16kHz mono f32 → whisper (greedy, en) → trimmed text; absent model → `NotFound("voice not set up")`; cap input at 480_000 samples.
  - `tts_speak(app, text: String, voice_id: String) -> Result<Vec<u8>, LoomError>` — synthesize via piper/sherpa with the voice's onnx+json → mono 16-bit PCM WAV bytes (implement `pub fn wav_from_pcm16(rate: u32, samples: &[i16]) -> Vec<u8>` pure + unit-tested: RIFF header fields correct for len/rate); unknown voice id or absent files → NotFound.
  - Unit tests (no network/models): registry integrity (3 voices, urls https + hf hosts, default id present), `missing_files` against a tempdir (empty → all missing; touch files → empty), `wav_from_pcm16` header bytes (RIFF/WAVE/fmt/data, sizes, rate), sample-cap logic (pure helper `clamp_samples`).
- `tauri.conf.json`: Info.plist `NSMicrophoneUsageDescription` = "LOOM listens only while you hold the orb or Space."
- lib.rs registers the 4 commands.

Gate: `cargo build` clean + `cargo test` green (new tests included) + `npm run check` still green. Commit: `feat(voice): offline STT/TTS core — registry, setup downloads, whisper in, wav out`.

---

### Task 2: Frontend voice lib + wrappers + settings store

**Contract:**
- `recorder.ts`: `startRecording(): Promise<RecHandle>` — `getUserMedia({audio: {channelCount:1, echoCancellation:true, noiseSuppression:true}})`, AudioContext({sampleRate:16000}) + ScriptProcessor/AudioWorklet fallback (use ScriptProcessorNode for webview simplicity; document), accumulates Float32 chunks (cap 30s → auto-stop flag), per-chunk drives `audioLevel.current = envelope(audioLevel.current, rms(chunk))`; `RecHandle = { stop(): Float32Array; cancel(): void; onAutoStop?: () => void }`; mic denial → throws `MicDenied` error with `.reason`. All DOM/audio guarded for jsdom (factory injectable for tests: `startRecording(deps?)` with `getMedia`, `ctx` factories).
- `player.ts`: `playWav(bytes: Uint8Array): Promise<void>` — decodeAudioData → source → analyser (drive audioLevel each rAF while playing) → resolves on ended; `stopPlayback()` cancels current. Injectable ctx for tests.
- `settings.ts`: `SETTINGS_KEYS` whitelist + defaults (per Global Constraints), `getSetting(key)`, `setSetting(key, value)` (validates key + value against allowed values; localStorage), `VOICE_IDS = ["en_US-lessac-medium","en_GB-alba-medium","en_US-libritts-high"]` with labels. Pure/tested.
- `core.ts`: `voiceStatus()`, `voiceSetup()`, `sttTranscribe(samples: number[])`, `ttsSpeak(text, voiceId) -> number[]` wrappers (+ test of invoke shapes; samples passed as plain arrays).
- Tests: settings whitelist/validation/defaults; recorder with injected fakes (accumulates chunks, stop returns concatenated Float32Array, cap triggers auto-stop, denial throws MicDenied); player with injected fake ctx (resolves on ended, drives audioLevel); core wrapper shapes.

Gate: `npx vitest run src/lib/voice` + `npm run check` green. Commit: `feat(voice): recorder, player, kernel settings store, IPC wrappers`.

---

### Task 3: PTT + spoken replies — the loop that never half-works

**Contract:**
- Shell owns a `useVoice()` orchestration (local hook in Shell.tsx or `src/lib/voice/useVoice.ts`): states `idle | listening | transcribing | speaking | unavailable`; exposes `{ state, start(), stop(), error }`.
  - `start()`: if voice models not ready (voiceStatus cached 60s) → set error "Voice isn't set up — open Settings" (dispatch a notify + focus settings dock tile) and DO NOT enter listening; else startRecording + dispatch `loom-mood listening`.
  - `stop()`: recorder.stop() → if < 0.4s of audio → discard quietly (idle); else `transcribing` (orb thinking mood) → `sttTranscribe` → non-empty text → hand to Companion via a `loom-utterance` CustomEvent (detail {text, spoken: true}); empty → status text "Didn't catch that." → idle.
  - Errors at ANY step → `error` set + surfaced in the voice status line + `idle` (never stuck).
- Orb hold: Shell wraps the orb in a press target (`onPointerDown → start()`, `onPointerUp/Leave/Cancel → stop()`, also `window blur` → stop-cancel). Visual: while listening, a thin accent ring scales with `audioLevel` around the orb (2D CSS ring, both tiers).
- Space PTT: keydown (code Space, `!e.repeat`, target not input/textarea/contenteditable) → preventDefault + start(); keyup Space → stop(). Guard: if keyup missed (blur), the blur handler stops.
- A one-line **voice status line** under the orb (mono 11px t3): idle → "hold the orb or Space to talk" (only when voice ready); listening → "listening…"; transcribing → "transcribing…"; unavailable → the error text with "open Settings".
- Companion: listens for `loom-utterance` → sets input value + submits (reusing runTurn) marking the turn `spoken`; after a turn's reply text is ready, speak it if (`voice.speakReplies` === "always") or ("whenSpoken" && turn was spoken): `ttsSpeak(reply, getSetting("voice.default"))` → `playWav` (orb `speaking` mood while playing — dispatch mood around the playback promise; the existing 2.5s speaking timer must not fight it: skip the timer when actually speaking aloud and dispatch idle after playback).
- Tests (mocks): useVoice state machine transitions incl. not-ready path, short-audio discard, error surfacing (injected failing transcribe), never-stuck (every path ends idle/unavailable); Space PTT guards (typing target ignored, repeat ignored, preventDefault called); loom-utterance submits through Companion (spy on handle) and speaks reply when setting says so (mock ttsSpeak/playWav; assert speaking mood dispatched around playback).

Gate: `npx vitest run src` green (all suites), `npm run check`, `npm run build` green. Commit: `feat(voice): hold-the-orb + Space push-to-talk, spoken replies, states that never lie`.

---

### Task 4: The settings permission + loom.settings + the Settings organ

**Contract:**
- `prompts.ts`: PERMISSIONS gains `"settings"`; ORGAN_CONTRACT documents: `loom.settings.get(key)/set(key, value)` (whitelisted keys listed with allowed values), `loom.settings.voices() -> [{id,label,present}]`, `await loom.settings.audition(voiceId)` (speaks a sample aloud), `await loom.settings.micTest() -> "ok"|error string` (2s record + transcribe round-trip), `loom.settings.voiceStatus() -> {ready, ...}`, `await loom.settings.setup(onPct?)` (download models). Marked: "request only for settings-type organs".
- `api.ts`: `makeLoomApi` gains `settings` (gated by the `settings` permission): implemented over `settings.ts` store + core wrappers; `audition(voiceId)` → `ttsSpeak("Hello — I am LOOM. This is my voice.", voiceId)` → `playWav`; `micTest()` → 2s record → transcribe → return text or error string; `setup()` → `voiceSetup()` (progress via Tauri event listen → callback).
- `sandbox.ts` mock: inert `settings` (Map get/set; `voices()` → the 3 ids present:false; audition/micTest/setup resolve; voiceStatus → {ready:false}).
- `src/organs/seeds/settings.ts` — the Settings organ (kit-composed, THE exemplar of a settings organ; manifest permissions `["settings"]`, id `settings`, name "Settings"):
  - Card "Voice": status line (ready / "models not downloaded" + Download button with progress %); voice list — one row per voice: label + `Audition` ghost button (data-action `audition-<id>`) + `Use` primary/badge showing the current default (data-action `choose-<id>`); speak-replies segmented choice (three ghost buttons, active = accent; data-actions); mic test button + result line.
  - Card "Appearance": orb renderer toggle (Auto/Flat, data-actions) — writes `orb.tier` (kernel: Orb reads `loom.orb`="flat" — settings.ts maps `orb.tier` set to also write the legacy `loom.orb` key so the existing detectTier keeps working).
  - Card "Building": review-before-save toggle (writes `loom.reviewBeforeSave` — the Companion toggle reads the same key; add a storage event listener in Companion so the checkbox live-syncs, or accept next-render sync — implementer's choice, note it).
  - test.js: 3 tests via data-actions + mock settings (choose sets voice.default; speak-replies choice persists; renders voice rows).
- `install.ts`: register the settings seed (installed like the others, approval card shows the `settings` permission).
- Selftest: no new model tasks (settings is seed-authored); but add the `settings` permission to the manifest-guard selftest expectations if any assert the catalog (check).

Gate: `npm run check` + `npm run build` green; seeds tests green. Commit: `feat(settings): the settings permission + loom.settings + a Settings organ editable like everything else`.

---

### Task 5: Docs + final review + ship + real-device check

- README: phase 5 row → shipped; fleet section gains a "Voice" table (3 voices + whisper, `voice_setup` note); anatomy SVG: "Offline voice" dot cyan → green. FOLLOWUPS: wake-word (deferred by design), streaming TTS, voice cloning, VAD auto-stop tuning, AudioWorklet upgrade.
- `npm run check` + `npm run build`; final whole-branch review (most capable model) → fix wave → merge to main → push.
- **Real-device check (the human's part — write it into the checkpoint):** run `voice_setup` from Settings, audition all three voices, hold the orb and speak, confirm reply is spoken; verify mic-permission prompt appears with the LOOM description.

---

## Self-Review

**Spec coverage:** offline STT/TTS in Rust (T1); recorder/player/settings store (T2); hold-the-orb + Space PTT with explicit never-stuck states + spoken replies (T3 — user decisions honored); three auditionable voices + Settings organ via the `settings` permission, Loom-editable (T4 — user decisions honored); ship + human audio check (T5).

**Placeholder scan:** exact URLs, voice ids, settings keys/values, state machines, and test lists specified; the one genuinely uncertain area (Rust crate choice) has an explicit build-verify-first decision rule instead of a placeholder.

**Type consistency:** `VoiceStatus`/wrapper shapes defined in T1/T2 and consumed in T3/T4; settings keys single-sourced in `settings.ts` and documented identically in the contract; `loom-utterance`/`loom-mood` event shapes consistent with existing Shell/Companion contracts.
