/**
 * reweave.ts — walls 4→5, the TS side of the build job.
 *
 * PROTECTED: this file lives under the `src/lib/loom/reweave` prefix that the
 * kernel keeps out of the editable whitelist. LOOM cannot edit the machinery
 * that turns its edited genome into a new body — if it could, a broken
 * self-edit could also disarm the preconditions (threaded, nothing in flight,
 * something new to weave) or the cancel path, and the warden would be guarding
 * a birth that was never honestly announced.
 *
 * Thin orchestration over the Rust safety core, so it is trivially testable
 * and drift-proof:
 *
 *   subscribe(onState)   — the reweave card's feed: the persisted state first
 *                          (so a card opened mid-weave paints correctly), then
 *                          every `loom-reweave` event. No-op outside the shell.
 *   startReweave(...)    — the preconditions in copy-law sentences, then
 *                          `reweave_start`. The core re-checks everything; this
 *                          layer exists so the refusal reads calmly and never
 *                          reaches Rust when the answer is already known.
 *   stationIndex(stage)  — the five-station rail's cursor.
 *
 * Everything swallows the missing shell: a browser-mode LOOM has no body to
 * reweave, and this module must never itself become a boot hazard.
 */

import { listen } from "@tauri-apps/api/event";
import {
  kernelIdentity,
  reweaveStart,
  reweaveState,
  ShellUnavailableError,
  type ReweaveState,
} from "../core";

/** The event Rust emits after every state change of the job. */
export const REWEAVE_EVENT = "loom-reweave";

export type ReweaveStage =
  | "idle"
  | "assets"
  | "core"
  | "stage"
  | "swap"
  | "relaunch"
  | "done"
  | "failed"
  | "cancelled";

/** The rail, in order. Terminal and idle stages are not stations. */
export const STATIONS: readonly ReweaveStage[] = ["assets", "core", "stage", "swap", "relaunch"];

// ── Copy law (docs/BRAND.md): fact — hinge — remedy, lowercase, no exclamation ──

export const REASON_UNTHREADED = "the loom isn't threaded — open Settings";
export const REASON_NOTHING_NEW = "nothing new to weave — the body already matches the genome";
export const REASON_IN_FLIGHT = "a weave is already under way";


/** Index of `stage` on the rail; -1 for idle, done, failed, cancelled. */
export function stationIndex(stage: ReweaveStage): number {
  return STATIONS.indexOf(stage);
}

/**
 * Feed the card. Delivers the persisted state once, then every event, until
 * the returned function is called. Outside the shell (the initial fetch
 * rejects with ShellUnavailableError) nothing is delivered and nothing is
 * listened for. Any other fetch failure (say, no `reweave.json` yet) still
 * subscribes — the first event will paint the card.
 */
export function subscribe(onState: (s: ReweaveState) => void): () => void {
  let live = true;
  let unlisten: (() => void) | null = null;

  void (async () => {
    try {
      const initial = await reweaveState();
      if (live) onState(initial);
    } catch (e) {
      if (e instanceof ShellUnavailableError) return;
      // no persisted state yet — the events will carry it.
    }
    try {
      const off = await listen<ReweaveState>(REWEAVE_EVENT, (ev) => {
        if (live) onState(ev.payload);
      });
      if (live) unlisten = off;
      else off();
    } catch {
      // the event bridge is absent — nothing to subscribe to.
    }
  })();

  return () => {
    live = false;
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
  };
}

export type StartDeps = {
  start: typeof reweaveStart;
  identity: typeof kernelIdentity;
};

export type StartResult = { ok: true } | { ok: false; reason: string };

export type ReadinessDeps = { identity: typeof kernelIdentity };

export type Readiness =
  | {
      ok: true;
      generation: string | null;
      genomeSha: string;
      mode: "dev" | "packaged";
      /** Whether this body can actually be swapped — read from the core, which
       *  knows. The consent line must not promise a close-and-return that the
       *  platform will refuse. */
      canSwap: boolean;
    }
  | { ok: false; reason: string };

/**
 * The dry run: is there a weave to start, without starting it. The companion
 * asks this before it asks the owner for consent, so the consent line can
 * name the generation it would weave and a refusal reads the same calm
 * sentence the card would show.
 *
 * Preconditions read from `kernel_identity`:
 *   - not threaded → REASON_UNTHREADED
 *   - the running generation already IS the genome head (and not `force`)
 *     → REASON_NOTHING_NEW. A null generation (no body woven yet, or dev mode)
 *     always has something to weave.
 */
export async function reweaveReadiness(
  deps: ReadinessDeps = { identity: kernelIdentity },
  force = false,
): Promise<Readiness> {
  try {
    const id = await deps.identity();
    if (!id.threaded) return { ok: false, reason: REASON_UNTHREADED };
    if (!force && id.generation !== null && id.generation === id.genomeSha) {
      return { ok: false, reason: REASON_NOTHING_NEW };
    }
    // `mode` travels with the verdict so the consent line can say what will
    // actually happen — in dev nothing is swapped and LOOM does not close.
    return {
      ok: true,
      generation: id.generation,
      genomeSha: id.genomeSha,
      mode: id.mode,
      canSwap: id.canSwap,
    };
  } catch (e) {
    return { ok: false, reason: reasonOf(e) };
  }
}

/**
 * Start a reweave, or say plainly why not — `reweaveReadiness` first, then
 * `reweave_start`. The core enforces the same rules plus "nothing in flight";
 * its refusal is passed through as the reason, with the in-flight case mapped
 * to REASON_IN_FLIGHT so the card and the companion speak one line.
 */
export async function startReweave(
  deps: StartDeps = { start: reweaveStart, identity: kernelIdentity },
  force = false,
): Promise<StartResult> {
  const ready = await reweaveReadiness({ identity: deps.identity }, force);
  if (!ready.ok) return ready;
  try {
    await deps.start(force);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: reasonOf(e) };
  }
}

/** What an applied kernel edit was, as far as the auto-reweave decision cares. */
export type AppliedEdit = { mode: "dev" | "packaged"; isCore: boolean };

/**
 * Should an approved apply start a weave with no second click?
 *
 * Only when all three hold, because that is exactly what the owner opted into:
 *   - packaged — in dev `tauri dev` owns the binary and nothing is swapped;
 *   - the edit reached the CORE — a TypeScript edit is bundled by the next
 *     weave anyway, and closing the app for it is a surprise the toggle never
 *     promised ("after an approved **core** edit");
 *   - `kernel.autoReweave` is on.
 *
 * Pure so the decision is testable without a shell — the caller reads the
 * setting and passes it in.
 */
export function shouldAutoReweave(applied: AppliedEdit, setting: string): boolean {
  return applied.mode === "packaged" && applied.isCore === true && setting === "on";
}

/**
 * Turn a core rejection into a calm sentence. LoomError serializes as
 * `{ kind, message }` with the message prefixed `"<kind>: "`; strip that. A
 * refusal about a job already running becomes REASON_IN_FLIGHT verbatim.
 */
function reasonOf(e: unknown): string {
  const raw =
    typeof e === "string"
      ? e
      : e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string"
        ? (e as { message: string }).message
        : "the weave could not start — try again from Settings";
  const message = raw.replace(/^(http|timeout|parse|git|not found|unsupported):\s*/i, "");
  if (/under way|in flight|already running/i.test(message)) return REASON_IN_FLIGHT;
  return message;
}
