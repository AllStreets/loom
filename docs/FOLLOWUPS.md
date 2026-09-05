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

### Round-1 review (2026-09-04) — what it found, and what it left

Four adversarial reviewers plus a real build. **Everything below the "resolved"
line was fixed on-branch; these are the residuals that remain.**

**The build and the launch were the biggest findings, and no reviewer could
have read them out of the code.** `npm run tauri build` had never been run on
this branch: it failed outright (Tauri defaults the macOS deployment target to
10.13; whisper.cpp needs 10.15+), and once it built, the app died at launch
because the TTS dylibs carry `@rpath` install names and nothing emitted an
rpath — in dev too. Phase 23's whole premise is a packaged LOOM, and there had
never been one. **Rule for every later phase: build it and launch it before
calling it shipped.**

- **The validation asymmetry (the open design decision).** Rust validation runs
  `cargo test --no-run` because Marrow's round-1 review named executing
  model-authored tests as RCE. TypeScript validation still *runs* vitest on the
  model's own edit — a reviewer proved arbitrary code executes, pre-approval,
  with the worktree now a sibling of the generation shelf. Moving the worktree
  does not help: escaping code can use absolute paths. The honest options are
  (a) typecheck-only for TS, matching Marrow and losing a wall the README
  advertises, or (b) keep it and state the residual. **Currently (b), stated
  here.** Owner's call.
- **The kernel-edit whitelist assumes edited TS is not adversarial.** A reviewer
  proposed moving `kernelBootOk` out of the editable `core.ts`; that is
  cosmetic, because any edited module can invoke the command directly through
  the Tauri bridge. The real statement is the one already made about organs: the
  TS realm is honesty-enforcement, not a security boundary. A self-edit that
  deliberately calls the confirm beacon defeats the boot-health veto. Closing it
  needs a Rust-side proof the shell cannot forge.
- **`genome_ahead`.** The consent line for an irreversible act names the
  generation but not how much is changing; `commitsAhead` was hardwired to null
  and has been removed rather than left as a promise the code could not keep. A
  `git rev-list --count <generation>..HEAD` command in the source repo would
  restore "weave generation 3f2a1c from 4 commits" honestly.
- **A clean owner-quit inside the warden's confirmation window still reads as a
  crash** after three consecutive empty process samples. Narrowed, not closed;
  distinguishing intent needs a quit beacon from the shell.
- **The unsigned-bundle window.** Death between the executable copy and the
  re-sign leaves a bundle whose seal is stale. Mitigated (the copied body was
  already ad-hoc signed as a Mach-O at the stage step, so the bundle re-sign is
  a reseal), and closing it properly would mean spawning the warden before the
  swap — a design change.
- **A truncated *previous* body is still trusted by the heal.** `shelved_whole`
  guards the return path but not the heal; making the heal refuse would turn a
  bad heal into `rollback-failed`, which is arguably worse. Wants a decision.
- **The sherpa archive is fetched over HTTP at build time** and cached in
  `~/Library/Caches/sherpa-rs`, outside loomhome and purgeable by macOS.
  Threading now records the path and `thread_status` reports it as drift when it
  is gone, so an offline weave fails early and honestly — but the TS side does
  not surface that drift yet (`ThreadStatus.sherpaCache` is inert in Settings).
- **Inherited environment.** No spawn calls `env_clear`, so `RUSTFLAGS`,
  `CARGO_HOME` and `NODE_OPTIONS` reach the compiler and the validator from
  whatever launched LOOM. Outside the stated threat model, but an allowlist
  would match the sovereignty claim.
- **Validation and reweave contend on the shared cargo target dir**, so a
  validation can queue behind a 30-minute weave and time out as an
  infrastructure fault rather than a real failure.
- **Voice models are already committed** in existing installs' organ timelines
  (the pathspec fix stops future staging; it does not rewrite what is there).
- **The genome bundle carries the repo's whole history**, including the deck
  scratch removed on this branch. Untracking stops it reaching a fresh
  checkout's working tree; the blobs remain in history.
