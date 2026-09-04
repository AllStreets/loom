# LOOM Phase 23 — Rebirth (design)

**Date:** 2026-09-02 · **Status:** owner-directed ("a full powerful phase 23 — fully rebuild itself without cloud access"), spec for planning

## Problem

Phases 21 and 22 gave LOOM a body it can edit — TypeScript kernel and Rust core — behind five walls. But only in **dev**, on a machine with the repo checked out and `tauri dev` running. The packaged LOOM — the `.app` an owner double-clicks — cannot change. It has no source, no compiler, no way to become the thing it just wrote. The thesis says *a computer that is its own developer, offline, forever.* Until the packaged app can rebuild itself, the thesis is a demo.

Phase 23 makes the packaged LOOM **self-rebuilding**: it carries its own genome, threads the loom once from tools already on the machine, and from then on — with the network unplugged — edits its source, validates in isolation, weaves a new binary, swaps itself, relaunches, and heals if the new body cannot boot. The previous generation guards the birth of the next.

This phase follows the second excision (`docs/superpowers/plans/2026-09-02-rebirth-excision.md`): the Cockpit is gone, the cloud builder is gone. One brain, local. One body, self-woven.

## Vocabulary (brand-consistent, see BRAND.md)

- **genome** — LOOM's source repository, full git history. The packaged app carries it as a git bundle.
- **loomhome** — LOOM's private directory under the OS app-data dir. Everything it owns lives here.
- **threading** — the one-time ceremony that prepares the loom to weave: locate the tools, seed the genome, vendor every dependency, warm the build. *Threading a loom is what a weaver does before the first pass of the shuttle.*
- **reweave** — build a new binary from the current genome and become it.
- **generation** — one built binary, identified by the genome sha it was woven from. Kept in a ledger; any kept generation can be returned to.
- **the warden** — the previous generation's binary, relaunched with a single job: watch the new generation's first boot, and bring LOOM home if it fails.

## Modes

`mode` is resolved once at startup and reported by `kernel_identity`:

- **dev** — `tauri::is_dev()` is true. Source is the process cwd (unchanged from 21/22). Reweave builds but never swaps (`tauri dev` owns the binary); the UI says "restart `tauri dev`". Everything else in this phase is exercised in dev, which is how CI and the owner prove it.
- **packaged** — a built app. Source is `loomhome/source`. Reweave builds, swaps, relaunches.

The binary knows the sha it was woven from: `build.rs` emits `LOOM_GENOME_SHA` (from `git rev-parse HEAD`, or `unknown` outside a repo). `kernel_identity` returns `{ mode, genomeSha, generation, threaded, loomhome }`. The Settings organ and the Shuttle ("which generation is this") read it.

## Loomhome layout

```
<app_data>/loom/
  source/             the genome — a full git work tree (cloned from the bundled genome.bundle)
  source/.cargo/config.toml   vendored-source replacement (written by threading; PROTECTED)
  threads.json        threading manifest: tool paths + versions, threadedAt, threadedSha
  vendor/             `cargo vendor` output — every crate, offline
  target/             ONE warm cargo target dir, shared by validation worktrees and reweave
  worktrees/          validation worktrees (21/22 used a temp dir; packaged mode keeps them here)
  generations/<sha>/loom      the executable for that generation
  generations/<sha>/meta.json { sha, wovenAt, sizeBytes, reason }
  generations.json    ledger: { current, previous, kept: [...], keep: 3 }
  reweave.json        state of the current/last reweave: stage, startedAt, log tail, outcome
  warden.json         the warden's job file (written by reweave, read by the warden)
  kernel-boot.json    the sentinel (exists since 21)
```

The genome ships inside the app: `scripts/genome-bundle.mjs` runs in `beforeBuildCommand`, writes `src-tauri/genome/genome.bundle` (`git bundle create … --all`, ~20 MB) and `genome.json` `{ sha }`, both listed as Tauri bundle resources and gitignored. First packaged launch (or any launch where `loomhome/source` is missing) clones the bundle into `source/` and checks out the sha the binary was woven from. The Tapestry keeps its full history.

