#!/usr/bin/env node
/**
 * kernel-preboot.mjs — the PRE-COMPILE recovery guard (Phase 22 / Marrow).
 *
 * PROTECTED. This is the load-bearing half of closing the "recovery gap" that
 * editable Rust opens: a Rust self-edit that passes `cargo check` yet PANICS at
 * startup — before the in-binary recovery can run — would strand the owner,
 * because a bad already-compiled binary cannot roll ITSELF back.
 *
 * This script runs BEFORE `cargo` compiles (wired as the first step of the
 * `tauri dev` chain), so it can reset the SOURCE tree to the last-good sha
 * BEFORE the bad Rust is recompiled. The recompile is then always from good
 * source — the healed launch never panics. Zero manual git.
 *
 * It reads the ONE authoritative boot state: the source-relative mirror
 * `.loom-boot.json` that the Rust `kernel_apply` writes at the repo root. This
 * is the SAME file the Rust pre-main hook (`preboot_heal`) reads — one source
 * of truth for both guards.
 *
 * State machine (mirror; see kernel.rs Sentinel):
 *   pending | applied | booting  → UNCONFIRMED (actionable)
 *   ok | healed | rollback-failed → terminal (no-op)
 * If UNCONFIRMED and prevSha present → `git reset --hard <prevSha>` on the
 * recorded source_root (or cwd), rewrite the mirror to `healed`, log a calm
 * line, exit 0.
 *
 * CORRUPTION-TOLERANT BY CONTRACT: a bad / absent / unparseable mirror, a
 * missing prevSha, or a failed git reset is a NO-OP that STILL exits 0. This
 * guard must NEVER block a normal build — the worst it may do is decline to
 * heal.
 *
 * Pure Node, no dependencies.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const MIRROR = ".loom-boot.json";

/** Statuses that mean "applied but never confirmed healthy" → actionable. */
function isUnconfirmed(status) {
  return status === "pending" || status === "applied" || status === "booting";
}

/**
 * Run the guard. `cwd` defaults to the repo root the dev command runs from
 * (process.cwd()). Returns a small result object (for the test); never throws.
 */
export function runGuard(cwd = process.cwd(), log = console.log) {
  const mirrorPath = join(cwd, MIRROR);

  // Absent mirror → nothing to heal. Silent no-op (the common case).
  if (!existsSync(mirrorPath)) {
    return { action: "noop", reason: "absent" };
  }

  // Read + parse defensively. Any failure → no-op, never block the build.
  let sentinel;
  try {
    sentinel = JSON.parse(readFileSync(mirrorPath, "utf8"));
  } catch {
    return { action: "noop", reason: "corrupt" };
  }
  if (!sentinel || typeof sentinel !== "object") {
    return { action: "noop", reason: "corrupt" };
  }

  const status = typeof sentinel.status === "string" ? sentinel.status : "";
  const prevSha =
    typeof sentinel.prevSha === "string" && sentinel.prevSha
      ? sentinel.prevSha
      : typeof sentinel.prev_sha === "string"
        ? sentinel.prev_sha
        : "";

  // Confirmed / terminal → no-op.
  if (!isUnconfirmed(status)) {
    return { action: "noop", reason: "confirmed" };
  }
  // Unconfirmed but no last-good sha to return to → cannot heal; no-op.
  if (!prevSha) {
    return { action: "noop", reason: "no-prev-sha" };
  }

  // Roll back to the repo the edit was applied to — the mirror's own
  // source_root — falling back to cwd for a hand-written mirror.
  const srcRoot =
    typeof sentinel.source_root === "string" && sentinel.source_root.trim()
      ? sentinel.source_root.trim()
      : cwd;

  // Fixed argv, fixed cwd — no shell, no interpolation of untrusted strings
  // into a command line. prevSha is a git object id we hand to git verbatim.
  const reset = spawnSync("git", ["reset", "--hard", prevSha], {
    cwd: srcRoot,
    encoding: "utf8",
  });

  if (reset.status !== 0) {
    // Rollback failed (sha gc'd / not a repo / wrong root). Do NOT loop or
    // block: mark rollback-failed so the next start is a no-op, exit 0.
    try {
      writeFileSync(
        mirrorPath,
        JSON.stringify({ ...sentinel, status: "rollback-failed" }, null, 2),
      );
    } catch {
      /* best effort */
    }
    return { action: "rollback-failed", prevSha, srcRoot };
  }

  // Healed: source is home to prevSha. Mark the mirror so neither guard nor
  // the in-binary hook re-triggers, then let the build proceed from good source.
  try {
    writeFileSync(
      mirrorPath,
      JSON.stringify({ ...sentinel, status: "healed" }, null, 2),
    );
  } catch {
    /* best effort — the git reset already landed */
  }
  log(
    `[kernel] pre-compile heal: a Rust edit never confirmed a healthy boot — ` +
      `source reset to ${prevSha.slice(0, 7)} before recompile (from good source).`,
  );
  return { action: "healed", prevSha, srcRoot };
}

// Run when invoked directly (not when imported by the test). Always exit 0.
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]).endsWith("kernel-preboot.mjs");
if (invokedDirectly) {
  try {
    runGuard();
  } catch {
    // Truly last-resort: nothing may block the build.
  }
  process.exit(0);
}
