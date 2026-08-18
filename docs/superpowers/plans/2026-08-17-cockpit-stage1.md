# Cockpit Stage 1 Implementation Plan (Phase 9)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LOOM becomes the Sovereign Cockpit stage 1: a deck layer with the living AUSPEX globe behind the orb, voice command of the world, and a Claude cloud-override for the builder.

**Architecture:** See spec `docs/superpowers/specs/2026-08-17-cockpit-design.md` (authoritative for all decisions). Deck layer renders between ambient Field and orb band; AUSPEX embeds as a bundled-static iframe driven by postMessage → its existing bridge-command executor; cloud builder is a Rust `cloud_chat` command (key in Tauri-side store, never webview-readable) with local fallback.

**Tech Stack:** existing LOOM stack + Anthropic Messages API (Rust reqwest, already a dependency for voice downloads).

## Global Constraints

- Brand: navy #060b18, cyan #22d3ee, glass; NO yellow; NO emojis. The orb never moves or shrinks.
- Deck z-order: Field(1) < deck(2) < orb band(10) < plane(100) < dock(1000). Orb band keeps mixBlendMode screen (composites orb light over the deck — do not disturb).
- Iframe pointerEvents: none by default; auto ONLY in explicit "interact" mode (top-bar toggle). PTT hold-orb must keep working with deck active.
- Anthropic: model string exactly `claude-opus-4-8`; headers `x-api-key`, `anthropic-version: 2023-06-01`; endpoint `https://api.anthropic.com/v1/messages`; max_tokens 8192; 120s timeout, one retry, then LOCAL FALLBACK (never a hard failure the local fleet could have absorbed). API key NEVER stored in localStorage/organ-readable storage; NEVER returned by any command after save (write-only + `cloud_key_present() -> bool`).
- Tauri v2 IPC: JS camelCase args.
- AUSPEX bundle: snapshot copy under `public/decks/auspex/` (vite serves public/ verbatim); EXCLUDE node_modules, api/, worker/, tests/, sql/, docs/, keys.local.js (bundle keys.local.empty.js AS keys.local.js so the app boots keyless); add `LOOM-DECK-README.md` provenance note + `scripts/refresh-auspex-deck.sh`. Upstream AUSPEX repo untouched.
- Gates per task: `npm run check` + `npm run build` green; cargo tests green where Rust changes.
- All quality bars from prior phases hold (tests assert real behavior; no vacuous guards; controller verifies counts independently).

---

### Task 1: Deck layer + bundled AUSPEX globe deck

**Files:**
- Create: `src/components/decks/DeckLayer.tsx`, `src/components/decks/GlobeDeck.tsx`, tests; `scripts/refresh-auspex-deck.sh`; `public/decks/auspex/**` (bundle) + `public/decks/auspex/loom-adapter.js` + `LOOM-DECK-README.md`
- Modify: `src/components/Shell.tsx` (deck layer mount + top-bar deck toggle + interact toggle), `src/lib/voice/settings.ts` (add `cockpit.deck` key: "void"|"globe", default "void"), `src/components/ambient/Field.tsx` (accept dim prop or CSS var when deck active)

**Requirements:**
1. DeckLayer: absolute inset-0, zIndex 2, renders active deck per `cockpit.deck` setting; "void" renders nothing (current look unchanged — regression tests must hold). Setting change via a `loom-deck` CustomEvent + kernel store write; top-bar control (icon buttons VOID | GLOBE) + Interact toggle (visible only when globe active).
2. Bundle: run the refresh script once to create the snapshot (verify index.html loads standalone via vite dev); keys.local.empty.js copied as keys.local.js; bridge poller stays off (assert localStorage flag not set by adapter).
3. `loom-adapter.js` (added via a `<script>` tag appended to the BUNDLED index.html only — mark the edit with `<!-- LOOM adapter -->`): listens for `message` events `{loomDeck: true, cmd: {...}}`, whitelist-validates cmd.type against the bridge vocabulary found in `~/Downloads/AUSPEX/js/main.js`'s bridge executor (read it; reuse its exact execution path — if the executor is a named function, call it; if inline, extract minimal dispatch), replies `{loomDeckAck: true, type}`. No origin wildcard sends: adapter posts acks to `event.origin`; GlobeDeck posts with the iframe's own origin.
4. GlobeDeck: iframe `src="/decks/auspex/index.html"` sandbox="allow-scripts allow-same-origin" (comment WHY), pointerEvents per interact mode, fade-in/out 400ms on deck switch (reduced-motion instant), exposes `postDeckCommand(cmd)` via ref/module fn for T2. Field dims to 0.35 opacity while globe active (CSS transition).
5. PTT/orb regression tests: with globe deck active + interact OFF, orb band clicks/hold still work (pointer-events assertions); three-zone layout untouched; chat Zone C gains `data-deck-active` compact styling hook (max-height lower-third + translucent bg) — keep simple, test the style flip.

- [ ] Steps: failing tests → DeckLayer/GlobeDeck + Shell wiring → bundle script + snapshot + adapter → green + build → commit `feat(cockpit): deck layer — the living world behind the orb`.

---

### Task 2: Voice/companion command of the globe

**Files:**
- Create: `src/lib/decks/commands.ts` (+ test) — phrase→bridge-command map
- Modify: `src/lib/compiler/intent.ts` (+ `deck_command` intent, rule-first + model few-shot), `src/lib/companion/runtime.ts` (route deck_command → dispatcher, spoken confirmation), `src/components/Companion.tsx` (dispatch to GlobeDeck via `loom-deck-command` CustomEvent GlobeDeck listens for), intent/runtime/Companion tests

