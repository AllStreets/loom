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

## Phase-23a — Rebirth (the second excision, 2026-09-02)

### Resolved in Phase 23a (Rebirth)

- The Cockpit is gone by owner verdict: four decks (globe · terminal · EMBER · the deck layer and `deck://` protocol), the salience watch (engine, sensors, panel, learned weights, store), the market engine (`market.rs`, browser adapters, Terminal, floor), the cloud-override builder (`cloud.rs`, key storage, the `Brain` concept), the bundled AUSPEX / EMBER snapshots and their refresh scripts. Never reintroduce them.
- Powers are now `timeline · voice · notify · pulse`; the few-shot the builder studies is a stand-up reminder (pulse + notify + voice), proven offline by the gate test.
- Intents are `self_edit · build_organ · edit_organ · act_on_organ · converse · help`; the compiler carries no deck state; the shuttle catalog derives `build · organs · system`.
- Initiative keeps its observer, engine, governance and card with ONE archetype (morning-brief, rooted in `morningActivity` + an installed organ, powers `pulse · timeline · voice`); the ledger is `commands + morningActivity` and loads legacy ledgers cleanly.
- Settings: `cockpit.deck`, `cockpit.interact`, `cockpit.watchOpen`, `terminal.symbols`, `model.cloudBuilder`, `loom.watch.v1`, `auspex.tour.seen.v1` retired via the boot migration; `cockpit.tapestry`, `cockpit.chatMin`, `cockpit.initiative` survive (shell-level, not Cockpit — their names are kept to spare a migration).
- The Tapestry weaves commits, organs, scars and builds — no deck strands, no learned tint.
- Test hygiene: `vitest.config.ts` excludes `.claude/**` so agent worktrees inside the repo never join the suite.

### Phase-23a backlog (Rebirth residuals)

- **Orb transparent mode** — `Orb`/`OrbGL` keep a `transparent` prop that the shell no longer passes (it served the decks). Harmless and tested; drop it if nothing claims it by Phase 24.
- **Settings-organ seed upgrade** — existing installs keep the pre-Rebirth Settings organ (Cloud builder and Globe interaction sections) until reset; the seed-version upgrade path from the Phase-16 backlog would fix this class for good.
- **`cockpit.*` naming** — three surviving keys still carry the Cockpit prefix; rename with a migration when a settings pass is otherwise due.

## Phase-23 — Rebirth (packaged self-rebuild, 2026-09-04)

### Resolved in Phase 23 (Rebirth)

- **Packaged self-rebuild** — the genome (`git bundle`) ships in the app; threading seeds it into loomhome, vendors crates, installs node modules, warms the build; reweave builds `npm run build` + `cargo build --release --offline` under a shared `CARGO_TARGET_DIR`, shelves the running body under `generations/<sha>/`, swaps `Contents/MacOS/loom` atomically (write-then-rename), ad-hoc re-signs, writes the sentinel `applied` armed by `reweave`, and relaunches through the warden. (`src-tauri/src/{loomhome,threads,generations,platform,reweave,warden}.rs`, `scripts/genome-bundle.mjs`)
- **Faster cargo validation** — packaged validation worktrees live under `loomhome/worktrees/` and share `loomhome/target`; deps compile once at threading. (`kernel.rs` `cargo_env`)
- **`npx` gone from validation** — every worktree gets a `node_modules` symlink and validation invokes `node_modules/typescript/bin/tsc` and `vitest.mjs` through the recorded `node`; Phase 21's unstated npx-cache network dependency is closed. (`kernel.rs` `ts_argv`)
- **Mirror/JSON write atomicity** — every loomhome JSON (threads, ledger, reweave state, sentinel-at-path) is written temp-then-rename. (`threads::write_json_atomic`)
- **Recovery record surfaced once** — `kernel_boot_check` reports `healedGeneration` from `recovery.json` and deletes it; the notice reads "LOOM tried to become … and couldn't — it came home to …".

### Phase-23 backlog (beyond Rebirth)

