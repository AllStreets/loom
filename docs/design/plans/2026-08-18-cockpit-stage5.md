# Cockpit Stage 5 Implementation Plan (Phase 14) — Deepening

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps.

**Goal:** The cockpit deepens: quotes flow through LOOM's own Rust (third-party proxy dead), briefings and the Watch steer the globe (fly-to), salience LEARNS from the owner's behavior (transparent local weights), and the AGORA dock reports engine health. Plus the carried small debts.

**Architecture:** `quote_fetch` Rust command (reqwest → Yahoo; no CORS in desktop) with quotes.ts routing Tauri-first; `fly_to` verb added to the LOOM-owned adapter (calls AUSPEX's globe.pointOfView directly — adapter is our file, not upstream); learned salience = transparent per-feature weight table updated online from engagement signals, blended into the heuristic score with reasons; AGORA health strip probes web+engine.

**Tech Stack:** existing only.

## Global Constraints
- Design language + SCREENSHOT GATE (`2026-08-18-cockpit-stage3.md`) bind UI tasks. PAINT DISCIPLINE: nothing per-frame above decks.
- Sovereignty: quote symbols only in URLs; learned weights NEVER leave localStorage; no new third-party services (corsproxy becomes browser-DEV-only fallback, desktop never touches it).
- Tauri v2 IPC camelCase; safeInvoke pattern for new commands.
- Gates per task: `npm run check` + build green (+ cargo where Rust); controller verifies.

---

### Task 1: LOOM-owned quote proxy + timeout fallback

**Files:** `src-tauri/src/quotes.rs` (+ tests) — `quote_fetch(symbols: Vec<String>) -> Result<String, LoomError>`: validates each symbol against `^[A-Za-z0-9^.=\-]{1,12}$`, fetches Yahoo chart endpoint per symbol (same URL shape as quotes.ts uses — read it), 10s timeout, returns raw JSON array string (JS keeps its existing normalizer); lib.rs registration. `src/lib/core.ts` `quoteFetch` wrapper. `src/lib/terminal/quotes.ts`: fetch order = Tauri present → `quoteFetch` (Rust); else dev browser → existing Yahoo-direct→corsproxy chain UNCHANGED (comment: dev-only). `AbortSignal.timeout` fallback: tiny helper `timeoutSignal(ms)` in a shared util using AbortController+setTimeout when `AbortSignal.timeout` is undefined; quotes.ts + AgoraDeck probe + watch sensors use it. Tests: Rust symbol validation matrix + request shape; TS routing (Tauri→invoke path, mocked), helper fallback behavior.

- [ ] tests → quotes.rs → routing + helper → green (npm+cargo) → commit `feat(cockpit): quotes through LOOM's own hands — third-party proxy dead in the desktop`.

---

### Task 2: The globe obeys the Watch — fly-to

**Files:** `public/decks/auspex/loom-adapter.js` — new whitelisted verb `fly_to {lat, lng, altitude?}`: calls AUSPEX's globe instance `pointOfView({lat, lng, altitude: altitude||1.6}, 1200)` (READ `public/decks/auspex/js/globe.js` to find the accessible global/getter for the globe object; if none is exported, locate the variable scope and expose minimally INSIDE the adapter via whatever hook exists — document what you found); ack as usual. `src/lib/decks/commands.ts`/GlobeDeck plumbing: `sendDeckCommands` already generic — extend the Cmd type + whitelist. `src/lib/companion/runtime.ts`: briefing handler — when the globe deck is ACTIVE and the top salient item has lat/lng, after assembling the text also emit fly_to to the first located item (deps.sendDeckCommands injected; NO auto deck-switch). `src/components/WatchPanel.tsx`: rows with coords gain a "locate" icon action (crosshair SVG in chrome/icons.tsx style): switches deck to globe (loom-deck event) + queues fly_to (the mount/load-gated queue handles cold switch) + records engagement "act". Tests: adapter verb whitelist (js-level test if the adapter has tests; else document manual verification), briefing fly-to only-when-globe-active + only-with-coords, WatchPanel locate action ordering (deck event BEFORE fly_to), engagement recorded. Screenshot/verification gate: drive it live — globe deck, dispatch a fake loom-salience with Tokyo coords, click locate, VERIFY the globe visibly flew (screenshot before/after or adapter ack + AUSPEX pointOfView state via iframe evaluate) — state exactly what you observed.

- [ ] tests → adapter verb → runtime + panel wiring → live verification → green → commit `feat(cockpit): the globe obeys the watch — fly-to on briefings and locate`.

---

### Task 3: Learned salience — the watch learns its owner

**Files:** `src/lib/watch/learned.ts` (+ tests): transparent per-feature weight table `{category:{[cat]: w}, source:{[src]: w}, token:{[tok]: w}}` (token = title unigrams, lowercase, stopword-filtered, cap 200 tokens by |w|); online update from engagement signals: open +0.05, act +0.10, dismiss -0.08 applied to the event's features (learning rate decay optional — keep simple v1); weights clamped [-0.5, +0.5]; persisted inside `loom.watch.v1` (extend store schema, migration-safe: absent → empty). `score.ts`: new factor `learnedBoost(event, weights)` summing matched weights (category + source + top-3 matched tokens), added to the score, EVERY contribution emitting a reason string like `learned: you often open quake stories (+0.12)` / `learned: you dismiss <source> (-0.08)` — human phrasing per feature kind, only when |contribution| >= 0.02. `runtime.ts`: applies updates when engagement signals are recorded (hook recordEngagement or recompute weights on poll from the signals list — choose the SIMPLER deterministic one: recompute-from-signals on poll = stateless + auditable; document choice). WatchPanel: reasons already render — verify learned reasons appear (no UI change needed beyond that). Tests: weight math (each action type), clamps, token cap, determinism (same signals → same weights), reason emission thresholds, score integration, migration (old store without weights loads clean).

- [ ] tests → learned.ts → score/runtime integration → green → commit `feat(watch): the watch learns its owner — transparent local weights`.

---

### Task 4: AGORA health strip + debts + ship

**Files:** `src/components/decks/AgoraDeck.tsx`: when reachable, a slim top-right strip (design language chips): `WEB ●` (the successful probe) + `ENGINE ●` — engine probe: read AGORA's engine code (`~/Downloads/AGORA/apps/engine/src/`) for an HTTP health endpoint; if only WS exists, probe with a plain `WebSocket("ws://localhost:8080")` open/close (2s timeout, onopen=healthy) — implement what the code supports, document. Re-probe engine on a 60s interval ONLY while agora deck active+reachable (lifecycle like quotes poller). Debts: `Threads`/`Desktop` wrapped in ErrorBoundary zones (Shell); installSeeds re-warns (console.warn) when the failure is NOT ShellUnavailableError. Ship: README stage-5 section (honest), FOLLOWUPS prune + stage-6 backlog (EMBER Forge-in-deck, AGORA command bridge, learned-salience inspection UI, LoRA fine-tune bridge), final whole-branch review (opus), fixes, merge, push.

- [ ] tests → health strip + debts → docs → final review → fixes → merge → push → commit `feat(cockpit): stage 5 ships — deepening`.

## Self-Review Notes
- T2's adapter change is the only deck-bundle edit — LOOM-owned file, upstream untouched.
- T3 recompute-from-signals keeps learning auditable and store-corruption-proof (weights derivable from signals at any time).
- T1 keeps the dev-browser corsproxy path but the desktop product never touches it — the sovereignty claim in README updates accordingly.