- **The body-consent card is not a wall (round-2).** `bodyGate` + `BodyRequest`
  make every path LOOM itself offers end at a card the owner reads, and the card
  can no longer describe one act while performing another. It is not a security
  boundary: organs run in the shell's JS realm, so organ code can dispatch a
  `loom-body-request` itself, synthesise a click on the card, answer a card it
  did not raise, or skip the card entirely and call
  `window.__TAURI_INTERNALS__.invoke("reweave_start")` with no grant at all.
  This is the same statement already made about the kernel-edit whitelist. A
  real wall would put the decision outside the webview realm — a native
  confirmation issued by the Rust core before `reweave_start` does anything —
  and that does not exist yet.
- **`kernel.autoReweave` moved to the `self` power, not out of organs' reach
  (round-2).** The key arms a card-free weave after an approved core edit, so
  `loom.settings.set` refuses it and `loom.self.setAutoReweave` writes it: the
  generic `settings` grant no longer carries a body decision. It is still an
  organ API, and settings are localStorage-backed in a shared realm, so this is
  capability hygiene rather than a wall. Taking it out of organs entirely needs
  a chrome-owned control to replace the Settings toggle (the KernelDiff card
  does at least disclose, at approval time, that the weave will start on its
  own).

### Resolved in the round-2 review (2026-09-04)

Round 1 moved the consent for a body change into shell-owned chrome. Round 2
broke that gate; every finding was reproduced by an executed test first.

- **The card's sentence and the act could be made to disagree.** The
  `loom-body-request` detail carried `{kind, organId, sha}` and chrome read that
  same mutable object again when the owner clicked — so an organ listening for
  the event could hold the reference and swap it in between: a THREAD card
  running a binary swap, a return consent naming one sha calling `returnTo` with
  another, a card naming an innocent organ. The event carries an opaque id now;
  `claimBodyRequest` returns the module-private record, frozen, and the card
  composes and acts from that alone.
- **Identity is read when a request is claimed, not at mount** — a packaged
  self-edit moves the genome head while the card stays mounted, and the card was
  naming the old sha with a stale `canSwap` beside it.
- **The double-fire guard is a ref**, like the Companion's: three clicks in one
  React tick all read the same stale state and ran the act three times.
- **An unmount with a card open answers the organ** with the no-chrome line
  instead of leaving its promise pending and the entry leaked.
- **`kernel.autoReweave` left the generic `settings` grant** (above), and the
  Settings toggle's label reads `canSwap` from the core instead of promising a
  close-and-return that dev and non-macOS builds will not do.
- **The owner's own NOT NOW is no longer painted in the warn token**, the
  post-return line no longer promises a rail on a body that just stayed, and the
  sandbox's `identity()` returns `canSwap` like the shell does.
- **Three overclaims corrected** — `bodyGate.ts`, this file, and the spec said
  or implied the card was the only path to the orchestration. It is not; see the
  residual above.

### Resolved in the round-1 review (2026-09-04)

- The packaged app builds (`minimumSystemVersion` 11.0) and launches (rpaths for
  the TTS dylibs, shipped as bundle frameworks).
- A generation can no longer lie about its own name: `build.rs` watches the ref
  HEAD resolves to, not just HEAD, so a commit on a branch actually reruns it.
  The seed follows the bundle's own `genome.json` sha when the two disagree.
- The swap arms every healer *before* it destroys the running body; the sentinel
  is written atomically; the shelf copy is atomic and size-verified.
- The warden no longer kills a window in use, no longer reads one missed process
  sample as a crash, retries `open`, and guards only the birth it names.
- The organ timeline stages `organs` only — it shares its work tree with
  loomhome, and would have swept the vendored crates, the warm target and every
  shelved binary into the timeline on the next organ write.
- Threading works in dev (the source is resolved per mode), `npm` gets a PATH
  carrying the recorded node, CANCEL reaches every ceremony step, and a
  panicking job returns its slot.
