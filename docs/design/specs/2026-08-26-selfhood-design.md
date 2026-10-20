# LOOM Phase 21 — Selfhood (design)

**Date:** 2026-08-26 · **Status:** approved direction + scope (owner), spec for planning

## Problem

LOOM's whole thesis is *a computer that is its own developer*. It builds organs — but the kernel, the thing it lives in, has always been off-limits, edited only by a human. Phase 21 flips that guardrail: **LOOM edits its own TypeScript kernel, safely, behind walls that make a bricked app impossible.**

This is the highest-blast-radius feature in the project. The design is the safety, not the capability. Every wall below is mandatory.

**Scope (owner-set):** TypeScript kernel (`src/**`) only, dev-mode (runs from source under `tauri dev` + Vite HMR). Rust core self-edits and packaged-app rebuilds are Phase 22. Approved edits commit to the source repo and hot-reload live.

## The five walls

An edit to LOOM's own source travels this path; it cannot skip a wall.

1. **Isolation.** The model's edit is never written to the live tree. Rust creates a git **worktree** of the source repo at a temp path and applies the edit there. The running app is untouched while validation happens.
2. **Validation (real, not sandboxed).** In the worktree, Rust runs — fixed-argv, no shell, hardened spawn like the old `agora.rs` (canonicalized cwd under the source repo, timeout, process-group kill, captured output) — `tsc --noEmit` and a targeted `vitest run` over the edited files and their tests. Failure → the builder's repair loop (bounded rounds, same as organs) → revalidate. Still failing → abort, worktree destroyed, live tree never touched, honest failure to the owner.
3. **Approval.** The owner sees the actual unified **diff** and approves or discards. Always-on for kernel edits (the organ "review before save" toggle, made mandatory here — the blast radius is the app itself).
4. **Commit.** On approval, Rust applies the validated patch to the live tree and commits to the source repo (`~/Downloads/LOOM/.git`) with a `self:` message, recording the pre-edit HEAD as **last-good**. Because it's a git commit, rollback is always one reset away.
5. **Recovery boot.** A boot beacon guarantees "it can't strand you": at apply-time Rust writes a sentinel `{prevSha, appliedSha, status:"pending"}`. When the shell mounts successfully it calls `kernel_boot_ok` → status `"ok"`. On startup, if the sentinel is still `"pending"` (the previous boot after an edit never confirmed — i.e. the edit broke the running app), Rust **hard-resets the source tree to `prevSha`** before the webview loads the suspect code, clears the sentinel, and LOOM comes home to the last good state.

## The self-protection invariant (critical)

LOOM must not edit its own safety machinery. The editable set is a **positive whitelist** — `src/**/*.ts(x)` — **minus** a protected list carved out in Rust and tested:
- the self-edit core: `src-tauri/src/kernel.rs`, `exec.rs`, and this whitelist itself (Rust is out of scope anyway, but named for clarity);
- the TS pipeline + walls: `src/lib/loom/kernelBuild.ts`, the diff-review card, the recovery-boot beacon/UI;
- entry points and config: `src/main.tsx`, `index.html`, `vite.config.ts`, `tsconfig*.json`, `package.json`.

A drafted edit targeting any protected path is rejected in Rust before isolation, with a typed error. Tested with an explicit "tries to edit the guard → refused" case.

## Architecture

- **Rust `src-tauri/src/exec.rs`** (new): `run_checked(argv, cwd, timeout) -> {code, stdout, stderr}` — fixed argv only (no user string reaches argv), cwd canonicalized and asserted under the source repo, `process_group(0)` + group-kill on timeout/exit (unix), output ring-capped. Tests: success, non-zero, timeout, cwd escape refused.
- **Rust `src-tauri/src/kernel.rs`** (new) + commands: `kernel_editable() -> paths/whitelist meta`; `kernel_propose(edits) -> {worktree, diff}` (validate paths against whitelist → create worktree → apply SEARCH/REPLACE edits → return unified diff); `kernel_validate(worktree) -> {ok, stage, output}` (tsc then vitest via exec); `kernel_apply(worktree, message) -> {sha, prevSha}` (apply to live tree + commit source repo + write pending sentinel); `kernel_rollback(sha)`; `kernel_boot_ok()` (sentinel → ok); `kernel_boot_check()` (startup guard: pending → rollback to prevSha). Source-repo path resolved from the dev cwd / a setting, asserted to be a git repo. Tests use tempdir git repos + real `tsc` where available (skip-guarded like the existing ignored live test).
- **TS `src/lib/loom/kernelBuild.ts`** (new): the pipeline orchestrator — draft a SEARCH/REPLACE edit for the target kernel file(s) via the builder (reuse `edits.ts` block format + small-output discipline), `kernel_propose` → `kernel_validate` → repair loop on failure → return `{diff, worktree}` for review; on approval `kernel_apply`. Mirrors `buildOrgan` structure; mocked-Rust tests for every branch (validate pass/fail/repair/abort/apply).
- **TS surface**: a deliberate, guarded entry (not the casual chat box — a distinct intent, e.g. "change yourself: …" / a SELF affordance) routing to the kernel pipeline; a **diff-review card** (glass, monospace unified diff, Approve / Discard, BRAND voice, honest "this edits LOOM itself" framing); the **boot-ok beacon** wired at successful shell mount; a **recovery notice** if a rollback happened on boot ("an edit didn't hold — LOOM came home to <sha>").
- **Builder knowledge** (`prompts.ts`): a compact self-edit contract (the whitelist, the SEARCH/REPLACE format against real current file contents, "your edit will be type-checked and tested before it can apply — write it to pass") injected only for kernel-edit requests.

## Non-goals

Rust-core self-edits, packaged-app rebuilds (both Phase 22), editing the safety machinery (forbidden, permanently), multi-file sweeping refactors (v1 favors small bounded edits), unattended apply (approval is always required), kernel edits while running a packaged build (dev-only — packaged shows an honest "self-editing needs dev mode" state).

## Testing

The dangerous parts are proven by the tests I can run headlessly: Rust unit/integration over tempdir git repos — path whitelist + self-protection refusal, worktree isolation + cleanup, patch apply, exec spawn (success/fail/timeout/cwd-escape), recovery-boot decision table (pending→rollback, ok→noop, absent→noop), source-repo timeline commit/rollback. A skip-guarded integration test runs the REAL `tsc` on a passing and a failing fixture in a temp worktree to prove the validation wall actually catches breakage. TS: pipeline branches with mocked Rust, diff-review card, beacon/recovery logic. The live HMR self-edit against the running app + real model is exercised by the owner in dev (documented honestly — it cannot be captured headlessly). `npm run check` green per task; final review at MAX rigor given blast radius.
