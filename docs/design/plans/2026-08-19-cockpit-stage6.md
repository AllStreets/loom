# Cockpit Stage 6 Implementation Plan (Phase 15) — Command

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps.

**Goal:** The cockpit commands its fleet of apps: LOOM can START and STOP AGORA itself (the "not working" dock becomes a working launcher), the Watch's learned weights become inspectable and erasable, and the noisy edges get cleaned (whisper log spew, cargo warnings).

**Architecture:** `agora_start/stop/status` Rust commands manage a child `npm run dev` in the configured AGORA repo path (fixed argv, no shell; killed on stop and on app exit); the offline card gains START → live "STARTING..." state with bounded auto-probes until the web URL answers, then the iframe mounts. Learned weights get a WatchPanel "LEARNED" section (top ± chips with reasons-grade phrasing + CLEAR LEARNING). Whisper's C-level token spew is silenced via whisper-rs's log hook.

**Tech Stack:** existing only.

## Global Constraints
- Design language + screenshot gate (`2026-08-18-cockpit-stage3.md`) bind UI. Paint discipline holds.
- Process safety: the spawned command is FIXED argv `["npm","run","dev"]` (no shell, no user-supplied args); cwd from setting `deck.agora.path` (default `~/Downloads/AGORA`, `~` expanded Rust-side) validated: must exist, be a directory UNDER the user's home, and contain `package.json` whose parsed `scripts.dev` exists — else typed error, no spawn. ONE child max (second start while running → status reply, no double-spawn). Child killed on `agora_stop`, on LOOM exit (Drop/on_window_event), and its stdout/stderr piped to a capped ring buffer (last 200 lines) readable via `agora_logs` command (settings-gated surface later; v1: card shows last 3 lines while starting).
- Sovereignty: everything localhost; no telemetry.
- Gates: `npm run check` + build + `cargo test` green per task; controller verifies and live-tests the AGORA launch where feasible.

---

### Task 1: AGORA launch control + hygiene

**Files:** `src-tauri/src/agora.rs` (+ tests for the pure parts: path validation incl. home-prefix + package.json script check w/ tempdir, ring buffer): `agora_start() -> Result<(), LoomError>`, `agora_stop()`, `agora_status() -> {running: bool, pid?: u32}`, `agora_logs() -> Vec<String>`; managed child in a `Mutex<Option<Child>>` state (tauri State), spawn with `Stdio::piped()`, reader threads append to the ring buffer; kill_on_drop semantics + Shell exit hook (`on_window_event` CloseRequested or `RunEvent::Exit` — check LOOM's lib.rs builder shape and use what fits). `src/lib/voice/settings.ts`: `deck.agora.path` free-text (validated Rust-side; whitelist key client-side, no client validation beyond non-empty). `src/lib/core.ts` wrappers. `AgoraDeck.tsx`: offline card gains START (data-testid agora-start-btn) → "IGNITING THE EXCHANGE" state showing last log lines (mono, 3 lines, dim) + auto-probe every 2s MAX 45s (bounded; then "still dark" state w/ RETRY/STOP) → reachable → iframe (existing path) + STOP affordance moves to the health strip area (small STOP chip). Tests: card states, bounded probing (fake timers), start/stop invoke wiring, no probe loop leak.
**Hygiene:** silence whisper token spew — whisper-rs log hook (find the API in the vendored whisper-rs version: `install_whisper_log_trampoline`/`set_log_callback`; route to nothing or debug-level tracing) applied at model init in voice.rs; fix cargo warnings (unused `serde::Serialize` in cloud.rs, dead `DEFAULT_VOICE_ID` in voice.rs — remove or use); `cargo test` + build warning-free for loom's own code (report remaining third-party warnings honestly).

- [ ] tests → agora.rs + state + exit hook → settings/core/card wiring → hygiene → green → commit `feat(cockpit): the cockpit commands the exchange — LOOM starts AGORA itself`.

---

### Task 2: Learned-weights inspection + EMBER Forge story

**Files:** `src/components/WatchPanel.tsx` (+ tests): collapsible "LEARNED" section under WATCHLIST: top 5 positive + top 5 negative weights across all feature kinds as chips (`finance +0.18` accent-tinted / `dailymail -0.12` danger-tinted, kind glyph prefix cat/src/word), empty state "nothing learned yet — open, dismiss, and act to teach the watch"; CLEAR LEARNING button (confirm strip) → wipes engagement signals (store fn `clearSignals()` + test) → weights recompute empty next poll. `src/lib/watch/learned.ts`: export `topWeights(weights, k)` helper (+ tests).
**EMBER Forge:** verify what the Forge module DOES inside the deck iframe today (read `public/decks/ember/js/forge.js` boot guards: File System Access API availability in iframe context + deck:// origin) — then make the deck story honest: if FSA is unavailable in the iframe, EMBER's own UI likely shows its unsupported state — confirm and document in LOOM-DECK-README + FOLLOWUPS ("Forge requires the standalone EMBER app; the deck is read/advise mode") OR if it works in dev, state that split. NO new engineering beyond honest docs this stage (LoRA bridge + Forge-through-LOOM deferred to stage 7 backlog).

- [ ] tests → LEARNED section + clear → topWeights → Forge verification + docs → screenshots (LEARNED section populated + empty) → green → commit `feat(watch): the owner can read the watch's mind — learned weights inspectable`.

---

### Task 3: Ship

README stage-6 (AGORA launch control honest: Postgres still yours to run — card says so; learned inspection; log silence), FOLLOWUPS prune + stage-7 backlog (LoRA bridge, Forge-through-LOOM, AGORA db:setup helper command, engine host from setting), final whole-branch review (opus) — special attention: process-spawn security + exit-kill guarantees, then fixes → merge → push.

- [ ] docs → final review → fixes → merge → push → commit `feat(cockpit): stage 6 ships — command`.

## Self-Review Notes
- The spawn surface is the phase's risk: fixed argv + home-prefix path validation + package.json script existence + single-child mutex + exit kill are all mandatory and tested.
- Postgres is deliberately NOT managed (system service, out of scope) — the card copy must say "Postgres must be running (Postgres.app)".
- Whisper hook: if the vendored whisper-rs lacks a log API, fallback = leave spew but note it (do not fork the crate).
