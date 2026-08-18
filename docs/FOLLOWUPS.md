# LOOM — tracked follow-ups

Deferred (non-blocking) findings from the foundation branch reviews. None block merge; address opportunistically or in the relevant later plan.

## From the foundation final review (2026-08-11)
- **ollama.chat() error-body guard** — a non-404 error body (`{"error":"..."}`) parses as JSON with no `message.content`, so the caller gets `Ok("")` instead of an error. Add an `if v.get("error").is_some()` guard before extracting content. (`src-tauri/src/ollama.rs`)
- **fleet.health() `.unwrap()` on a hardcoded role slice** — panics only if the `["builder","companion","rewriter"]` literals ever diverge from the `role_model` match arms. Extract a shared `const ROLES: [&str; 3]` used by `role_model`, `health`, and future iteration. (`src-tauri/src/fleet.rs`)
- **timeline.rollback requires a full 40-char sha** — the UI shows 7-char short shas (`StatusPanel.tsx` `c.sha.slice(0,7)`); a future "rollback this row" button passing the displayed value would fail. Accept short shas (resolve via `revparse_single`) or document the requirement. (`src-tauri/src/timeline.rs`)
- **timeline.log() name shadows a potential future `log` crate** — rename to `commit_log`/`history` if a logging crate is ever added. (`src-tauri/src/timeline.rs`)
- **StatusPanel: independent rendering** — a `timelineInit()` failure currently suppresses the fleet render (shared try block). Render fleet and timeline independently so one failing doesn't hide the other. (`src/components/StatusPanel.tsx`)
- **StatusPanel a11y** — the presence dot has no accessible label; add `aria-label`/`role`. (`src/components/StatusPanel.tsx`)
- **core.ts wrapper tests** — only `fleetStatus`/`fleetChat` are tested; add tests for `timelineInit/Commit/Log/Rollback` (incl. the `limit = 20` default path). (`src/lib/core.test.ts`)
- **Remove `greet` demo command** — harmless leftover scaffold command still registered in `lib.rs`; drop with the next cleanup.
- **Redundant `src-tauri/.gitignore` and stray `.vscode/extensions.json`** — harmless scaffold cruft; remove opportunistically.

## Notes
- The two must-fix items from the final review were resolved on-branch (commit 7e08b24): `fleet_chat` timeout budget bounded (45s, no retry-on-timeout → ~90s worst case only if both primary and fallback hang) and the orphaned light-theme `src/App.css` deleted.

## From the phase 2 (loom-engine) reviews (2026-08-11)
- **sandbox hardening (defense-in-depth)** — base64 the nonce into the harness; validate the verdict shape (stage allowlist, Array.isArray on errors/testResults) in `sandboxRun`'s onMsg. (`src/lib/loom/sandbox.ts`)
- **ollama.chat error-body guard** (carried from phase 1) — an `{"error":...}` body surfaces as a confusing manifest-guard failure in build logs; add `v.get("error")` check. (`src-tauri/src/ollama.rs`)
- **BuildResult.stage** — surface the gate verdict stage in the console's failure panel. (`src/lib/loom/build.ts`, `LoomConsole.tsx`)
- **console dual busy state** — derive UI busy from the pending promise instead of a parallel boolean. (`src/components/LoomConsole.tsx`)
- **organ commit scoping** — `commit_all` stages the whole timeline repo; scope to `organs/<id>/**` if the repo ever gains other writers. (`src-tauri/src/organs.rs`)
- **concurrent selftest reps** — assert `isBusy()` false after settles; verbose reporter for per-rep timings. (`src/lib/loom/build.test.ts`, selftest)
- **scrubFences currently unused** in the build path (kept as documented last-resort guard).
- **TS wrapper coverage** — organGrant/organRead/organDelete + no-opts fleetChat paths untested. (`src/lib/core.test.ts`)

