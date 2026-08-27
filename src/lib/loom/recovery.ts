/**
 * recovery.ts — the fifth wall: the boot beacon + recovery check.
 *
 * PROTECTED: this file lives under the `src/lib/loom/recovery` prefix that
 * Task 1 carved out of the editable whitelist. LOOM cannot edit its own
 * recovery machinery — if it could, a broken self-edit could also disable the
 * thing that undoes it, and every other wall would dissolve.
 *
 * Two responsibilities, both thin wrappers over the Rust safety core so they
 * are trivially testable and drift-proof:
 *
 *   runBootCheck()  — call EARLY on boot. If a prior self-edit never confirmed
 *                     a good boot, Rust has already hard-reset the source tree
 *                     to the pre-edit sha before the webview loaded the suspect
 *                     code; this reports the sha it came home to so the shell
 *                     can show a calm recovery notice.
 *   markBootOk()    — call once the shell has mounted and first paint settled.
 *                     Clears the pending sentinel: this boot held, so the last
 *                     applied edit is confirmed good.
 *
 * Both swallow errors (outside the desktop shell / no source repo they simply
 * no-op) — recovery must never itself become a boot hazard.
 */

import { kernelBootCheck, kernelBootOk } from "../core";

/** The event the shell listens on to surface the recovery notice. */
export const RECOVERY_EVENT = "loom-kernel-recovered";

// ── Boot-health flag (Finding 2) ──────────────────────────────────────────────
//
// markBootOk fires on a settle timer regardless of what happened during boot.
// Without this, a self-edit that breaks only a boundaried surface (caught by an
// ErrorBoundary, so the shell still paints) would be confirmed "good" and never
// roll back. This module-level flag lets an ErrorBoundary catch VETO the
// confirmation: if any boundary caught, markBootOk leaves the sentinel pending
// so the NEXT boot rolls the broken edit back.
//
// This flag lives in recovery.ts — the PROTECTED path — so LOOM cannot edit the
// mechanism that vetoes its own broken edits.

let bootErrored = false;

/** Record that a surface threw (an ErrorBoundary caught it). Idempotent. */
export function noteBootError(): void {
  bootErrored = true;
}

/** Whether any ErrorBoundary caught since load. Read by markBootOk. */
export function bootHadError(): boolean {
  return bootErrored;
}

export type RecoveryDetail = { sha: string; failed?: boolean };

/**
 * Early-boot guard. Returns the sha LOOM rolled back to (short or full — the
 * UI truncates), or null when nothing was rolled back. Dispatches
 * RECOVERY_EVENT with the sha so a decoupled notice can render.
 *
 * When Rust reports `rollbackFailed` (Finding 7 — a pending edit was found but
 * the rollback itself failed, and the sentinel has been marked so it won't
 * loop), this dispatches the event with `failed: true` and an empty sha so the
 * shell can surface the honest "couldn't come home" state instead of silence.
 */
export async function runBootCheck(
  check?: typeof kernelBootCheck,
): Promise<string | null> {
  try {
    // Resolve the beacon inside the try so a missing binding (e.g. a partial
    // test mock of core, or a packaged build with no command) is treated as
    // "no recovery guarantee here" rather than crashing boot.
    const fn = check ?? kernelBootCheck;
    const { rolledBackTo, rollbackFailed } = await fn();
    if (rolledBackTo) {
      window.dispatchEvent(
        new CustomEvent<RecoveryDetail>(RECOVERY_EVENT, { detail: { sha: rolledBackTo } }),
      );
      return rolledBackTo;
    }
    if (rollbackFailed) {
      window.dispatchEvent(
        new CustomEvent<RecoveryDetail>(RECOVERY_EVENT, { detail: { sha: "", failed: true } }),
      );
    }
    return null;
  } catch {
    // No shell / no source repo (packaged or browser dev) — recovery is a
    // dev-mode guarantee; silently no-op elsewhere.
    return null;
  }
}

/**
 * Confirm a good boot. Idempotent and error-swallowing — a missing sentinel or
 * an absent shell is a no-op.
 *
 * VETO (Finding 2): if any ErrorBoundary caught during the boot window, this
 * does NOT confirm — it leaves the pending sentinel in place so the NEXT boot
 * rolls the suspect edit back. A boundaried crash is still a broken boot even
 * though the shell painted around it. Returns whether it confirmed.
 */
export async function markBootOk(
  ok?: typeof kernelBootOk,
  hadError: () => boolean = bootHadError,
): Promise<boolean> {
  if (hadError()) {
    // A boundary caught during boot — do NOT confirm. Sentinel stays pending;
    // the next boot rolls back the broken edit.
    return false;
  }
  try {
    const fn = ok ?? kernelBootOk;
    await fn();
    return true;
  } catch {
    // no sentinel / no shell — nothing to confirm.
    return false;
  }
}
