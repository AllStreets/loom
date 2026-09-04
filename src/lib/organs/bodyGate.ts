/**
 * bodyGate.ts — an organ may ASK about LOOM's body; only chrome may move it.
 *
 * Round-1 review found the `self` power handing any organ the binary swap
 * behind a one-click pill: `loom.self.reweave()` reached the protected
 * orchestration directly, and organs share the shell's JS realm, so once any
 * organ held `self` the swap was reachable from any organ's code. The grant
 * card is a wall around WHO may ask, and it was being read as a wall around
 * WHAT may happen. Those are different things.
 *
 * So the three acts on the body — thread, reweave, return — are requests now.
 * `requestBody` dispatches a `loom-body-request` CustomEvent and hands back a
 * promise that settles only when chrome answers:
 *
 *   approved and the act ran   → resolve
 *   the owner declined         → reject(BodyRequestDeclined, LINE_DECLINED)
 *   approved but the act refused → reject(Error, the core's own reason)
 *   nobody was listening       → reject(Error, LINE_NO_CHROME)
 *
 * The answer travels back through this module, not through another event: the
 * pending map is module-private, so nothing on the `loom` object an organ holds
 * can settle its own request. That is defense-in-depth, not a sandbox — organ
 * code shares the realm and could always dispatch a `loom-body-request` itself.
 * It would still land on the owner's card, which is the point: the wall that
 * matters is that ONLY the shell's listener calls `startReweave`,
 * `returnToGeneration` and `threadLoom`, and only after the owner says yes.
 */

/** The event chrome listens for. Detail is a `BodyRequest`. */
export const BODY_REQUEST_EVENT = "loom-body-request";

export type BodyRequestKind = "thread" | "reweave" | "return";

export type BodyRequest = {
  /** Opaque id — chrome answers with it; never reused. */
  id: string;
  kind: BodyRequestKind;
  /** The generation to return to. Only on `kind: "return"`. */
  sha?: string;
  /** Who asked. The card names it so the owner knows. */
  organId: string;
};

export type BodyAnswer =
  | { ok: true }
  | { ok: false; reason: string; declined?: boolean };

// ── Copy law (docs/BRAND.md): fact — hinge — remedy, lowercase, no exclamation ──

/** The owner pressed NOT NOW. */
export const LINE_DECLINED = "you said not now — the body stays as it is";
/** No chrome heard the request (browser mode, or a shell without the card). */
export const LINE_NO_CHROME = "there is no shell to ask — the body stays as it is";
/** A second request arrived while one was still on the owner's screen. */
export const LINE_BUSY = "another request is already waiting — answer that one first";

/** Thrown when the OWNER said no — distinct from the act itself refusing. */
export class BodyRequestDeclined extends Error {
  constructor(message: string = LINE_DECLINED) {
    super(message);
    this.name = "BodyRequestDeclined";
  }
}

type Pending = {
  claimed: boolean;
  resolve: () => void;
  reject: (e: Error) => void;
};

/** id -> the promise waiting on chrome. Module-private, deliberately. */
const pending = new Map<string, Pending>();

let seq = 0;
function nextRequestId(): string {
  seq += 1;
  return `body-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Chrome says "I have this one" — synchronously, from inside its
 * `loom-body-request` handler. An unclaimed request is answered by
 * `requestBody` itself with LINE_NO_CHROME, so an organ never waits forever
 * on a shell that is not there.
 */
export function claimBodyRequest(id: string): boolean {
  const p = pending.get(id);
  if (!p || p.claimed) return false;
  p.claimed = true;
  return true;
}

/** Chrome's answer. Unknown or already-answered ids are ignored. */
export function answerBodyRequest(id: string, answer: BodyAnswer): void {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (answer.ok) p.resolve();
  else if (answer.declined) p.reject(new BodyRequestDeclined(answer.reason || LINE_DECLINED));
  else p.reject(new Error(answer.reason || LINE_NO_CHROME));
}

/**
 * Ask the owner, through chrome, to move the body. Resolves only when the act
 * has actually run; see the module docblock for every settlement.
 */
export function requestBody(
  kind: BodyRequestKind,
  organId: string,
  sha?: string,
): Promise<void> {
  const id = nextRequestId();
  let settle!: Pending;
  const answered = new Promise<void>((resolve, reject) => {
    settle = { claimed: false, resolve, reject };
  });
  pending.set(id, settle);

  const detail: BodyRequest = sha === undefined
    ? { id, kind, organId }
    : { id, kind, sha, organId };

  try {
    // Synchronous: every listener runs before this returns, so a chrome that
    // is mounted has already claimed the request by the next line.
    window.dispatchEvent(new CustomEvent<BodyRequest>(BODY_REQUEST_EVENT, { detail }));
  } catch {
    // no window (a non-DOM runtime) — the same answer as no chrome.
  }

  if (!settle.claimed) answerBodyRequest(id, { ok: false, reason: LINE_NO_CHROME });
  return answered;
}

/** How many requests are still waiting. Tests and chrome's busy check. */
export function pendingBodyRequests(): number {
  return pending.size;
}