## From the phase 3 (Companion) reviews (2026-08-11)
- **timeline-organ live commit data needs a core API surface** — organs currently have no way to query the git timeline; a `loom.timeline.log()` / `loom.timeline.commit()` surface would unlock a whole category of self-aware organs (changelogs, activity feeds, rollback triggers). Design the permission token and Tauri command before any organ tries to use it.
- **intent classifier embedding upgrade path** — the current heuristic rules cover the common cases well but will degrade as organ vocabulary grows and utterances become more ambiguous. Track an upgrade to an embedding-based classifier (e.g. all-MiniLM or a small fine-tune) that falls back from rules in the same `classifyIntent` seam; the `askModel` injection point already provides the interface. (`src/lib/compiler/intent.ts`)
- **persona tuning at the orb phase** — the Companion's system prompt is fixed; once the orb phase ships, surface a persona-tuning card (tone, verbosity, preferred name) so the presence feels personal rather than generic. Store in `loom.storage` under a reserved `__companion_persona` key.
- **busy-sentinel Symbol hardening** — if the `BUSY` Symbol leaks across module boundaries (dynamic import, HMR reload) the sentinel identity check silently fails and the flight loop can double-fire. Consider exporting a typed `isBusy(state)` predicate instead of a bare Symbol comparison. (`src/lib/loom/build.ts`)
- **flight test-reset hygiene** — `gateRepair`/`flight` do not reset the organ's storage between repair attempts; a test that mutates storage in a failing rep can mask the real failure in the next rep. Add a `loom.storage.clear()` call at the top of each flight attempt. (`src/lib/loom/build.ts`)
- **Companion bubble timestamps** — the chat bubble component renders messages without a time indicator; add a subtle relative timestamp (e.g. "just now", "2 min ago") so multi-turn conversations are easier to orient. (`src/components/CompanionChat.tsx` or equivalent)
- **notes delete same-ms collision** — the notes seed organ uses `Date.now()` as the delete key (`n.t !== item.t`); two notes added within the same millisecond will both be deleted on one click. Use a crypto UUID or an incrementing counter as the item key instead. (`src/organs/seeds/notes.ts`)
- **seeds through the gate in CI** — installSeeds trusts hand-authored files; run them through gate() in a browser-capable test for render/test coverage. (final review M1)
- **notes seed test order-dependence** — test 1 assumes empty mock storage; deterministic today, fragile if reordered. (final review M2)

## From phase 4 (orb) reviews (2026-08-12)
- **orb polish backlog** — GPU particle field around the core; god-rays reserved for speaking; WebGPURenderer path (auto WebGL2 fallback); DOM-probe test prompts (capture rendered innerHTML in the sandbox and feed it to the tests prompt so selectors are grounded in real markup).
- **Shell PanelTag `as object` cast** — replace with a typed discriminated pattern. (`src/components/Shell.tsx`)
- **Orb2D style injection at render** — move `ensurePulseStyle()` into a useEffect. (`src/components/orb/Orb2D.tsx`)
- **moods.firstEventMood call-site comment** — parameter/return asymmetry noted by review. (`src/lib/orb/moods.ts`)
- **2600ms real-timer integration test** — potential slow-CI flake; revisit with better fake-timer strategy. (`src/components/Companion.test.tsx`)

## From phase 4.5 (atelier) reviews (2026-08-12)
- **desktop polish backlog** — window snap/tiling, dock reordering, per-organ icons (model-chosen glyph), kit chart primitive, per-organ theme accents.
- **useOrgans reload()** — fire-and-forget without .catch; add error surface.
- **persistence shape** — spec said {x,y,w,h,min,collapsed}; stored without `min` (collapsed covers it) — spec updated in place.
- **organ-focus flash on wrapper** vs window chrome — cosmetic.

## From phase 5 (voice) reviews (2026-08-12)
- **whisper context caching** — per-call model load ~200-400ms; add a Tauri State cache if PTT latency annoys. (`src-tauri/src/voice.rs`)
- **transcribe fast-path timer non-clearance** — benign leak; clear on resolve. (`src/lib/voice/useVoice.ts`)
- **micTest "ok" sentinel** — document in ORGAN_CONTRACT. Deferred: wake-word (by design), streaming TTS, VAD auto-stop tuning, AudioWorklet upgrade, voice cloning.
- **player onended caf vs currentRafCancel** consistency (prod-benign). (`src/lib/voice/player.ts`)

## From phase 6 (Vitality) reviews (2026-08-13)

- **Full self-modification (the next horizon)** — LOOM editing its own kernel (not just organs) is the flagged next major unlock. Design the kernel-edit permission token, the gate-before-write contract, and the rollback-on-failure sequence before flipping the guardrail. This is deliberate — not a gap.
- **timeline-aware organs** — organs currently have no way to query the git timeline; a `loom.timeline.log()` / `loom.timeline.commit()` Tauri surface would unlock changelogs, activity feeds, and rollback triggers from within organs. Design the permission token first.
- **companion bubble timestamps** — multi-turn conversations lack a relative time indicator ("just now", "2 min ago"). Low effort, improves orientation. (`src/components/Companion.tsx`)
- **notes seed delete collision** — `Date.now()` as delete key; two notes within the same millisecond both deleted. Use a crypto UUID or incrementing counter. (`src/organs/seeds/notes.ts`)
- **intent classifier embedding upgrade** — heuristic rules will degrade as organ vocabulary grows. Track an upgrade to an embedding-based classifier (e.g. all-MiniLM, small fine-tune) falling back from rules in the same `classifyIntent` seam. (`src/lib/compiler/intent.ts`)
- **seeds through the gate in CI** — installSeeds trusts hand-authored files; run them through gate() in a browser-capable test for render/test coverage.
- **persona tuning card** — surface a tone/verbosity/name config in the companion once the orb is established; store in `loom.storage` under `__companion_persona`.