**Requirements:**
1. Rules (case-insensitive): "show/open the globe|world|map" → {deck:"globe"}; "hide the globe|world / back to the void" → {deck:"void"}; "show (military|geopolitical|finance|climate|tech) (news)?" → set_cat mapping (read AUSPEX's category ids from its config.js — use ITS ids verbatim); "show (vessels|ships)" → the vessels overlay toggle verb; "(stop|start) (spinning|rotation)" → set_spin; "reset the view" → reset_view. Deck-switch commands also write `cockpit.deck` so state persists.
2. deck_command added to the model-fallback few-shots (2 examples) WITHOUT disturbing T2-Ascension's few-shot structure; anaphora/edit/build precedence unchanged (regression tests).
3. Runtime: deck_command executes WITHOUT any model call when rules matched (fast path like act); companion pushes a short assistant confirmation ("Globe up." / "Filtering: military.") to history + speaks it per speakReplies; orb pulses building→idle via existing mood events.
4. If deck is "void" and a globe-only command arrives (e.g. "show vessels"), auto-switch deck to globe first, then apply the command (both dispatched, in order).

- [ ] Steps: failing tests → commands map → intent + runtime + UI dispatch → green → commit `feat(cockpit): the world obeys — voice command of the globe`.

---

### Task 3: Builder cloud override (Claude opt-in, local fallback)

**Files:**
- Create: `src-tauri/src/cloud.rs` (+ tests) — `cloud_chat`, `cloud_key_set`, `cloud_key_present`, `cloud_key_clear`; key persisted in a Tauri app-data file (0600 perms) NOT the webview store
- Modify: `src-tauri/src/lib.rs` (mods + handlers), `src/lib/core.ts` (typed wrappers; builder-role chat routing), `src/lib/voice/settings.ts` (`model.cloudBuilder`: "off"|"anthropic", default "off"), `src/organs/seeds/settings.ts` (Models page: Cloud builder section — enable toggle, key input (password type, write-only, shows "key saved" state via cloud_key_present), status line), `src/lib/organs/api.ts` + `src/lib/loom/sandbox.ts` (settings mock additions), `src/lib/loom/experience.ts` (BuildRecord.brain), `src/lib/loom/build.ts` (brain tag in records + build log line "built by claude-opus-4-8" / "built by <local tag>"), Companion success card shows the brain
- Tests: Rust (request shape incl. exact model string + headers via a mockable HTTP layer or request-builder unit tests; key file round-trip + never-returned; fallback on error), TS (routing: cloudBuilder on → builder chats invoke cloud_chat; off → fleet_chat; cloud error → local fallback records brain:"local"; settings UI mock paths)

**Requirements:**
1. `cloud_chat(system: String, messages: Vec<Msg>, maxTokens): Result<String>` — builds the Anthropic request per Global Constraints; extracts text content blocks; maps HTTP/auth errors to typed LoomError. NO thinking param. One retry on transient, then Err (JS layer falls back local + emits a build log line "cloud unavailable — built locally").
2. core.ts: `builderChat(messages, opts)` used by build/editOrgan/gateRepair paths (single seam — verify all builder-role call sites route through it; companion/rewriter roles NEVER cloud).
3. Settings UI: key input never echoes a saved key; Clear button; section explains default-local posture in one line. Seed stays srcdoc-safe/ASCII/data-actions; gate passes.
4. Honest end-to-end: with a real key (if `ANTHROPIC_API_KEY` env present at selftest time, an env-gated selftest task builds one organ via cloud and asserts gate pass + brain:"cloud" recorded; skipped cleanly when absent — skip must print a visible notice, not silently pass).

- [ ] Steps: failing tests → Rust cloud.rs → core routing → settings UI + mocks → experience/brain threading → green + build + cargo → commit `feat(cockpit): cloud-override builder — Claude on tap, sovereign by default`.

---

### Task 4: Ship polish — README + first-run + regression sweep

**Files:**
- Modify: `README.md` (Cockpit framing: hero section update, deck screenshot placeholder, stage-1 capabilities, roadmap: constellation/salience/terminal/EMBER decks next), `src/components/Companion.tsx` (first-run greeting mentions the globe: one added suggestion line), `docs/FOLLOWUPS.md` (stage-2 backlog: constellation port, salience, terminal deck, EMBER deck, AGORA deck, iframe-Space-PTT limitation, deck-aware Threads anchors)
- Whole-branch final review + merge + push per SDD.

**Requirements:** all prior-phase deliverables regression-green (ignition, ambient, builder pipeline, windows, Settings, FleetHUD); README honest (no unbuilt claims); FOLLOWUPS carries every deferred item from the spec's non-goals.

- [ ] Steps: sweep → docs → final review → merge → push → commit `feat(cockpit): stage 1 ships — the cockpit breathes`.

## Self-Review Notes
- T1 bundles a ~static snapshot; the refresh script keeps upstream AUSPEX authoritative — no fork drift risk beyond the adapter file.
- T2 reads AUSPEX's real category ids/verbs from its source rather than inventing a schema (kills the dual-parser drift the old Meridian bridge had).
- T3's single `builderChat` seam is the entire cloud surface — no per-callsite branching; rewriter/companion stay local always (cost + sovereignty).
- Space-PTT-inside-iframe is a documented stage-1 limitation (FOLLOWUPS), not silently broken.
