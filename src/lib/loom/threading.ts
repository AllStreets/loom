/**
 * threading.ts — the one-time ceremony, the TS side.
 *
 * PROTECTED: this file lives under the `src/lib/loom/threading` prefix the
 * kernel keeps out of the editable whitelist. Threading is the step that
 * spends the owner's single network trip and runs for tens of minutes, and
 * this module is what carries its only stop button. A self-edit here could
 * quietly detach CANCEL from `thread_cancel`, or stop the card from ever
 * appearing, and the ceremony would run blind again — the same class of
 * surface as the reweave card, protected for the same reason.
 *
 * Thin orchestration over the Rust core, mirroring `reweave.ts`:
 *
 *   subscribe(onMsg)     — the threading card's feed: the `thread_status`
 *                          seed first, then every `loom-thread` event.
 *                          No-op outside the shell.
 *   stationIndex(step)   — the six-station rail's cursor.
 *   stationState(...)    — one station's colour, given the cursor.
 *   formatElapsed(ms)    — `m:ss`, uncapped minutes.
 *   cancelThreading()    — `thread_cancel`, with its refusals turned into
 *                          calm sentences.
 *
 * ── What a `thread_state` command would buy ────────────────────────────────
 * There is no Rust read of a ceremony IN FLIGHT. `thread_status` reports the
 * persisted completion markers (`steps`), the tool table and `needsNetwork` —
 * it cannot say "a ceremony is running right now, at `warm`, started nine
 * minutes ago". So this feed seeds only what it can honestly seed: whether
 * the network is still owed. The card itself stays absent until the first
 * `loom-thread` event, and its clock counts from that event rather than from
 * the ceremony's start.
 *
 * The gap that leaves: a shell that reloads mid-ceremony paints nothing until
 * the next event (during `warm` that is ≤ 2s, but between steps it can be
 * minutes), and then shows an elapsed time that is short by however long the
 * ceremony had already run. A `thread_state` command returning
 * `{ step, detail, tail, startedAt, elapsedMs, inFlight }` — the shape
 * `reweave_state` already has, persisted the same way — would close both.
 * It is a Rust addition and this surface is not the place to make it; the
 * card is honest about counting from when it started watching instead.
 */

import { listen } from "@tauri-apps/api/event";
import {
  threadCancel,
  threadStatus,
  ShellUnavailableError,
  THREAD_EVENT as CORE_THREAD_EVENT,
  type ThreadEvent,
  type ThreadStep,
  type ThreadStatus,
} from "../core";

/** The event Rust emits for every step of the ceremony. */
export const THREAD_EVENT = CORE_THREAD_EVENT;

/** The rail, in order (spec §Threading). `done` and `failed` are not stations. */
export const STATIONS: readonly ThreadStep[] = [
  "seed",
  "deps",
  "vendor",
  "warm",
  "register",
  "stamp",
];

/** The last station that can still spend the network — after it, LOOM is offline. */
const LAST_NETWORK_STATION = STATIONS.indexOf("vendor");

// ── Copy law (docs/BRAND.md): lowercase-leaning, no exclamation marks ─────────

/** Said BEFORE the fetch, per spec §Threading — Rust's own words. */
export const NETWORK_ONCE =
  "threading needs the network once — after that LOOM weaves offline.";

/** What CANCEL actually does. The ceremony marks each finished step, so the
 *  interrupted one is simply run again next time — this is a pause, not a
 *  wasted hour, and the owner should know that before they press it. */
export const CANCEL_MEANS =
  "cancelling stops the step that is running — every finished step is kept, so threading resumes here next time.";

/** `thread_cancel`'s refusal when threading is not the job in flight. */
export const NOTHING_TO_CANCEL = "nothing to cancel — the loom isn't being threaded";

/** When the shell is not there at all — a browser-mode LOOM has no ceremony. */
export const NO_SHELL_TO_CANCEL = "there is no ceremony here to stop — this LOOM has no shell";

export type StationState = "pending" | "active" | "done" | "failed";

/** Index of `step` on the rail; -1 for `done`, `failed`, and anything unknown. */
export function stationIndex(step: string): number {
  return STATIONS.indexOf(step as ThreadStep);
}

/**
 * One station's state, given the ceremony's current step and the furthest
 * station it reached (so a terminal step still shows where it stood).
 */
export function stationState(
  station: ThreadStep,
  step: string,
  lastStation: number,
): StationState {
  const i = stationIndex(station);
  const cursor = stationIndex(step);
  if (cursor >= 0) {
    if (i < cursor) return "done";
    if (i === cursor) return "active";
    return "pending";
  }
  if (step === "failed" && i === lastStation) return "failed";
  if (step === "done") return "done";
  if (i < lastStation) return "done";
  return "pending";
}

/** True while the ceremony is still short of the last networked station. */
export function beforeNetworkSpent(step: string): boolean {
  const cursor = stationIndex(step);
  return cursor >= 0 && cursor <= LAST_NETWORK_STATION;
}

/** `m:ss`, floored. Minutes are not capped — a cold ceremony passes an hour. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}

/** What the feed delivers: the seeding read once, then every event. */
export type ThreadFeedMsg =
  | { kind: "seed"; status: ThreadStatus }
  | { kind: "event"; event: ThreadEvent };

/**
 * Feed the card. Delivers the `thread_status` seed once — all the state that
 * can be read at mount (see the header note on `thread_state`) — then every
 * `loom-thread` event, until the returned function is called.
 *
 * Outside the shell (the initial read rejects with ShellUnavailableError)
 * nothing is delivered and nothing is listened for. Any other read failure
 * still subscribes: the events carry the ceremony either way.
 */
export function subscribe(onMsg: (m: ThreadFeedMsg) => void): () => void {
  let live = true;
  let unlisten: (() => void) | null = null;

  void (async () => {
    try {
      const initial = await threadStatus();
      if (live) onMsg({ kind: "seed", status: initial });
    } catch (e) {
      if (e instanceof ShellUnavailableError) return;
      // no threads.json yet, or the read failed — the events still carry it.
    }
    try {
      const off = await listen<ThreadEvent>(THREAD_EVENT, (ev) => {
        if (live) onMsg({ kind: "event", event: ev.payload });
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

export type CancelResult = { ok: true } | { ok: false; reason: string };

/**
 * Stop the ceremony, or say plainly why not. `thread_cancel` returns an error
 * when threading is not the job in flight — a race the card can lose honestly
 * (the ceremony finished between the paint and the click), so it is reported
 * as a sentence rather than surfaced as a raw error.
 */
export async function cancelThreading(
  cancel: typeof threadCancel = threadCancel,
): Promise<CancelResult> {
  try {
    await cancel();
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: reasonOf(e) };
  }
}

/** Turn a core rejection into a calm sentence, as `reweave.ts` does. */
function reasonOf(e: unknown): string {
  if (e instanceof ShellUnavailableError) return NO_SHELL_TO_CANCEL;
  const raw =
    typeof e === "string"
      ? e
      : e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string"
        ? (e as { message: string }).message
        : "threading could not be stopped — it will end on its own";
  const message = raw.replace(/^(http|timeout|parse|git|not found|unsupported):\s*/i, "");
  if (/nothing to cancel/i.test(message)) return NOTHING_TO_CANCEL;
  return message;
}