### Resolved in Vitality
- DOM-probe test prompts (T2: renderProbe + DOM-grounded tests-gen now in build flow)
- Three-round repair loop (T2: gateRepair upgraded)
- Kit v2 primitives: hero/spark/keyval/section/dot/toolbar (T4: uikitSrc.ts)
- Threads of light + ambient field + ignition (T3: ambient components)
- First-run greeting (T5: companion greets on first boot, no model call)

---

## Stage-2 backlog (Cockpit Phase 9, post-Stage-1)

Items deferred from the Stage-1 spec non-goals and reviewer notes. Address in the next deck iteration or a dedicated pass.

### Next decks
- **Constellation + salience deck** — port AgentZeus constellation view as a LOOM deck: agents rendered as lights, salience scoring visible, ledger panel. Key source paths: `~/Downloads/AgentZeus/src/components/Constellation.tsx`, `~/Downloads/AgentZeus/src/lib/salience.ts`, `~/Downloads/AgentZeus/src/components/Ledger.tsx`. Adapt to the postMessage deck protocol; salience engine needs a Rust seam for the local embedding model path.
- **Terminal deck** — Bloomberg-style structured data terminal: market feeds, macro data, order-flow panels. Design the feed-source abstraction before wiring; must degrade fully offline.
- **EMBER deck** — offline survival console instrument panel as a deck. Source: `~/Downloads/EMBER`. Bridge via the same postMessage adapter pattern used for AUSPEX; EMBER's Forge self-edit loop should stay isolated from LOOM's builder seam.
- **AGORA deck** — markets intelligence deck: order flow, positioning, macro. Depends on feed sourcing design from the terminal deck pass.

### Stage-1 known limitations to resolve
- **Space-PTT inside iframe** — when the AUSPEX globe deck is active and the user has clicked into Interact mode, the iframe captures keyboard focus and the Space push-to-talk no longer reaches LOOM's window listener. Stage-1 documented limitation. Fix path: synthesize a keydown relay from the adapter (postMessage the key event up to the shell), or add a visible PTT button that works regardless of focus.
- **Deck-aware Threads anchors** — the Threads of Light component currently anchors to static DOM nodes. When a deck is active, the visible chat panel region changes (compact lower-third). Threads should re-anchor to the deck-active layout region rather than the full-height position. (`src/components/ambient/Threads.tsx`)
- ~~**localStorage origin de-share / IndexedDB migration**~~ — resolved in Stage 2: AUSPEX is now served via a custom `auspex.localhost` Tauri protocol in production builds, giving it a distinct origin from the LOOM shell. Key collision risk eliminated.
- **M2-Ascension catch-path experience records** — when a build fails and falls to the local catch path after a cloud attempt, the `brain` field in the experience record should record `"cloud-fallback"` rather than `"local"` so the post-mortem can distinguish an intended local build from a cloud timeout. (`src/lib/loom/build.ts`, `src/lib/loom/experience.ts`)
- **Deck toggle a11y** — the VOID / GLOBE / INTERACT buttons in the top bar have no `aria-label` or `aria-pressed` attributes. Add them for screen-reader correctness. (`src/components/Shell.tsx`)

### Resolved in Stage-1 (Cockpit Phase 9)
- Deck layer + bundled AUSPEX globe (T1)
- Voice command of the world — show/hide globe, category filter, vessels, spin, reset (T2)
- Cloud-override builder — `claude-opus-4-8`, opt-in, local default + fallback (T3)
- AUSPEX first-run tour suppressed via adapter (T1)
- Fleet-offline glass pill when deck active (T1, Shell wrapper)
- AUSPEX logo hidden in deck context to prevent wordmark overlap (T4, loom-adapter.js)

### Resolved in Stage 2 (Cockpit Phase 10)
- Salience engine + sensors (T2: score.ts + sensors.ts + watch runtime)
- Watchlist + engagement store (T2: loom.watch.v1 localStorage)
- Living constellation (T3: Constellation.tsx with bezier wires + activity packets)
- Watch panel + voice briefings (T3/T4: WatchPanel.tsx + briefing intent + runtime handler)
- Deck origin isolation — auspex.localhost custom protocol (T1: deckserve.rs)

### Resolved in Stage 3 (Craft, Phase 11)
- Chrome design language — full token audit, screenshot-gated, no raw hex in shell chrome.
- Error hardening — LOOM-voice failure copy; no raw error strings; error boundaries on watch panel, organ windows, deck layer.
- Terminal deck — live tape / index hero cards / movers / macro strip / finance wire. Lifecycle-driven poller (no background burn). Yahoo `/v8/chart` direct in Tauri; corsproxy.io in browser dev mode only.