- **Toolchain distribution** — LOOM only adopts tools already on the machine; a missing rustup/node/cmake is reported with its install line and threading stops. Installing them from inside the app (pinned versions, offline archives) is its own phase.
- **Windows / Linux swap** — `platform::swap_plan` returns a typed `Unsupported` off macOS; the build and the ledger still work. Windows needs the rename-running-exe dance and in-use locks; Linux needs AppImage/desktop-file handling.
- **Developer-ID signing + notarization** — reweave re-signs ad-hoc; a signed distribution would need the identity on the machine and a re-notarization path (or an unsigned-local policy stated plainly).
- **Microphone permission after re-sign** — ad-hoc re-signing changes the code identity; macOS may re-prompt for the mic. The card says so before the swap. A stable signing identity is the real fix.
- **Validation threat model** — unchanged from 22: validation runs model-authored code (build scripts, proc-macros, tests) in a worktree on the machine. A container/VM sandbox is the hardening if untrusted models ever author edits.
- **Shrink the setup-panic residual** — a compile-clean core edit that panics in untested startup code still costs one warden-healed relaunch; a headless setup-path smoke test in `cargo test` would catch more of them before the swap.
- **Multi-file / refactor edits** — unchanged from 22.
- **Kernel-edit history surface** — the Tapestry now knots generations; a filtered "what LOOM changed about itself" lens over `self:` commits is still open.
- **Legacy `("booting", unknown armedBy)` mirror test** — coverage hygiene carried from the Marrow round-2 hold.
- **boot_recover honoring a sourceRepo override** — dev-only; unchanged.
- **Seed upgrade** — existing installs keep the pre-Rebirth Settings organ until reset, so the LOOM page does not appear for them; the seed-version upgrade path is still the fix for this class.

### Resolved in Phase 22 (Marrow)

- Recovery gap closed — a compile-clean Rust core edit that panics at startup self-heals: `scripts/kernel-preboot.mjs` (pre-compile guard in `beforeDevCommand`, resets source to last-good before cargo recompiles) + `preboot_heal` (pre-`main` hook, before any fallible init) + the confirm beacon + a source-root sentinel mirror `.loom-boot.json` (gitignored, one source of truth). State machine: `applied`→`booting`→healthy `ok`, or unconfirmed→heal. Zero manual git. (`src-tauri/src/kernel.rs`, `src-tauri/src/lib.rs`, `scripts/kernel-preboot.mjs`)
- Rust core in the whitelist — `is_editable` allows `src-tauri/src/**/*.rs`; `PROTECTED_RUST` denies the whole safety core (main/lib/kernel/exec/error/timeline.rs) + the guard script + `Cargo.toml`/`Cargo.lock` (basename-anywhere, dependency = arbitrary-code vector), deny-before-allow, enumerated test. (`src-tauri/src/kernel.rs`)
- Cargo validation — `kernel_validate` runs `cargo check` + `cargo test` in the worktree for `.rs` edits (tsc+vitest for TS, both for mixed), cargo resolved to an absolute path once (PATH-hijack closed), 10/15-min timeouts, honest slow UX; real-cargo skip-guarded test proves the wall catches breakage. (`src-tauri/src/kernel.rs`)
- The core, honestly framed — `kernelBuild.ts` detects a core edit, emits a "compiling the core…" progress state, threads `isCore`/`needsRestart`; `KernelDiff.tsx` shows the CORE framing + "changed — restart LOOM to load the core"; `prompts.ts` teaches the Rust self-edit contract (cargo validation, restart semantics, PROTECTED_RUST) conditionally. (`src/lib/loom/kernelBuild.ts`, `src/components/chrome/KernelDiff.tsx`, `src/lib/loom/prompts.ts`)
- Honest scope: dev-mode only; the live Rust self-edit + restart + heal cycle is owner-verified in dev, not headless-CI-provable — CI proves the whitelist/self-protection, the real-cargo validation wall, the pre-boot/guard rollback logic + sentinel state machine. Two adversarial review rounds before merge.

### Resolved in Phase 21 (Selfhood)