- The streaming runner's timeout fires even while a child keeps printing —
  before this, reweave and threading had no timeout at all.
- An organ that goes through LOOM's own API can now only *ask* for a body
  change: `loom.self.thread/reweave/returnTo` dispatch a request and shell-owned
  chrome renders the owner's consent card before anything runs. **The card is
  honesty-enforcement and owner consent, not a security boundary** — see the
  residual below. That chrome is protected, as are the organ power seam, the
  manifest wall, the reweave card and the settings seed.
- `autoReweave` honours `isCore`; a refused weave is spoken rather than
  swallowed; the point-of-return warning arrives while CANCEL still works; the
  consent line tells the truth in dev and off macOS, reading `canSwap` from the
  core instead of guessing from a user-agent string.
- `generations_return` validates its sha before it becomes a path component or a
  git start-point, and `short()` no longer panics on multi-byte input.
- The whitelist is re-checked against where a path canonically lands, so a
  symlink cannot be written through to the safety core.
- The deck scratch that was compiled into the shipped binary — including a local
  settings file with personal URLs — is out of `public/`.

### Round-3 review (2026-09-04/05) — the round that found the phase inert

Three reviewers: the combined state machine, every Rust↔TS seam, and a clean
clone. **The headline is that a packaged LOOM could not have rebuilt itself, and
two rounds of slice reviews had not seen it** — because it is invisible in dev,
which is where all the proving had been done.

**Resolved**

- **The weave was unreachable after the first one.** Rust and TypeScript
  answered "is the genome ahead of the body?" with different pairs of shas: the
  shell compared the ledger against `genomeSha`, the sha compiled into the
  running binary — and threading deliberately sets those equal, so the answer
  was always "nothing new to weave". Every route funnelled through that gate and
  the core's correct rule sat behind it, unreachable. `kernel_identity` carries
  `genomeHead` now, resolved the same way a weave resolves its target.
- **The consent line named the running body**, not what would be woven. Same
  root cause, same fix.
- **`running_sha` asked the ledger which body was running.** The baked sha is
  compiled into the executing binary and cannot be wrong about that; the ledger
  is a claim about disk and may lag. `check_start`, `check_return`, `settle`, the
  warden's fallback and `swap_plan` all take the running body as an argument now.
- **Threading died in its longest step on a packaged app.** Round 1 gave npm a
  PATH because it is a `#!/usr/bin/env node` shim; cargo needed the same for its
  own reason — native build scripts resolve `cmake` by name, and a
  Finder-launched app has almost nothing on PATH. Every cargo spawn now carries
  the recorded toolchain directories and `CMAKE`.
- **A live warden healed over a later body.** It never checked that the birth it
  guarded was still the one in play; the backstop already had that check.
- **`boot_ok_at` overwrote terminal sentinels**, so a late beacon from a failed
  body erased the heal that had just happened.
- **A failed heal reached the owner as silence** — Rust reported it and the
  notice dropped it, because a rollback that failed carries no sha, which is
  exactly what makes it the notice that matters.
- **The loomhome ignore matched `*.json` at every depth**, silently dropping
  every organ's manifest from the organ timeline on a fresh install.
- **`unknown` was refused only after the build** — up to thirty minutes in.
- **CI could not catch the class of bug that opened this review.** It now
  typechecks and builds the packaged app, asserting the `.app` exists, is
  executable, and carries the genome it must rebuild from.

**Closed after the review, in the same run**

- **The carried genome is re-staged at `stage`**, so the bundle inside the app
  names the body it is about to become. It kept the sha the app was first built
  at, and a re-seed would have rewound the genome past every self-edit.
- **The warden's reason reaches the owner.** The notice flattened a crash and a
  body that was still running when the clock ran out into one sentence; the
  hinge follows what the warden actually saw now.

**Left standing, deliberately**

- **A SIGKILLed warden still leaves its pid behind.** `release_pid` clears it on
  every ordinary exit; only an outright kill defeats it, and the sha stamp is the
  load-bearing half anyway.

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
