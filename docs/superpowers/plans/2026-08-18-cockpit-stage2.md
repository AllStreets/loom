# Cockpit Stage 2 Implementation Plan (Phase 10) — The Cockpit Watches

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The cockpit starts watching the world FOR the user: a ported salience engine ranks live world events against a personal watchlist, a Watch panel + spoken briefings surface what matters, LOOM gains its own living constellation around the orb, and the deck iframe gets true origin isolation in production.

**Architecture:** Salience engine ported from AgentZeus (`~/Downloads/AgentZeus/src/lib/watch/score.ts` — pure function, 186 lines) and fed by two free live sensors LOOM can reach without keys: AUSPEX's public Supabase stories (anon REST, same instance AgentZeus's LivingGlobeInner already reads: `https://rdsmaktxefqtfxogoauq.supabase.co`) and the USGS earthquake GeoJSON feed. A kernel-side Watch runtime polls, scores, and emits `loom-salience` events; a Watch surface renders the ranked feed with human-readable reasons; the companion gains a `briefing` intent ("brief me") that speaks the top items. The constellation is LOOM-native: SVG ring of LOOM's real workers (builder/companion/rewriter + watch sensors) around the orb with synaptic bezier wires and animated packets driven by existing `loom-fleet-activity` + new `loom-salience` events — visual language ported from `AgentConstellation.tsx` (bezier wires, dash-animated packets), rebuilt lean for LOOM's brand. Origin isolation: a custom Tauri asset protocol serves the AUSPEX bundle on a distinct origin in production; dev stays vite-served (shared origin, documented).

**Tech Stack:** existing LOOM stack; no new JS deps; Tauri v2 custom protocol (Rust).

## Global Constraints

- Brand: navy #060b18, cyan #22d3ee, glass, NO yellow, NO emojis. The orb stays untouched and central.
- Constellation node colors: builder #7dd3fc, companion #22d3ee, rewriter #a78bfa (existing FleetHUD palette); watch sensors #4ade80 family. Reduced-motion: static wires, no packets.
- All new polling: ONE watch runtime interval (default 120s, min 60s), fetch with AbortSignal.timeout, graceful offline (empty results, never throws to UI); no polling when document.hidden (pause/resume like ambientLoop).
- Salience scoring stays a PURE function (no I/O) — port fidelity to the AgentZeus factor model (source trust + category weight + recency decay + intrinsic importance + watchlist match + engagement), every factor emitting a human-readable reason string.
- Watchlist + engagement signals live client-side: watchlist entries in kernel settings (new free-text-list mechanism or a dedicated localStorage store `loom.watch.v1` capped 64KB — implementer picks the simpler, documented); engagement (open/dismiss/act) recorded locally, never transmitted.
- Voice: briefing intent is rule-first ("brief me", "what matters", "what's happening", "morning brief"); the spoken text comes from scored items' titles + reasons — NO model call required for the briefing itself (deterministic assembly); an optional companion-model polish pass ONLY if trivially safe, else skip (YAGNI).
- Tauri v2 IPC camelCase; deck protocol change must keep dev mode working (vite serves /decks/auspex as today).
- Gates per task: `npm run check` + `npm run build` green; cargo green where Rust changes. Controller verifies counts + visuals independently.
- Port sources (read, adapt, do not import cross-repo): `~/Downloads/AgentZeus/src/lib/watch/score.ts`, `~/Downloads/AgentZeus/src/components/AgentConstellation.tsx` (wires/packets pattern only), `~/Downloads/AgentZeus/src/components/LivingGlobeInner.tsx` (AUSPEX REST read pattern).

---

### Task 1: Deck origin isolation (prod) + shared-origin debt closed

