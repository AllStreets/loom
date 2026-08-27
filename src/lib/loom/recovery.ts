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

export type RecoveryDetail = { sha: string };

/**
 * Early-boot guard. Returns the sha LOOM rolled back to (short or full — the
 * UI truncates), or null when nothing was rolled back. Dispatches
 * RECOVERY_EVENT with the sha so a decoupled notice can render.
 */
export async function runBootCheck(
  check?: typeof kernelBootCheck,
): Promise<string | null> {
  try {
    // Resolve the beacon inside the try so a missing binding (e.g. a partial
    // test mock of core, or a packaged build with no command) is treated as
    // "no recovery guarantee here" rather than crashing boot.
    const fn = check ?? kernelBootCheck;
    const { rolledBackTo } = await fn();
    if (rolledBackTo) {
      window.dispatchEvent(
        new CustomEvent<RecoveryDetail>(RECOVERY_EVENT, { detail: { sha: rolledBackTo } }),
      );
      return rolledBackTo;
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
 */
export async function markBootOk(
  ok?: typeof kernelBootOk,
): Promise<void> {
  try {
    const fn = ok ?? kernelBootOk;
    await fn();
  } catch {
    // no sentinel / no shell — nothing to confirm.
  }
}