### Stage-5 backlog (post-Stage-4b)
- **LOOM-owned quote proxy** — kill the corsproxy.io dependency. Run a tiny Rust/Axum sidecar in the Tauri process that proxies Yahoo `/v8/chart` for the webview (no external relay, no CORS). Blocked on: deciding whether it lives in `src-tauri/src/` or as a named Tauri plugin. (`src-tauri/src/`, `src/lib/terminal/quotes.ts` `quoteUrl()`)
- **Globe fly-to on briefing** — when the cockpit speaks a salience item with lat/lng, auto-fly the globe to that location. Requires a new bridge command `fly_to {lat, lng}` in the deck protocol. (`src/lib/decks/commands.ts`, `public/decks/auspex/js/main.js`)
- **Learned salience model** — replace the hand-tuned factor weights with a small learned model seeded by engagement history. Fits in the `scoreEvent` pure-function seam. (`src/lib/watch/score.ts`)
- **AGORA engine health strip** — when the AGORA deck is live and reachable, show a small status strip (engine ws, Postgres) pulled from AGORA's health endpoint. Design the strip in the AGORA offline card area so it appears on reconnect without layout shift.
- **EMBER Forge-in-deck story** — Forge (File System Access API) is unavailable inside a sandboxed iframe. Design a path: either a Tauri command bridge that proxies file reads/writes for EMBER's Forge loop, or a companion read-file/write-file postMessage protocol scoped to the organs directory.
- **AGORA iframe live-state screenshot unverified** — the offline card acceptance state is tested and screenshot-gated; live iframe state (AGORA running) was not captured during 4b because Postgres/engine were not started. Verify and screenshot in a follow-up session.
- **AbortSignal.timeout wkwebview fallback** — `AbortSignal.timeout()` is used for AGORA reachability probes; wkwebview (Tauri macOS) may not support it on older OS targets. Add a `setTimeout`/`AbortController` polyfill path in the probe if support gaps surface. (`src/components/decks/AgoraDeck.tsx`)
- **Paint discipline audit clean 2026-08-18** — all LOOM-owned painters above deck z2 verified event-driven or void-only: cursor spotlight suppressed when `deck !== "void"`; listening ring rAF runs only while `voice.state === "listening"`; Constellation (z8) uses one-shot SMIL packets on events, no rAF loop; Field canvas (z1) is below decks. No continuous per-frame painters above z2 while a deck is active.
- **Mid-Earth chat overlay polish for narrow heights** — the companion chat panel renders over the deck at a fixed vertical position that compresses it on short viewports. A min-height / scroll-container pass is needed for 768px and below. (`src/components/Companion.tsx`, `src/components/Shell.tsx`)
- **Threads / Desktop error boundaries** — `Threads.tsx` and the organ window host do not yet have React error boundaries. A throw in a thread animation or an organ window crashes more than it should. Add boundaries with LOOM-voice failure copy consistent with the Stage-3 hardening pass. (`src/components/ambient/Threads.tsx`, `src/components/desktop/`)

### Resolved in Stage 4a (Ownership, Phase 12)
- Organ deletion with full residue cleanup (git files, storage keys, registry, dock).
- Seed-deletion tombstones (`loom.organs.deleted`) — deleted seeds stay deleted across reboots.
- Reset to defaults — clears all `loom.*` keys and reloads; tombstones cleared so seed organs return.
- Persistence: WatchPanel open state (`cockpit.watchOpen`), minimized-organ set (`loom.minimized`).
- Constellation defaults off (`cockpit.constellation` default "off"); live toggle via `loom-settings-changed`.
- Interact-by-default (`cockpit.interact` default "on"); LOCK toggle in top bar; persisted.
- Trail hygiene — minimized organs dropped from windowRegistry; restored on un-minimize.
- html background belt — `html { background: var(--bg) }` in tokens.css; overflow reveals navy.
- Orb transparent-mode compositor over active decks.

### Resolved in Stage 4b (More Decks, Phase 13)
- EMBER failsafe deck — bundled static snapshot at `public/decks/ember/`; served via `deck://localhost/ember/`; voice-commanded ("show ember / survival / the failsafe"); offline-capable; advisor degrades gracefully when OLLAMA_ORIGINS not set.
- AGORA exchange dock — localhost-only iframe dock with probed reachability, designed offline card, RETRY on demand, URL configurable in Settings; voice-commanded ("show agora / the exchange / open the floor").
- Deckserve generalized — `src-tauri/src/deckserve.rs` now resolves any `deck://localhost/<deckname>/` path from `public/decks/<deckname>/`; auspex and ember paths both tested.
- Five-deck plumbing — DeckId union, DeckLayer, Shell SegBtns, commands.ts CAT_RE precedence, few-shot examples all updated and regression-tested.
- Settings gains a Decks section — AGORA URL field (localhost/127.0.0.1 only; remote URLs rejected).