**Files:**
- Modify: `src-tauri/src/lib.rs` (register custom protocol), create `src-tauri/src/deckserve.rs` (+ tests where testable): `deck://` (or `auspex.localhost` per Tauri v2 idiom — implementer verifies the v2 API: `tauri::Builder.register_uri_scheme_protocol`) serving files from the bundled resource dir copy of `public/decks/auspex` (add to tauri.conf bundle resources), correct MIME types (html/js/css/svg/png/jpg/json/wasm), path-traversal guard (reject `..`), 404 otherwise.
- Modify: `src/components/decks/GlobeDeck.tsx`: iframe src resolves per environment — dev (`import.meta.env.DEV`) → `/decks/auspex/index.html` (vite, shared origin, documented comment); prod → the custom-protocol URL. postDeckCommand targetOrigin must match the iframe origin per environment (compute once).
- Modify: `public/decks/auspex/loom-adapter.js` ack targetOrigin: `event.origin` already — verify still correct cross-origin.
- Tests: deckserve Rust unit tests (MIME map, traversal guard); GlobeDeck URL/env resolution (mock env), targetOrigin computation.

**Requirements:** In production the deck iframe is cross-origin → its localStorage is ISOLATED from LOOM's (closes reviewer I3 from Stage 1). Sandbox attrs unchanged (`allow-scripts allow-same-origin` — same-origin now refers to the DECK's own origin, still needed for its Supabase fetches/localStorage). Document in the spec-adjacent comment: dev remains shared-origin (acceptable: dev only). AUSPEX's own remote fetches (Supabase, USGS, snapshot refresh) must still work under the custom protocol (CORS: their servers allow any origin via anon REST — verify by reading how AUSPEX fetches; if any fetch is relative-path, it must resolve against the protocol origin — check snapshot.json fetch path and keep the bundled fallback working).

- [ ] Steps: failing tests → deckserve.rs + registration + resources config → GlobeDeck env resolution → green (npm + cargo) → commit `feat(cockpit): deck origin isolation — the world in its own sandbox`.

---

### Task 2: The Watch — salience engine + sensors + runtime

**Files:**
- Create: `src/lib/watch/score.ts` (+ test) — PORT of AgentZeus score.ts adapted to LOOM types; `src/lib/watch/sensors.ts` (+ test) — `fetchAuspexStories(limit=50)` (anon REST: `/rest/v1/stories?select=...&order=published_at.desc&limit=50`, headers apikey+authorization from the PUBLIC anon key constant — read LivingGlobeInner.tsx:27 region for the exact pattern + column names; normalize to WatchEvent) and `fetchQuakes(minMag=4.5)` (USGS all_day GeoJSON); `src/lib/watch/runtime.ts` (+ test) — poll loop (120s, hidden-pause, single interval), dedupe by id, score all against watchlist+engagement, keep top 100, emit `loom-salience` CustomEvent `{items}` on change; `src/lib/watch/store.ts` (+ test) — `loom.watch.v1` localStorage: watchlist entries `{kind: "topic"|"place"|"entity"|"source", value}` CRUD + engagement signals `{eventKey, action: "open"|"dismiss"|"act", ts}` capped (drop oldest past 500), engagement map builder.
- Types: `WatchEvent = {id, title, summary?, url?, source, category, lat?, lng?, publishedAt, magnitude?}`; `ScoredEvent = WatchEvent & {score, reasons: string[]}`.
- Modify: `src/components/Shell.tsx` — start/stop watch runtime with the shell lifecycle.

**Requirements:** score.ts port keeps ALL factor classes with reason strings; unit tests port the factor matrix (source-trust base, category weights, recency decay curve points, watchlist entity/topic/place/source matches, engagement boost/suppression) + determinism. Sensors: honest degradation (network error → [], visible console.warn once per failure streak, not spam); AbortSignal.timeout(10s). Runtime: no overlapping polls; document.hidden pauses; `loom-salience` fires only when the top-10 ordering actually changed (cheap hash compare). NO UI in this task beyond runtime wiring (T3/T4 consume).

- [ ] Steps: failing tests (factor matrix first) → score port → store → sensors → runtime → Shell wiring → green → commit `feat(watch): the cockpit watches — salience engine + live world sensors`.

---

### Task 3: The Constellation + Watch panel

