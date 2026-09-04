/**
 * BodyRequest.tsx — the shell's answer to an organ that asks about the body.
 *
 * Round-1 review, finding 1: the `self` power handed an organ the binary swap
 * behind a one-click pill. Organs run in the shell's own JS realm and are
 * explicitly NOT a security sandbox, so a capability one organ holds is one
 * any organ's code can reach. `loom.self.thread/reweave/returnTo` no longer
 * touch the protected orchestration at all — they dispatch a
 * `loom-body-request` (bodyGate.ts) and wait. This component is the only thing
 * that answers, and the only thing that calls `threadLoom`,
 * `startReweave` and `returnToGeneration` on an organ's behalf.
 *
 * It renders the SAME consent card the Companion uses, plus a quiet line
 * naming the organ that asked, and the line itself is composed from chrome's
 * own reading of the body (`kernel_identity` + `swapSupported`) — never from
 * anything the organ sent. The organ can ask; only the owner decides.
 *
 * One card at a time: a second request while one is open is refused with the
 * calm busy line rather than stacking, so a misbehaving organ cannot bury the
 * screen in cards.
 */

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import ConsentCard, { type ConsentKind } from "./ConsentCard";
import LoomGlyph from "./LoomGlyph";
import { kernelIdentity, threadLoom, type Identity } from "../../lib/core";
import { startReweave, swapSupported } from "../../lib/loom/reweave";
import { returnToGeneration } from "../../lib/loom/generations";
import {
  BODY_REQUEST_EVENT,
  LINE_BUSY,
  LINE_DECLINED,
  answerBodyRequest,
  claimBodyRequest,
  type BodyRequest as Request,
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
): string {
  const mode = identity?.mode ?? "dev";
  if (req.kind === "thread") return LINE_THREAD_CONSENT;
  if (req.kind === "return") return returnConsentLine(req.sha ?? "", mode, canSwap);
  return reweaveConsentLine(identity?.genomeSha ?? "", mode, canSwap);
}

/** `"notes asked"` — the owner always knows who is asking. */
export function askedBy(organId: string): string {
  return `${organId} asked`;
}

export type BodyRequestProps = {
  /** Who this binary is — defaults to `kernelIdentity`; unreachable reads as dev. */
  identity?: () => Promise<Identity>;
  /** The three acts, injectable so tests need no shell. */
  acts?: {
    thread: () => Promise<void>;
    reweave: () => Promise<{ ok: boolean; reason?: string }>;
    returnTo: (sha: string) => Promise<void>;
  };
  /** Platform seam — defaults to the webview's own agent. */
  canSwap?: () => boolean;
};

const DEFAULT_ACTS = {
  thread: () => threadLoom(),
  reweave: () => startReweave(),
  returnTo: (sha: string) => returnToGeneration(sha),
};

export default function BodyRequest({
  identity = kernelIdentity,
  acts = DEFAULT_ACTS,
  canSwap = swapSupported,
}: BodyRequestProps) {
  const rm = useReducedMotion() ?? false;
  const [req, setReq] = useState<Request | null>(null);
  const [id, setId] = useState<Identity | null>(null);
  const [busy, setBusy] = useState(false);
  // The open request, readable synchronously — a second `loom-body-request`
  // arrives in the same tick and must be refused, not queued behind stale state.
  const open = useRef<Request | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const got = await identity();
        if (live && got && (got.mode === "dev" || got.mode === "packaged")) setId(got);
      } catch {
        // no shell — the dev framing stands, and nothing can be swapped anyway.
      }
    })();
    return () => {
      live = false;
    };
  }, [identity]);

  useEffect(() => {
    function onRequest(ev: Event) {
      const detail = (ev as CustomEvent<Request>).detail;
      if (!detail || typeof detail.id !== "string") return;
      if (!(detail.kind === "thread" || detail.kind === "reweave" || detail.kind === "return")) return;
      // Claim first, synchronously — an unclaimed request is refused by the
      // gate with "there is no shell to ask", which would be a lie here.
      if (!claimBodyRequest(detail.id)) return;
      if (open.current) {
        answerBodyRequest(detail.id, { ok: false, reason: LINE_BUSY });
        return;
      }
      open.current = detail;
      setReq(detail);
      setBusy(false);
    }
    window.addEventListener(BODY_REQUEST_EVENT, onRequest);
    return () => window.removeEventListener(BODY_REQUEST_EVENT, onRequest);
  }, []);

  function close() {
    open.current = null;
    setReq(null);
    setBusy(false);
  }

  function choose(confirmed: boolean) {
    const current = open.current;
    if (!current || busy) return;
    if (!confirmed) {
      answerBodyRequest(current.id, { ok: false, reason: LINE_DECLINED, declined: true });
      close();
      return;
    }
    setBusy(true);
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
            line={requestLine(req, id, canSwap())}
            note={askedBy(req.organId)}
            settled={null}
            onChoose={choose}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