## Threading (the one-time ceremony)

`thread_status()` reports, per tool, `{ name, path | null, version | null, required, install }`:

| tool | required for | search order (fixed candidate dirs, then PATH) |
|---|---|---|
| git | everything | `/usr/bin`, `/opt/homebrew/bin`, `/usr/local/bin` |
| cargo, rustc | core | `~/.cargo/bin`, `/opt/homebrew/bin`, `/usr/local/bin` |
| node, npm | assets, TS validation | nvm current (`~/.nvm/versions/node/*/bin`, highest), `/opt/homebrew/bin`, `/usr/local/bin` |
| cmake, clang | native deps (whisper.cpp) | `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin` |
| codesign | swap (macOS) | `/usr/bin` |

Missing tools are reported with the exact install line (`xcode-select --install`, `brew install cmake`, the rustup one-liner). LOOM does **not** install toolchains in v1 — it says what is missing, plainly, and stops. Installing rustup/node inside the app is a follow-up (toolchain distribution).

`thread_loom()` runs the ceremony as a background job with progress events (`loom-thread`):

1. **seed** — clone `genome.bundle` into `source/` if absent; checkout `LOOM_GENOME_SHA`.
2. **deps** — `npm ci` in `source/` (network once). If offline: stop with "threading needs the network once — after that LOOM weaves offline."
3. **vendor** — `cargo vendor --versioned-dirs ../vendor` from `source/src-tauri`; write `source/.cargo/config.toml` with `[source.crates-io] replace-with = "vendored"` and `[net] offline = true`.
4. **warm** — `npm run build` then `cargo build --release --offline` with `CARGO_TARGET_DIR=loomhome/target`. This is the long step (native deps compile once; the sherpa prebuilt archive downloads once into the target's OUT_DIR and stays). Progress shows cargo's own "Compiling x/y" tail.
5. **register** — copy the *running* executable into `generations/<genomeSha>/loom` as generation 0, write the ledger.
6. **stamp** — write `threads.json`. `threaded` is true only when every step succeeded.

Threading is idempotent and resumable: each step checks its own completion marker, so an interrupted ceremony continues where it stopped. `thread_status` also verifies that recorded tool paths still exist and versions still match; drift is reported, not silently tolerated.

## Validation in packaged mode (walls 1–3, extended)

Unchanged in shape from 21/22; three packaged differences:

- **source root** — `resolve_source_repo` gains a packaged branch returning `loomhome/source`. The `kernel.sourceRepo` override is dev-only.
- **tools** — `cargo_path()` / `npx_path()` read `threads.json` first (absolute, recorded at threading), then fall back to the existing search. Cargo commands add `--offline`. `exec.rs` gains `run_checked_env(argv, cwd, root, timeout, envs)` — a fixed list of `(&str, &str)` pairs the caller composes from constants and LOOM-owned paths, never model output. Reweave and validation set `CARGO_TARGET_DIR` and `CARGO_NET_OFFLINE=true`.
- **shared target** — validation worktrees under `loomhome/worktrees/` use the shared `target/`. Dependencies compile once at threading; a core edit then validates in incremental time. The path-escape concern from the Phase-23 backlog is met because both the worktree and the target dir are inside loomhome, both canonicalized, and the env pair is composed in Rust from constants. **Found during recon:** Phase 21's temp worktree has no `node_modules`, so `npx tsc` there resolved through npx's own cache — an unstated network dependency that would break offline. Phase 23 closes it: every validation worktree gets a `node_modules` symlink to `source/node_modules` (dev: the cwd's), and validation invokes `<worktree>/node_modules/.bin/tsc` and `.bin/vitest` through the recorded `node` binary, never `npx`. This applies in dev too.

Approval and commit are unchanged. In packaged mode the diff card's applied state reads: **"woven into source — reweave to become it"** with a REWEAVE action. Setting `kernel.autoReweave` (default off) chains apply → reweave without the second click.

## Reweave (walls 4→5, the new machinery)

`reweave_start(reason)` — preconditions: threaded; no reweave or threading in flight; in packaged mode, source HEAD ≠ running generation's sha (or `force`). Runs as a background job; every stage emits `loom-reweave` `{ stage, detail, elapsedMs }` and appends to `reweave.json` (stage, log tail ≤ 400 lines, outcome). Stages:

1. **assets** — `npm run build` in `source/` (tsc + vite → `dist/`), 10-min timeout.
2. **core** — `cargo build --release --offline` in `source/src-tauri`, `CARGO_TARGET_DIR=loomhome/target`, 30-min timeout, cargo's "Compiling" tail streamed to the card.
3. **stage** — copy `target/release/loom` to `generations/<sha>/loom`, write `meta.json`, `codesign --force --sign - <exe>` (ad-hoc; macOS only; the tool path comes from `threads.json`). Prune the ledger to `keep` generations, never pruning `current` or `previous`.
4. **swap** — a *plan* computed by a pure function (`swap_plan(ledger, appExe, newSha) -> Vec<Step>`), then executed:
   - ensure `generations/<currentSha>/loom` exists (copy the live executable there if not — generation 0 may predate the ledger);
   - copy the new executable over `Contents/MacOS/loom` (macOS allows replacing a running executable's file; the running process keeps its mapped image);
   - `codesign --force --sign -` on the app bundle;
   - write the sentinel `{ status: "applied", applied_sha: newSha, prev_sha: currentSha, armedBy: "reweave" }` and the ledger `{ current: newSha, previous: currentSha, confirmed: false }`.
   Windows/Linux: `swap_plan` returns a typed `UnsupportedPlatform` error and the card says so plainly — the build and the ledger still work, the swap does not. Follow-up.
5. **relaunch** — write `warden.json` `{ oldPid, appPath, exePath, newSha, prevSha, loomhome, timeoutSecs: 90 }`, spawn `generations/<prevSha>/loom --warden <loomhome>/warden.json` detached (fixed argv, `setsid`-style new session so it survives our exit), then the card counts down "LOOM will close and return in a moment" and the app exits 0.

`reweave_cancel()` kills the job tree through the exec Guard (group kill) at any stage before **swap**. Swap and relaunch are not cancellable; the card says so before starting them.

Dev mode: stages 1–3 run (proving the pipeline in the environment CI can reach); 4–5 are skipped with the honest line "in dev, restart `tauri dev` to load the core."

## The warden (the fifth wall for a binary)

The warden is the **previous** generation's executable — a body already proven to boot — running `run()` with `--warden <job>` as its first argv. Argv dispatch is the first statement of `run()` in `lib.rs` (PROTECTED), before `preboot_heal`, before Tauri. The warden never constructs a Tauri app; it is a small loop in `warden.rs` (PROTECTED):

1. wait for `oldPid` to exit (poll, 30 s cap, then proceed);
2. `open -n <appPath>` (macOS LaunchServices launch — dock icon, mic permission, one instance);
3. watch the sentinel: the new binary's pre-main marks `booting`; a healthy shell calls `kernel_boot_ok`, which marks `ok` and sets `confirmed: true` in the ledger;
4. **confirmed within `timeoutSecs`** → the warden writes nothing else and exits;
5. **not confirmed** (the process vanished — `pgrep -f <exePath>` empty — or the timeout passed) → **heal**: kill any lingering new process, copy `generations/<prevSha>/loom` back over `Contents/MacOS/loom`, re-sign, write the sentinel `{ status: "healed" }` and a recovery record `loomhome/recovery.json` `{ failedSha, prevSha, reason: "crashed" | "never confirmed", logTail }`, set the ledger `current: prevSha`, `open -n <appPath>` again, exit.

Backstop when no warden is alive (the guard-absent case, mirroring Phase 22's pre-main hook): `preboot_heal` in packaged mode, on seeing `booting` a second time with `armedBy: "reweave"` and no live warden pid, performs the same heal routine in-process (swap the file back, write the record) and spawns the previous generation with `--warden` carrying a relaunch-only job, then exits. It never touches the Tauri builder first.

The healed app surfaces the record through the existing recovery notice, in LOOM's voice: *"LOOM tried to become 3f2a1c and couldn't — it came home to 8b91e0. The failed weave is kept under generations."* The record clears when the owner dismisses it.

### Sentinel state machine (extended)

| status | set by | meaning | actionable by |
|---|---|---|---|
| pending | TS apply (21) | hot-reloaded edit awaiting boot_ok this session | boot_check (same binary) |
| applied | Rust apply (22) / reweave swap (23) | new source or new binary awaiting first boot | guard (dev) / warden (packaged) |
| booting | pre-main (armedBy guard/premain/reweave) | first boot in progress | warden (packaged), guard on next start (dev) |
| ok | kernel_boot_ok | confirmed | — |
| healed | guard / pre-main / warden | rolled back, record written | — (terminal) |
| rollback-failed | any healer | could not come home | — (terminal; notice says so) |

`armedBy: "reweave"` is new. The pre-main hook must not heal a `booting` armed by `reweave` while `warden.json` names a live pid — the warden owns that attempt. This mirrors the guard/premain ownership rule that the round-1 Marrow review corrected; the decision table is a unit test.

## Generations (owner-facing rollback of the body)

`generations_list()` returns the ledger with `current`, `previous`, `confirmed`, and each kept generation's `{ sha, wovenAt, sizeBytes, reason, commitSubject }` (subject from the genome's git log). `generations_return(sha)` is a reweave job that skips **assets** and **core** — it stages nothing new, runs **swap** + **relaunch** with `newSha = sha`, guarded by the same warden. The Settings organ lists generations with a RETURN action; the Shuttle carries "return to the previous generation". Returning to a generation also checks out its sha in `source/` on a branch `generation/<sha7>` so the genome and the body agree; the owner's newer commits stay on `main`, nothing is lost.

## What the owner sees

- **Settings → LOOM** (the seed organ): mode · generation sha · threaded status with the tool table (name, version, path; missing tools with their install line) · THREAD THE LOOM action when unthreaded · the generations list with RETURN · `kernel.autoReweave` toggle · storage used by loomhome (honest: vendor + target run to a few GB).
- **The reweave card** (`src/components/chrome/Reweave.tsx`): a five-station rail — assets · core · stage · swap · relaunch — the live tail of the current tool, elapsed time, CANCEL while cancellable, and the countdown before exit. Uppercase-mono station labels, calm sentences, no exclamation marks.
- **The diff card** (`KernelDiff.tsx`): packaged mode changes the applied outcome to "woven into source — reweave to become it" with REWEAVE.
- **The recovery notice** (`recoveryNotice.tsx`): the healed-generation copy above.
- **The companion**: "reweave yourself" / "rebuild yourself" / "become the new version" → if HEAD is ahead of the running generation, a consent line ("weave generation 3f2a1c — LOOM will close and return") → REWEAVE; if not ahead: "nothing new to weave — the body already matches the genome." The consent line is mode- and platform-aware: in dev it reads "in dev the body stays; restart tauri dev to become it", and off macOS it says the swap is not implemented there — it never promises a close-and-return that will not happen. *Round-1 amendment:* the line does not name a commit count. Nothing in the core can count how far the genome is ahead, so "from 4 commits" was unreachable; a `genome_ahead` command would bring it back honestly. **"thread the loom" is a consent turn too** — it is the one step that reaches the network, so the card carries "threading needs the network once — after that LOOM weaves offline" *before* the fetch. "which generation is this" and "return to the previous generation" are rules, no model call ("return" asks first). On the first boot after a reweave the companion greets: "I'm back — generation 3f2a1c." (no model call; spoken per the speakReplies setting).
- **The Tapestry**: a generation strand — each woven generation is a knot on the timeline cloth; the current one luminous.
- **The Shuttle**: the new commands appear in the ⌘K catalog by derivation from the rule tables (the drift test enforces it).

## Self-protection (extended, enumerated)

Added to the protected set: `src-tauri/src/reweave.rs`, `warden.rs`, `threads.rs`, `generations.rs`, `platform.rs`, `src-tauri/build.rs`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/**`, `scripts/genome-bundle.mjs`, `package.json`, `package-lock.json`, `vite.config.ts`, `.cargo/config.toml` (any depth), `src/lib/loom/reweave.ts`, `src/lib/loom/generations.ts`. The enumerated test grows accordingly. Rule stays: any file that constructs the app, runs before recovery, spawns a tool, swaps a binary, or declares a dependency is protected.

## Prompts

`prompts.ts` teaches the packaged-mode contract conditionally (only when `mode === "packaged"`): a core edit becomes real only after a reweave the owner approves; the model should keep edits bounded because a reweave is minutes, not seconds; it must never propose edits to the protected set (already true).

## Non-goals

Installing toolchains (rustup/node) from inside the app · Developer-ID signing and notarization (ad-hoc only) · Windows and Linux swap (typed unsupported; build and ledger work) · fetching anything from the network at reweave time (never; `--offline` is enforced) · auto-update from a server (never — LOOM's only source of new versions is itself) · multi-file refactors (unchanged from 22's scope) · Rust hot-reload.

## Honest residuals (documented in README and the card)

- Threading needs the network **once** (npm registry, crates.io, the sherpa prebuilt archive). After that: offline forever.
- Ad-hoc re-signing may make macOS re-ask for microphone permission after a reweave. The card says so before the swap.
- A new generation that boots, paints, and then misbehaves *after* `kernel_boot_ok` is a confirmed generation; the owner returns to a previous one through Generations. Boot health is the wall, not behaviour.
- Loomhome is large (vendor + warm target: several GB). Settings shows the number.

## Testing

**Rust (unit, tempdirs, no network):** threads — candidate-dir search + version parse from fixture output, drift detection; genome — bundle clone into a tempdir and sha checkout (real git); ledger — prune rules never drop current/previous; `swap_plan` — the step list for first swap (no generation 0 yet), ordinary swap, return-to-generation, unsupported platform; sentinel decision table with `armedBy: "reweave"` and warden-alive ownership; warden — with `open`/`pgrep` injected as fakes and a fake sentinel writer: confirmed → exits clean; crashed → heals, writes record, relaunches; timeout → heals; the protected-set enumeration; `run_checked_env` rejects a cwd escape and passes envs.

**Rust (skip-guarded integration, real tools when present):** reweave stages 1–3 on a tiny fixture crate with a shared target dir prove the env plumbing and `--offline` (skip when cargo is absent or slow); `kernel_validate` against the shared target dir.

**Node:** `scripts/genome-bundle.mjs` produces a bundle a fresh clone can restore to the same sha.

**TS (vitest):** `reweave.ts` stage machine driven by mocked commands; the card's five states and cancel gating; `KernelDiff` packaged framing; companion rules for the four phrases incl. the "nothing new to weave" branch; Shuttle catalog drift; Settings seed renders the tool table with a missing tool and its install line; recovery notice healed-generation copy; Tapestry generation strand geometry.

**Owner-verified (not CI-provable, stated honestly):** `npm run tauri build` → launch the `.app` → thread → unplug → ask for a core change → validate → approve → reweave → LOOM returns as the new generation → then a deliberately panicking core edit → the warden brings it home. Two adversarial review rounds before merge, attack surface listed per Phase 22's precedent (binary swap, warden ownership, env injection, path escapes into loomhome, ledger pruning of a live generation).
