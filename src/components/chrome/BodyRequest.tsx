/**
 * BodyRequest.tsx — the shell's answer to an organ that asks about the body.
 *
 * Round-1 review, finding 1: the `self` power handed an organ the binary swap
 * behind a one-click pill. Organs run in the shell's own JS realm and are
 * explicitly NOT a security sandbox, so a capability one organ holds is one
 * any organ's code can reach. `loom.self.thread/reweave/returnTo` no longer
 * touch the protected orchestration at all — they dispatch a
 * `loom-body-request` (bodyGate.ts) and wait. This component answers them, and
 * it is the only place in LOOM's own code that calls `threadLoom`,
 * `startReweave` and `returnToGeneration` on an organ's behalf.
 *
 * It renders the SAME consent card the Companion uses, plus a quiet line
 * naming the organ that asked, and the line itself is composed from chrome's
 * own reading of the body (`kernel_identity`, which knows whether this body
 * can be swapped at all) — never from
 * anything the organ sent. The organ can ask; only the owner decides.
 *
 * Round-2 review taught this card three things:
 *   - the request it shows and the request it runs are ONE frozen record,
 *     claimed from the gate. The event carries only an id, so an organ holding
 *     the detail has nothing to swap between the sentence and the act;
 *   - the body is read when a request is CLAIMED, not at mount — a packaged
 *     self-edit moves the genome head while this component stays mounted, and
 *     a card naming the previous sha would be a lie;
 *   - the once-only guard is a ref, not state: three clicks inside one React
 *     tick all read the same stale `false` (the Companion documents the same
 *     hazard beside `settledConsents`).
 *
 * And it answers on the way out: an unmount with a card open (a render throw
 * caught by the ErrorBoundary, say) tells the organ there is no shell rather
 * than leaving its promise pending forever.
 *
 * One card at a time: a second request while one is open is refused with the
 * calm busy line rather than stacking, so a misbehaving organ cannot bury the
 * screen in cards.
 *
 * None of this is a security boundary — organs share the shell's realm and can
 * reach the Tauri bridge directly. It is honesty-enforcement and owner consent;
 * see the docblock in `bodyGate.ts`.
 */

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import ConsentCard, { type ConsentKind } from "./ConsentCard";
import LoomGlyph from "./LoomGlyph";
import { kernelIdentity, threadLoom, type Generation, type Identity } from "../../lib/core";
import { startReweave } from "../../lib/loom/reweave";
import { listGenerations, returnToGeneration } from "../../lib/loom/generations";
import {
  BODY_REQUEST_EVENT,
  LINE_BUSY,
  LINE_DECLINED,
  LINE_NO_CHROME,
  answerBodyRequest,
  claimBodyRequest,
  type BodyRequest as Request,
  type BodyRequestEvent,
} from "../../lib/organs/bodyGate";
import {
  LINE_THREAD_CONSENT,
  reweaveConsentLine,
  returnConsentLine,
} from "../../lib/companion/runtime";

/** z 1900 — above the reweave card (1700), below the permission modal (2000). */
const BODY_REQUEST_Z = 1900;

const KIND_TO_CONSENT: Record<Request["kind"], ConsentKind> = {
  thread: "thread_consent",
  reweave: "reweave_consent",
  return: "generation_return_consent",
};

/** What the card would say, composed only from what CHROME knows. */
export function requestLine(
  req: Request,
  identity: Identity | null,
  canSwap: boolean,
  failedBefore = false,
): string {
  const mode = identity?.mode ?? "dev";
  if (req.kind === "thread") return LINE_THREAD_CONSENT;
  if (req.kind === "return") return returnConsentLine(req.sha ?? "", mode, canSwap);
  // The genome's HEAD is what a weave builds; `genomeSha` is the body already
  // running (round-3 review, findings 1 and 2). A chrome that could not read
  // identity names no sha at all.
  // Round-4 review, Finding 4: the same sentence the companion speaks,
  // including the shelf's memory that this sha has already failed to be born.
  return reweaveConsentLine(identity?.genomeHead ?? null, mode, canSwap, failedBefore);
}

/** `"notes asked"` — the owner always knows who is asking. */
export function askedBy(organId: string): string {
  return `${organId} asked`;
}

export type BodyRequestProps = {
  /** Who this binary is — defaults to `kernelIdentity`; unreachable reads as dev. */
  identity?: () => Promise<Identity>;
  /** The shelf, read only to tell the owner when the weave being asked for is
   *  one that already failed to boot. Unreadable reads as "no failure". */
  shelf?: () => Promise<Generation[]>;
  /** The three acts, injectable so tests need no shell. */
  acts?: {
    thread: () => Promise<void>;
    reweave: () => Promise<{ ok: boolean; reason?: string }>;
    returnTo: (sha: string) => Promise<void>;
  };
};

const DEFAULT_ACTS = {
  thread: () => threadLoom(),
  reweave: () => startReweave(),
  returnTo: (sha: string) => returnToGeneration(sha),
};

