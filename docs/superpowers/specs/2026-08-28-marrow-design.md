# LOOM Phase 22 — Marrow (design)

**Date:** 2026-08-28 · **Status:** approved direction + scope (owner), spec for planning

## Problem

Phase 21 gave LOOM its own TypeScript body to edit. But the *core* — the Rust that is the native binary LOOM lives inside — stayed off-limits. Phase 22 reaches the marrow: **LOOM edits its own Rust core, in dev, behind the same five walls, and — critically — with the recovery guarantee restored to full strength despite a hole that Rust opens and TypeScript never did.**

Two facts from recon shape everything (both verified against the toolchain):
1. **No hot-reload for Rust.** `tauri dev` compiles the native binary once at startup and does not watch `src-tauri/**`. A Rust self-edit committed to the tree changes nothing in the running app until it is rebuilt. So the apply outcome for Rust is **"committed — restart to load,"** not the live hot-reload of Phase 21. This is a toolchain reality, stated honestly in the UI.
2. **The recovery paradox.** Phase 21's `boot_recover` runs *inside* the Rust `setup()`. A TS edit can't touch the binary, so recovery always runs. A **Rust** edit that compiles (passes `cargo check`) but panics during startup — before `boot_recover`'s line — would bypass recovery. Same-binary rollback cannot fix an already-compiled bad binary. Owner decision: **close this gap as part of the phase.** LOOM must never strand you.

**Scope (owner-set):** Rust core (`src-tauri/src/**/*.rs`), dev-mode only. Packaged-app self-rebuild remains deferred (a later phase — it needs binary swapping + toolchain distribution, orthogonal to the walls).

## Closing the recovery gap (the heart of this phase)

The rollback must land *before the bad code compiles or runs*, and it must live in files LOOM can never edit. Three mechanisms, layered:

1. **The pre-compile guard (load-bearing).** A tiny Node script `scripts/kernel-preboot.mjs` runs as an npm `predev`/pre-`tauri dev` step — *before* `cargo` compiles. It reads the boot sentinel; if the last applied edit's boot was never confirmed healthy (status still pending/booting), it `git reset --hard`s the source to the recorded last-good sha and marks the sentinel `healed`, *then* the build proceeds. So the recompile is always from good source — the healed launch never panics. This script is PROTECTED (LOOM cannot edit it).
2. **The pre-`main` rollback (defense-in-depth).** The very first statements in `run()` — before `tauri::Builder` is constructed, before any lazy init a self-edit could add — perform the same sentinel check + source rollback. Lives in a PROTECTED module and in the PROTECTED `main.rs`/`lib.rs` entry. Catches the case where the guard was bypassed.
3. **The confirm beacon (unchanged from 21, extended).** A healthy boot (shell mounts → `kernel_boot_ok`) confirms the edit and clears the sentinel. For a Rust edit this happens on the *next launch*, not live. Sentinel state machine: `applied` → (next boot) → `booting` → healthy → cleared, OR never-confirmed → guard heals on the following start.

Net guarantee: a Rust edit that compiles but panics at startup costs **one restart cycle, fully automatic, zero manual git** — LOOM heals its own source. Honest residual (documented): the *first* launch after such an edit still panics once (the bad binary was already compiled before it was known bad); `cargo test` in isolation catches setup panics that any test exercises, shrinking this to untested setup code only.

## The walls (reused from Phase 21, extended)

1. **Isolation** — the same git worktree at HEAD. Unchanged.
2. **Validation** — for a Rust edit, `cargo check` **then** `cargo test` in the worktree (via the hardened `exec.rs`, longer timeout — honestly minutes, with slow-progress UI). A mixed edit set also runs `tsc`+`vitest`. Failure → repair loop (builder reads cargo's own errors) → revalidate, same as 21.
3. **Approval** — the same diff-review card; header notes when Rust core is touched and that a restart will be needed.
4. **Commit** — same commit-to-source + sentinel, with the recorded last-good sha.
5. **Recovery** — the three-mechanism gap-closure above.

## Self-protection extended (critical)

The whitelist grows to `src-tauri/src/**/*.rs`, so the Rust safety machinery moves from implicit-deny (it wasn't `src/**/*.ts`) to **explicit PROTECTED**. `PROTECTED_RUST` (denied, tested by enumeration): `src-tauri/src/main.rs`, `lib.rs`, `kernel.rs`, `exec.rs`, `error.rs`, `timeline.rs`, the new pre-boot module, plus `scripts/kernel-preboot.mjs` and `Cargo.toml`/`Cargo.lock` (a dependency edit is an arbitrary-code vector). New-Rust-module hazard is met with a test that asserts the safety set is refused AND a doc rule: any file that constructs the app, runs before recovery, or implements a wall must be added to `PROTECTED_RUST`.

## Non-goals

Packaged-app self-rebuild (deferred — needs binary swap/toolchain distribution), Rust hot-reload (toolchain can't), editing the safety core (forbidden, permanently), Cargo dependency edits (protected — arbitrary-code vector), multi-crate refactors.

## Testing

Rust (tempdir git repos): whitelist now accepts `src-tauri/src/**/*.rs` and refuses the enumerated `PROTECTED_RUST` set (+ case/traversal); the sentinel state machine (`applied`/`booting`/healed) decision table incl. the Rust "never-confirmed → heal on next start" path; pre-boot rollback logic. Skip-guarded integration: real `cargo check` on a passing and a type-error Rust fixture in a temp worktree proves the Rust validation wall catches breakage (guard: skip if cargo slow/absent). The pre-compile guard script gets a node test (given a pending sentinel + a temp git repo, it resets to last-good). TS: kernelBuild handles Rust targets + the "restart to load" outcome; the card's Rust framing. Honest scope note (in docs + commit): the live Rust self-edit + restart + heal cycle is owner-verified in dev, not headless-CI-provable; CI proves the whitelist/self-protection, the cargo validation wall (real cargo), the pre-boot/guard rollback logic, and the sentinel state machine. `npm run check` green per task; **two** adversarial review rounds (this is higher-risk than 21 — the binary itself is now editable).