- The safety core — `exec.rs` hardened command runner (fixed argv, canonicalized cwd under the source repo, process-group kill, timeout, ring-capped output); `kernel.rs` with worktree isolation, positive path whitelist + protected carve-out (self-protection invariant), SEARCH/REPLACE apply, source-repo timeline, `kernel_apply` as the sole live-tree write, recovery-boot sentinel + `boot_recover` wired before the webview loads. Real-`tsc` integration test proves the validation wall catches breakage. (`src-tauri/src/exec.rs`, `src-tauri/src/kernel.rs`, `src-tauri/src/lib.rs`)
- The walls (TS) — `kernelBuild.ts` pipeline (draft → propose → validate → bounded repair → review; apply structurally reachable only after validate+approval), `KernelDiff.tsx` diff-review card ("LOOM wants to change itself"), recovery beacon + notice (in protected paths), `self_edit` intent routing, dev-only guard (`import.meta.env.DEV`). (`src/lib/loom/kernelBuild.ts`, `src/components/chrome/KernelDiff.tsx`, `src/lib/loom/recovery.ts`, `src/components/chrome/recoveryNotice.tsx`)
- Builder self-edit knowledge — conditional `SELF_EDIT_CONTRACT` + worked example, injected only for self-edit drafting; ordering-proof test (apply never precedes validate+approval). (`src/lib/loom/prompts.ts`)
- Honest scope note: the live HMR self-edit loop (real model + running app) is owner-verified in dev, not headless-CI-provable; CI proves the five-wall ordering, the whitelist/self-protection, the spawn hardening, recovery-boot decisions, and (via the real-`tsc` test) that validation genuinely catches breakage.

### Phase-20 backlog (Initiative — deliberate non-goals)

- **Model-phrased rationale** — proposal rationales are rule-generated calm copy quoting real counts; a later pass could let the companion rephrase them in a warmer voice (still no model call for *detection* — only for phrasing an already-earned idea).
- **More archetypes** — after Rebirth one archetype ships (morning-brief on the timeline). Adding archetypes is a rules-engine + threshold addition once more organ patterns prove out; every rule must quote real observed counts.
- **Proposal analytics / learning beyond never-list** — the observer doesn't yet learn from accept/reject rates to tune its own thresholds; a bandit-style confidence loop is possible but needs a sovereignty-safe design (local only).
- **Richer usage observation** — only utterances and morning sessions are observed after Rebirth; deeper signals (dwell time, organ-usage frequency, time-of-day precision) would sharpen archetypes but widen the observation surface — add deliberately, stay local.

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

- **Settings-organ seed upgrades** — seeds install only when missing, so existing installs keep pre-Identity Settings (no ABOUT strip, no TAPESTRY toggle) until reset. Design a seed-version upgrade path that respects owner edits.

### Resolved in Phase 16 (Identity)

- Brand system — woven monogram (`public/brand/loom-glyph.svg`, `favicon.svg`; vite/tauri scaffold SVGs deleted), LoomGlyph chrome component with boot weft-draw, Settings ABOUT strip, `docs/BRAND.md` (palette as law, voice as law). (`src/components/chrome/LoomGlyph.tsx`, `index.html`)
- The Tapestry — Constellation removed (component, setting, mount) with idempotent `migrateSettings()` boot migration; pure `weaveModel` (warp = commits, weft = organs/scars/decks/builds with repair knots, learned tint; deterministic, capped 64); interactive SVG band (hover labels, click → organ/timeline), event-driven refresh, `cockpit.tapestry` default on. (`src/lib/tapestry/weave.ts`, `src/components/Tapestry.tsx`)
- The Shuttle — `catalog.ts` derived from the real command tables (anti-drift test-enforced through the actual classifiers), `fuzzyFilter`, ⌘K glass palette executing through the same `loom-utterance` seam as voice, free-text fallthrough, ⌘K hint chip; "what can you do" spoken from the catalog, zero model calls. (`src/lib/shuttle/catalog.ts`, `src/components/Shuttle.tsx`)

## From phase 16 (identity) Task 1 (2026-08-20)
- **Tauri app icon raster regeneration from loom-glyph (needs PNG pipeline)** — `src-tauri/icons/*` (`.png`/`.ico`/`.icns`) still carry the scaffold Tauri rasters; regenerate them from `public/brand/loom-glyph.svg` (favicon variant art) once a raster pipeline exists (e.g. rendered PNG → `tauri icon`). (`src-tauri/icons/`, `public/brand/loom-glyph.svg`)
