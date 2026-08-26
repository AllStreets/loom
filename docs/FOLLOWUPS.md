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

### Stage-6 backlog (post-Stage-5)

- **EMBER Forge-in-deck** — VERIFIED 2026-08-19: Forge's boot guard (`'showDirectoryPicker' in window`, `public/decks/ember/js/forge.js`) fails inside LOOM's WKWebView (Tauri v2 macOS has no File System Access API), in dev and under the packaged `deck://` origin alike; EMBER renders its own unsupported callout and everything else works. Forge requires the standalone EMBER app in a Chromium browser; the deck is read/advise mode. Path options if Forge-through-LOOM is ever wanted (stage-7 backlog): Tauri command bridge proxying file reads/writes for EMBER's loop, or a companion read-file/write-file postMessage protocol scoped to the organs directory.
- **LoRA fine-tune bridge** — a lightweight path for the owner to fine-tune a local model on engagement history without leaving the cockpit. Depends on the Ollama LoRA import path. (Learned-weights inspection prerequisite resolved in Stage 6.)
- **Salience place-field** — track lat/lng engagement signals and build a geographic affinity map; use it to weight fly-to suggestions and boost geographically relevant Watch items.
- **AbortSignal.timeout wkwebview fallback** — `AbortSignal.timeout()` may not be available on older macOS wkwebview targets. The `timeoutSignal()` helper already polyfills this; monitor for gaps. (`src/lib/util/timeoutSignal.ts`)
- **Mid-Earth chat overlay polish for narrow heights** — companion chat panel compresses on short viewports; needs a min-height / scroll-container pass for 768px and below. (`src/components/Companion.tsx`, `src/components/Shell.tsx`)

### Stage-7 backlog (post-Stage-6)

- **Forge-through-LOOM** — see the verified EMBER item above; if wanted, a Tauri command bridge or scoped read/write postMessage protocol are the options.

### Phase-17 backlog (Depth)

- **Websocket feed upgrade** — the Terminal's floor overlay polls Coinbase REST (2s book / 3s tape). The public websocket feed (`wss://ws-feed.exchange.coinbase.com`) would make the ladder truly live and cut request volume; needs a lifecycle-safe socket seam (reconnect, overlay-close teardown) before adoption.
- **More floor products** — the Terminal's crypto strip (and so the floor overlay) covers BTC/ETH/SOL-USD; widening it is a strip + market-whitelist change once the ladder proves out.
- **Keyed-source opt-ins** — a Settings-gated slot for owner-supplied keys (e.g. Finnhub/Twelve Data free tiers) following the cloud-builder key pattern (write-only, Tauri-side storage), for owners who want deeper equities data than Yahoo's unofficial endpoint.
- **Yahoo fragility** — the chart endpoint is unofficial; the UA fix + query2 retry hold today (live-verified), but if Yahoo hardens further, the engine's typed seam is where a replacement source lands. Monitor.

### Phase-20 backlog (Initiative — deliberate non-goals)

