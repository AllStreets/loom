/**
 * recoveryNotice.tsx — the calm "an edit didn't hold" card.
 *
 * PROTECTED: lives under the `src/components/chrome/recovery` prefix Task 1
 * carved out of the editable whitelist — LOOM cannot edit its own recovery UI.
 *
 * A one-shot glass card, lower-center (same non-blocking language as the
 * Proposal card), shown when boot recovery rolled a broken self-edit back.
 * Listens on RECOVERY_EVENT (dispatched by recovery.ts's runBootCheck). BRAND
 * voice, honest, present-not-insistent: the owner dismisses it.
 */

import { useEffect, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import LoomGlyph from "./LoomGlyph";
import { IconX } from "./icons";
import { RECOVERY_EVENT, type RecoveryDetail } from "../../lib/loom/recovery";

/** z 1550 — above the notices stack (1500), below the permission modal (2000). */
const RECOVERY_Z = 1550;

/**
 * The hinge of the sentence, chosen by what the warden actually saw.
 *
 * Rust distinguishes a body that died from one that was still running when the
 * clock ran out — the second is usually a boundaried error that vetoed the
 * confirmation, not a crash — and the notice used to flatten both into "and
 * couldn't", so the reason crossed the whole boundary and died at the last
 * inch. Any reason it does not recognise reads as the general case rather than
 * inventing a story.
 */
function whyItFailed(reason: string): string {
  if (reason.startsWith("crashed")) return " and it stopped — it came home to ";
  if (reason.includes("still running")) return " and couldn't say it was well — it came home to ";
  return " and couldn't — it came home to ";
}

export default function RecoveryNotice() {
  const rm = useReducedMotion() ?? false;
  const [notice, setNotice] = useState<RecoveryDetail | null>(null);

  useEffect(() => {
    function onRecovered(ev: Event) {
      const detail = (ev as CustomEvent<RecoveryDetail>).detail;
      // A failed rollback carries no sha — there is no home to name. It is the
      // one notice the owner most needs, so it must not be dropped for want of
      // the thing that is missing precisely because it failed.
      if (!detail || (!detail.sha && !detail.failed)) return;
      // Only one at a time — a live card ignores further events.
      setNotice((prev) => prev ?? detail);
    }
    window.addEventListener(RECOVERY_EVENT, onRecovered);
    return () => window.removeEventListener(RECOVERY_EVENT, onRecovered);
  }, []);

  const sha7 = notice ? notice.sha.slice(0, 7) : "";
  // Phase 23: the warden put the previous body back. The sentence names both
  // shas — the one that couldn't be born and the one LOOM came home to.
  const gen = notice?.generation;
  const failed7 = gen ? gen.failedSha.slice(0, 7) : "";
  const prev7 = gen ? gen.prevSha.slice(0, 7) : sha7;

  return (
    <AnimatePresence>
      {notice && (
        <motion.div
          data-testid="recovery-notice"
          initial={rm ? false : { opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={rm ? undefined : { opacity: 0, y: 16 }}
          transition={rm ? {} : { type: "spring", stiffness: 320, damping: 30 }}
          style={{
            position: "fixed",
            bottom: 96,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: RECOVERY_Z,
            width: 380,
            maxWidth: "calc(100vw - 48px)",
            background: "var(--glass)",
            backdropFilter: "blur(var(--blur))",
            WebkitBackdropFilter: "blur(var(--blur))",
            border: "1px solid var(--glass-border)",
            borderRadius: 14,
            padding: "16px 18px",
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
          }}
        >
          <LoomGlyph size={18} style={{ flexShrink: 0, marginTop: 2 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontFamily: "var(--f-mono)",
                fontSize: 10,
                letterSpacing: ".1em",
                textTransform: "uppercase",
                color: "var(--t3)",
                marginBottom: 6,
              }}
            >
              {notice?.failed ? "couldn't come home" : "came home"}
            </div>
            <div
              data-testid="recovery-body"
              style={{ fontSize: 13, color: "var(--t1)", lineHeight: 1.5 }}
            >
              {notice?.failed ? (
                <>
                  {"LOOM tried to come home and couldn't — it is still running "}
                  {"the body that failed. Return to a kept generation from "}
                  {"Settings, or reinstall from a build you trust."}
                </>
              ) : gen ? (
                <>
                  {"LOOM tried to become "}
                  <span style={{ fontFamily: "var(--f-mono)", color: "var(--t2)" }}>{failed7}</span>
                  {whyItFailed(gen.reason)}
                  <span
                    data-testid="recovery-sha"
                    style={{ fontFamily: "var(--f-mono)", color: "var(--accent)" }}
                  >
                    {prev7}
                  </span>
                  {". The failed weave is kept under generations."}
                </>
              ) : (
                <>
                  {"an edit didn't hold — LOOM came home to "}
                  <span
                    data-testid="recovery-sha"
                    style={{ fontFamily: "var(--f-mono)", color: "var(--accent)" }}
                  >
                    {sha7}
                  </span>
                  .
                </>
              )}
            </div>
          </div>
          <button
            data-testid="recovery-dismiss"
            title="dismiss"
            onClick={() => setNotice(null)}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "var(--t3)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 18,
              height: 18,
              borderRadius: 3,
              padding: 0,
              flexShrink: 0,
            }}
          >
            <IconX size={11} />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
