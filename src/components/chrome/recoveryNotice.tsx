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

export default function RecoveryNotice() {
  const rm = useReducedMotion() ?? false;
  const [sha, setSha] = useState<string | null>(null);

  useEffect(() => {
    function onRecovered(ev: Event) {
      const detail = (ev as CustomEvent<RecoveryDetail>).detail;
      if (!detail?.sha) return;
      // Only one at a time — a live card ignores further events.
      setSha((prev) => prev ?? detail.sha);
    }
    window.addEventListener(RECOVERY_EVENT, onRecovered);
    return () => window.removeEventListener(RECOVERY_EVENT, onRecovered);
  }, []);

  const sha7 = sha ? sha.slice(0, 7) : "";

  return (
    <AnimatePresence>
      {sha && (
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
              came home
            </div>
            <div style={{ fontSize: 13, color: "var(--t1)", lineHeight: 1.5 }}>
              an edit didn't hold — LOOM came home to{" "}
              <span
                data-testid="recovery-sha"
                style={{ fontFamily: "var(--f-mono)", color: "var(--accent)" }}
              >
                {sha7}
              </span>
              .
            </div>
          </div>
          <button
            data-testid="recovery-dismiss"
            title="dismiss"
            onClick={() => setSha(null)}
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
