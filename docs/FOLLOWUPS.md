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