**Files:**
- Create: `src/components/Constellation.tsx` (+ test): SVG layer in the orb band region (behind/around the orb, above deck): nodes on an ellipse around the orb — builder/companion/rewriter (role colors) + one "watch" node per sensor (auspex, quakes; #4ade80 family) — each with label (mono 9px), idle dim glow; synaptic cubic-bezier wires node→orb-center; ACTIVITY: `loom-fleet-activity` lights the matching role node + animates a packet (small circle along the wire via SVG animateMotion or dash-offset — port the pattern from AgentZeus AgentConstellation.tsx, simplified); `loom-salience` pulses the sensor nodes. Reduced-motion: static, no packets. Constellation visible in BOTH decks (over the globe it must stay legible — subtle, low alpha wires 0.15, nodes readable via tiny glass chips).
- Create: `src/components/WatchPanel.tsx` (+ test): a collapsible right-side glass panel (toggle button in top bar, mono "WATCH" + unread-count badge): salience-ranked list — title, source, age, score bar, expandable reasons (the human-readable strings), row actions: open (opens url via Tauri shell open — or copies if unavailable; record engagement "open"), dismiss (records "dismiss", hides), watch+ (adds matched entity/topic to watchlist). Empty state ("the watch is quiet"). Overflow-safe text everywhere (lessons applied).
- Create: `src/organs/seeds/watchlist.ts` seed organ? NO — YAGNI stage 2: watchlist editing lives in the WatchPanel (simple add/remove chips row at top). Settings untouched.
- Modify: `src/components/Shell.tsx` mount Constellation + WatchPanel toggle.

**Requirements:** zero per-frame React state (packets via SVG/CSS animation, activity via refs/attrs like FleetHUD's pattern); listeners cleaned up; panel doesn't cover the chat or dock (right side, max-width 380, below top bar, above plane z? — panel is kernel chrome: z between orb band and dock, pointer-events auto only on the panel). Tests: node set from roles+sensors; activity event lights node (attr assertion); salience event updates panel list; engagement actions write store; dismiss hides; overflow styles present.

- [ ] Steps: failing tests → Constellation → WatchPanel → Shell wiring → green + visual check note → commit `feat(cockpit): the constellation lights — watch panel + living agent ring`.

---

### Task 4: Voice briefing + ship (final review, merge, push)

**Files:**
- Modify: `src/lib/compiler/intent.ts` (+ tests): `briefing` intent, rule-first: "brief me", "what matters", "what's happening", "morning brief", "since I've been gone" (+2 model few-shots).
- Modify: `src/lib/companion/runtime.ts` (+ tests): briefing handler — deterministic assembly from the watch runtime's current top-K (inject via deps: `getSalient(k)` — no model call): "Top of the watch: <title> — <first reason>. <title> — ..."; empty watch → "The watch is quiet. Nothing crosses your thresholds."; pushes to history; spoken per speakReplies (existing path).
- Modify: `src/components/Companion.tsx`: wire deps.getSalient from the watch runtime.
- `README.md`: Stage 2 section (the Watch, constellation, briefings, origin isolation) — honest; `docs/FOLLOWUPS.md`: prune shipped items, add stage-3 (terminal deck, EMBER deck, AGORA deck, globe fly-to on briefing, salience learned model, Watch→globe cross-highlight).
- Final whole-branch review (opus) → merge → push.

**Requirements:** briefing works fleet-offline (no model dependency); regression sweep (all prior phases); brand/no-emoji sweep on new UI.

- [ ] Steps: failing tests → intent + runtime + wiring → docs → final review → merge → push → commit `feat(cockpit): stage 2 ships — the cockpit watches and speaks`.

## Self-Review Notes
- The anon Supabase key is already public by design (shipped in AUSPEX's browser bundle + AgentZeus) — reading it into LOOM's sensor is not a new exposure; keep it a named constant with a comment.
- Watch runtime is kernel-side (organs cannot fetch) — deliberate; a future watch ORGAN would need a gated fetch permission (stage-3 note).
- Constellation packets must not add rAF loops — SVG/CSS animation only (one-shot animations triggered by attribute flips).
- T1's cross-origin change means GlobeDeck's `postMessage` targetOrigin and the adapter's ack origin both flow from ONE computed constant per environment — no scattered origin strings.
