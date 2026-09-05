/**
 * generations.ts — the owner-facing ledger of bodies.
 *
 * PROTECTED: this file lives under the `src/lib/loom/generations` prefix that
 * the kernel keeps out of the editable whitelist. Returning to a previous
 * generation is the owner's rollback of the body itself — the last road home
 * when a woven binary boots but misbehaves. If LOOM could edit this module, a
 * broken self-edit could hide the generation that undoes it, or describe the
 * wrong one as current, and the ledger would stop being something the owner
 * can trust.
 *
 * Thin wrappers over the Rust ledger plus one pure formatter, so the Settings
 * list, the Shuttle entry, and the Tapestry strand all speak the same line.
 */

import { generationsList, generationsReturn, type Generation } from "../core";

/** Every kept generation, newest first. */
export async function listGenerations(): Promise<Generation[]> {
  return generationsList();
}

/**
 * Become `sha` again: the reweave job with assets/core/stage skipped, guarded
 * by the same warden. The core refuses when the generation's executable is
 * gone. LOOM will close and return.
 */
export async function returnToGeneration(sha: string): Promise<void> {
  return generationsReturn(sha);
}

/**
 * The generation "return to the previous generation" means: the newest body
 * on the shelf that is neither the one running nor one that failed to be born.
 *
 * Round-4 review, Finding 3. This was `rows.find(g => g.isPrevious)`, and the
 * warden's heal writes `{ current: prev, previous: <the failed sha> }` — so
 * right after LOOM has come home, the row flagged PREVIOUS is the body that
 * refused to boot. Taking it meant closing LOOM, swapping in that body, and
 * trusting the warden to bring it home a second time.
 *
 * The ledger's `previous` is still preferred when it is a body that was born
 * whole: it is the owner's mental "the one before this". When it is not, the
 * shelf's next newest survivor is the honest answer, and when there is no
 * survivor at all the answer is none — never the body that would not start.
 * Rows arrive newest first (`generations::list`).
 */
export function previousGeneration(rows: Generation[]): Generation | null {
  const home = rows.filter((g) => !g.isCurrent && !g.failedToBoot);
  return home.find((g) => g.isPrevious) ?? home[0] ?? null;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long ago `iso` was, in the calm short form: `just now`, `Nm ago`,
 * `Nh ago`, `Nd ago`. A stamp in the future reads as `just now` (clocks
 * drift); an unreadable one says so rather than inventing a number.
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "at an unknown time";
  const ms = now - then;
  if (ms < MINUTE) return "just now";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ago`;
  return `${Math.floor(ms / DAY)}d ago`;
}

/** `"3f2a1c · woven 2h ago · reweave · fix the orb pulse"` */
export function describe(g: Generation, now: number = Date.now()): string {
  return `${g.sha.slice(0, 6)} · woven ${relativeTime(g.wovenAt, now)} · ${g.reason} · ${g.commitSubject}`;
}