- **Model-phrased rationale** — proposal rationales are rule-generated calm copy quoting real counts; a later pass could let the companion rephrase them in a warmer voice (still no model call for *detection* — only for phrasing an already-earned idea).
- **More archetypes** — v1 ships morning-brief / price-alert / topic-digest (all within the builder's proven power set). Adding archetypes is a rules-engine + threshold addition once more powers/organ patterns prove out.
- **Proposal analytics / learning beyond never-list** — the observer doesn't yet learn from accept/reject rates to tune its own thresholds; a bandit-style confidence loop is possible but needs a sovereignty-safe design (local only).
- **Richer usage observation** — floor-open and terminal-open are wired; deeper signals (dwell time, organ-usage frequency, time-of-day precision) would sharpen archetypes but widen the observation surface — add deliberately, stay local.

### Resolved in Phase 20 (Initiative)

- The observer — passive local usage ledger (`loom.usage.v1`, capped, corruption-tolerant); `foldUsage` pure reducer; `mountObserver` subscribes to existing events (`loom-deck`, `loom-utterance`, watch-open via `cockpit.watchOpen`, new `loom-floor-open`) — no feature-component edits, no polling. (`src/lib/initiative/observe.ts`)
- The rules engine — pure `proposeFromObservation` with three earned archetypes (morning-brief pulse+watch+voice, price-alert pulse+market+notify, topic-digest pulse+watch+notify), hard evidence gates, stable ids, real-count rationales; returns null on empty/below-threshold/rate-limited/disabled/never-listed/already-installed — silence is the common case. (`src/lib/initiative/propose.ts`)
- The proposal surface — calm glass card (z 1600, lower-center, woven glyph), weave-it/not-now/never; weave-it dispatches the same `loom-utterance` seam a typed build uses (`initiative: true` labels the experience only); first-proposal intro; one card at a time via debounced event-driven runtime + single-live guard. (`src/components/chrome/Proposal.tsx`, `src/lib/initiative/runtime.ts`)
- Governance — `cockpit.initiative` setting (default on, Settings toggle), `loom.initiative.v1` store (`markProposed`/`addNever`, written on all three actions), `BuildRecord.proposalSource: "initiative"`. (`src/lib/initiative/store.ts`)

### Phase-19 backlog (Vigor — deliberate non-goals)

- **OS-level notifications opt-in** — `loom.notify` is cockpit-native only; a Settings-gated bridge to macOS notifications (Tauri notification plugin) for owners who want alerts while LOOM is backgrounded.
- **Background pulse while closed** — pulses run only while LOOM is open, by design; a "wake to check" daemon is a sovereignty question (always-on process) to design deliberately, not drift into.
- **Organ-to-organ calls** — powers are organ↔kernel only; an organ bus (with its own permission tokens) would unlock composition but needs a loop-prevention design.
- **Notify → event-source dedupe** — same threat class as any same-realm JS: organs share the webview realm with the shell, so the permission system is honesty-enforcement, not a security sandbox. The real isolation boundary (organ iframes / separate realm) is a larger architectural item.

### Resolved in Phase 19 (Vigor)

- Six organ powers — market/watch/timeline/voice/notify/pulse on `LoomApi` behind the `need()` grant seam; manifest `powers` validated (`POWERS`/`POWER_LABELS`); permission card lists powers in plain language; per-power live revocation UI (bolt toggle → POWERS row) on OrganWindow; token-bucket budgets (market 30/min, voice 1/30s, notify 6/h) with THROTTLED chip; pulse registry (min 30s, max 4/organ) cleared on unmount and delete; Notices glass toast stack. (`src/lib/organs/api.ts`, `src/lib/organs/budgets.ts`, `src/components/chrome/Notices.tsx`)
- Sandbox power mocks — deterministic fixtures matching core.ts shapes; recorded `voice.said` / `notify.sent` / `pulse.registered` hooks for generated tests. (`src/lib/loom/sandbox.ts`)
- Builder power knowledge — conditional `POWERS_CONTRACT` block (recall-biased `requestImpliesPowers` heuristic), BTC-5%-drop few-shot (manifest+code+tests), tests-gen prompt grounded in the mock hooks, ORGAN_CONTRACT documents powers, `build-powered-organ` selftest case + offline gate proof of the fixture. (`src/lib/loom/prompts.ts`)

### Resolved in Phase 18 (Excision)

- AGORA removed entirely (owner verdict 2026-08-22): `agora.rs` + exit-kill hooks + `libc` dep, AgoraDeck, `deck.agora.*` settings (retired via the `RETIRED_KEYS` boot migration, incl. stored `cockpit.deck === "agora"` → void), voice phrases, Settings-organ fields, docs. Grep-gated: only the migration itself may name agora.
- The floor folded into the Terminal — `src/components/terminal/Floor.tsx` (ladder/tape/spot, pure helpers + tests preserved), opened by clicking a CRYPTO-strip symbol; overlay-scoped polls (open → 2s/3s/30s; closed → zero), Esc/click-out/✕ close. "open the floor" / "show the floor" route to the terminal deck.

### Resolved in Phase 17 (Depth)

- Terminal-empty root cause — no User-Agent on the Rust proxy → Yahoo 429 on every desktop quote. Fixed engine-wide (browser UA + query2 retry), proven by an `#[ignore]`d live test. (`src-tauri/src/market.rs`)
- The market engine — `market_chart/crypto/book/trades/fx` typed commands, hardcoded hosts, pre-request validation; `quotes.rs` folded in with `quote_fetch` contract preserved; browser-dev adapters with identical shapes. (`src-tauri/src/market.rs`, `src/lib/market/browser.ts`, `src/lib/core.ts`)
- Terminal depth — `terminal.symbols` editable watchlist (validated, max 24, live re-poll), symbol detail overlay (SVG intraday area chart + OHLC/volume readouts), CRYPTO strip (30s), FX strip (10min, honest "daily" label), EQUITIES·CRYPTO·FX health chips, per-panel loading/stale/error states; `usePoll` lifecycle hook. (`src/components/decks/TerminalDeck.tsx`)
- AGORA floor — order-book ladder (12/side, cumulative depth bars, mid + spread bps, 2s), trades tape (taker-side tinted — Coinbase `side` is maker side, inverted; 3s), product chips (`deck.agora.product`), launch card re-laid as top strip with all states preserved; floor unmounts + all polls stop on reachable transition. (`src/components/decks/AgoraDeck.tsx`, `src/lib/util/usePoll.ts`) *(Phase 18: AGORA removed; the floor lives in the Terminal — `src/components/terminal/Floor.tsx`.)*

### Phase-16 backlog (Identity)

- **Learning verbs for the one grammar** — "clear learning" exists only as a button (CLEAR LEARNING has a confirm strip). Design the confirm-flow-over-utterance pattern, then add it to the catalog so the Shuttle/voice parity stays total. (The exchange verbs left with AGORA in Phase 18.)
- **Deck-usage history for the Tapestry** — the weave's decks-used input is honest but thin (current deck only; no usage store exists). A small ring of `{deck, ts}` records would let the cloth reflect where the owner actually sails.
- **Settings-organ seed upgrades** — seeds install only when missing, so existing installs keep pre-Identity Settings (no ABOUT strip, no TAPESTRY toggle) until reset. Design a seed-version upgrade path that respects owner edits.

### Resolved in Phase 16 (Identity)

- Brand system — woven monogram (`public/brand/loom-glyph.svg`, `favicon.svg`; vite/tauri scaffold SVGs deleted), LoomGlyph chrome component with boot weft-draw, Settings ABOUT strip, `docs/BRAND.md` (palette as law, voice as law). (`src/components/chrome/LoomGlyph.tsx`, `index.html`)
- The Tapestry — Constellation removed (component, setting, mount) with idempotent `migrateSettings()` boot migration; pure `weaveModel` (warp = commits, weft = organs/scars/decks/builds with repair knots, learned tint; deterministic, capped 64); interactive SVG band (hover labels, click → organ/timeline), event-driven refresh, `cockpit.tapestry` default on. (`src/lib/tapestry/weave.ts`, `src/components/Tapestry.tsx`)
- The Shuttle — `catalog.ts` derived from the real command tables (anti-drift test-enforced through the actual classifiers), `fuzzyFilter`, ⌘K glass palette executing through the same `loom-utterance` seam as voice, free-text fallthrough, ⌘K hint chip; "what can you do" spoken from the catalog, zero model calls. (`src/lib/shuttle/catalog.ts`, `src/components/Shuttle.tsx`)

### Resolved in Stage 6 (Command, Phase 15)

- AGORA launch control — `agora_start/stop/status/logs` Tauri commands; fixed-argv spawn (`npm run dev`, no shell), home-prefix + package.json `scripts.dev` validation, single-child mutex, piped stdout/stderr → 200-line ring buffer, kill on stop and on LOOM exit; offline card START → IGNITING (live log lines, bounded 2s×45s probing) → iframe; STOP chip in the health strip. (`src-tauri/src/agora.rs`, `src/components/decks/AgoraDeck.tsx`)
- Learned-weights inspection — WatchPanel LEARNED section (top ±5 chips, kind glyphs, accent/danger tints), CLEAR LEARNING confirm strip → `clearSignals()`; `topWeights(weights, k)` helper. (`src/components/WatchPanel.tsx`, `src/lib/watch/learned.ts`, `src/lib/watch/store.ts`)
- Whisper token spew silenced via whisper-rs log hook at model init; cargo warnings fixed (LOOM's own code builds warning-free). (`src-tauri/src/voice.rs`, `src-tauri/src/cloud.rs`)
- EMBER Forge-in-deck verified honestly (see stage-6 backlog entry above): WKWebView lacks the File System Access API; deck is read/advise mode. Docs updated.

### Resolved in Stage 5 (Deepening, Phase 14)
- LOOM-owned Rust quote proxy — `quote_fetch` Tauri command (reqwest, symbol validation, 10s timeout); desktop never touches corsproxy; browser dev path unchanged. (`src-tauri/src/quotes.rs`, `src/lib/terminal/quotes.ts`, `src/lib/core.ts`)
- Globe fly-to — `fly_to {lat, lng, altitude?}` verb in the LOOM-owned adapter; WatchPanel locate action (deck switch + fly-to + engagement); briefing handler emits fly-to when globe is active and top item has coords. (`public/decks/auspex/loom-adapter.js`, `src/components/WatchPanel.tsx`, `src/lib/companion/runtime.ts`)
- Learned salience — transparent per-feature weight table (category / source / token); online update from engagement signals (recompute-from-signals on poll = stateless + auditable); weights clamped [-0.5, +0.5], persisted in `loom.watch.v1`; reasons emitted with human phrasing. (`src/lib/watch/learned.ts`, `src/lib/watch/score.ts`)
- AGORA engine health strip — WEB and ENGINE glass chips (mono 9px, dot #4ade80 healthy / --danger down); ENGINE probed via HTTP `GET /health` (AGORA engine exposes this at `:8080/health`); re-probed on 60s interval while deck mounted and reachable; interval cleaned on unmount. (`src/components/decks/AgoraDeck.tsx`)
- Threads / Desktop error boundaries — Shell wraps both overlay components in ErrorBoundary zones ("threads", "desktop"); fallbacks render inline (not position:absolute) which is intentional — the fallback card is clickable without needing pointer-events override. (`src/components/Shell.tsx`)
- installSeeds failure logging — non-ShellUnavailableError failures now re-warn via `console.warn`; ShellUnavailableError keeps `console.debug`. (`src/organs/seeds/install.ts`)

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

## From phase 16 (identity) Task 1 (2026-08-20)
- **Tauri app icon raster regeneration from loom-glyph (needs PNG pipeline)** — `src-tauri/icons/*` (`.png`/`.ico`/`.icns`) still carry the scaffold Tauri rasters; regenerate them from `public/brand/loom-glyph.svg` (favicon variant art) once a raster pipeline exists (e.g. rendered PNG → `tauri icon`). (`src-tauri/icons/`, `public/brand/loom-glyph.svg`)

## Stage-5 final-review notes (2026-08-18)
- Engagement double-influence: score factor 5 (applyEngagement) and factor 6 (learnedBoost) both derive from the same signals on source/category — bounded (0.15 cap + clamps + final [0,1]) and acceptable; unify when the learned model matures.