export default function BodyRequest({
  identity = kernelIdentity,
  shelf = listGenerations,
  acts = DEFAULT_ACTS,
}: BodyRequestProps) {
  const rm = useReducedMotion() ?? false;
  const [req, setReq] = useState<Request | null>(null);
  const [id, setId] = useState<Identity | null>(null);
  const [failedBefore, setFailedBefore] = useState(false);
  // The open request, readable synchronously — a second `loom-body-request`
  // arrives in the same tick and must be refused, not queued behind stale state.
  // It holds the CLAIMED record: the card's sentence and the act it runs come
  // from the same frozen object, so the two can never describe different things.
  const open = useRef<Request | null>(null);
  // Once-only, in a ref: three clicks inside one React tick would all read the
  // same stale state and run the act three times.
  const busy = useRef(false);
  // The identity read belongs to the request that started it; a later card
  // must not be painted with an earlier body.
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const shelfRef = useRef(shelf);
  shelfRef.current = shelf;

  useEffect(() => {
    function onRequest(ev: Event) {
      const detail = (ev as CustomEvent<BodyRequestEvent>).detail;
      if (!detail || typeof detail.id !== "string") return;
      // Claim first, synchronously — an unclaimed request is refused by the
      // gate with "there is no shell to ask", which would be a lie here. What
      // comes back is the gate's own record, not the event's detail.
      const claimed = claimBodyRequest(detail.id);
      if (!claimed) return;
      if (open.current) {
        answerBodyRequest(claimed.id, { ok: false, reason: LINE_BUSY });
        return;
      }
      open.current = claimed;
      busy.current = false;
      // Read the body NOW: a packaged self-edit moves the genome head while
      // this component stays mounted, and the sentence must name what is true
      // at the moment the owner is asked.
      void (async () => {
        let got: Identity | null = null;
        try {
          const read = await identityRef.current();
          if (read && (read.mode === "dev" || read.mode === "packaged")) got = read;
        } catch {
          // no shell — the dev framing stands, and nothing can be swapped anyway.
        }
        let failed = false;
        if (got && got.genomeHead !== null) {
          try {
            const rows = await shelfRef.current();
            failed = rows.some((g) => g.sha === got.genomeHead && g.failedToBoot);
          } catch {
            // an unreadable shelf says nothing — never a warning LOOM invented.
          }
        }
        if (open.current !== claimed) return; // answered or unmounted meanwhile
        setId(got);
        setFailedBefore(failed);
        setReq(claimed);
      })();
    }
    window.addEventListener(BODY_REQUEST_EVENT, onRequest);
    return () => {
      window.removeEventListener(BODY_REQUEST_EVENT, onRequest);
      // Going away with a card open: the organ hears the no-chrome line rather
      // than waiting on a promise nothing will ever settle.
      const current = open.current;
      open.current = null;
      if (current) answerBodyRequest(current.id, { ok: false, reason: LINE_NO_CHROME });
    };
  }, []);

  function close() {
    open.current = null;
    busy.current = false;
    setReq(null);
  }

  function choose(confirmed: boolean) {
    const current = open.current;
    if (!current || busy.current) return;
    busy.current = true;
    if (!confirmed) {
      answerBodyRequest(current.id, { ok: false, reason: LINE_DECLINED, declined: true });
      close();
      return;
    }
    void (async () => {
      try {
        if (current.kind === "thread") {
          await acts.thread();
        } else if (current.kind === "return") {
          await acts.returnTo(String(current.sha ?? ""));
        } else {
          const out = await acts.reweave();
          if (out && out.ok === false) {
            answerBodyRequest(current.id, { ok: false, reason: out.reason ?? "" });
            close();
            return;
          }
        }
        answerBodyRequest(current.id, { ok: true });
      } catch (e) {
        answerBodyRequest(current.id, {
          ok: false,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
      close();
    })();
  }

  return (
    <AnimatePresence>
      {req && (
        <motion.div
          data-testid="body-request"
          initial={rm ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={rm ? undefined : { opacity: 0 }}
          transition={rm ? {} : { duration: 0.25 }}
          style={{
            position: "fixed",
            bottom: 96,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: BODY_REQUEST_Z,
            width: 460,
            maxWidth: "calc(100vw - 48px)",
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
            background: "var(--glass)",
            backdropFilter: "blur(var(--blur))",
            WebkitBackdropFilter: "blur(var(--blur))",
            border: "1px solid var(--glass-border)",
            boxShadow: "var(--shadow-2)",
            borderRadius: 14,
            padding: "14px 16px",
          }}
        >
          <LoomGlyph size={18} style={{ flexShrink: 0, marginTop: 2 }} />
          <ConsentCard
            consent={KIND_TO_CONSENT[req.kind]}
            line={requestLine(req, id, id?.canSwap ?? false, failedBefore)}
            note={askedBy(req.organId)}
            settled={null}
            onChoose={choose}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
