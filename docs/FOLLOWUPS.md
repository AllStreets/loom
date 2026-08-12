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
