/**
 * Proposal.tsx — the initiative surface (calm, non-blocking, consensual)
 *
 * This is NOT a screen-blocking modal — that is the permission card's job,
 * later in the flow (Desktop.tsx, z 2000). This is a single glass card carrying
 * the woven glyph, docked lower-center, that floats one earned idea and offers
 * three choices in LOOM's voice: weave it / not now / never.
 *
 * LOOM proposed; you still approve powers before anything runs. "weave it"
 * dispatches the proposal's `request` through the SAME `loom-utterance` seam a
 * typed build uses (Companion consumes {text, spoken, initiative} and runs
 * buildOrgan) — no parallel build entry. The organ then goes through the
 * normal gate + permission card unchanged.
 *
 * Governance: at most one card at a time. The first-ever proposal (governance
 * store's neverList empty AND lastProposalTs 0) carries one extra calm line
 * introducing what this is and that it can be silenced in Settings.
 */

import { useEffect, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import LoomGlyph from "./LoomGlyph";
import { POWER_LABELS, type Power } from "../../lib/loom/validate";
import type { Proposal as ProposalType } from "../../lib/initiative/propose";
import { getInitiativeState, markProposed, addNever } from "../../lib/initiative/store";

/**
 * z-index: 1600 — above the notices stack (1500) so a floated idea is not
 * buried under toasts, and BELOW the permission modal (2000) which is the only
 * surface allowed to block the screen. The proposal invites; it never traps.
 */
const PROPOSAL_Z = 1600;

/** Render a plain-language powers line from POWER_LABELS, joined with · dots. */
function powersLine(powers: string[]): string {
  const labels = powers.map((p) => POWER_LABELS[p as Power] ?? p);
  return `it will ask to: ${labels.join(" · ")}`;
}

export default function Proposal() {
  const rm = useReducedMotion() ?? false;
  const [proposal, setProposal] = useState<ProposalType | null>(null);
  // Whether THIS is the first idea LOOM has ever floated — captured when the
  // card opens (before markProposed writes), so the intro line is honest.
  const [firstEver, setFirstEver] = useState(false);

  useEffect(() => {
    function onProposal(ev: Event) {
      const detail = (ev as CustomEvent<{ proposal?: ProposalType }>).detail;
      const p = detail?.proposal;
      if (!p || typeof p.id !== "string" || typeof p.title !== "string") return;
      // Only ONE card at a time — a live card ignores further proposals.
      setProposal((prev) => {
        if (prev) return prev;
        const gov = getInitiativeState();
        setFirstEver(gov.neverList.length === 0 && gov.lastProposalTs === 0);
        return p;
      });
    }
    window.addEventListener("loom-proposal", onProposal);
    return () => window.removeEventListener("loom-proposal", onProposal);
  }, []);

  function close() {
    setProposal(null);
    setFirstEver(false);
    // Tell the runtime a card is no longer live so the next earned idea (after
    // the 24h quiet window markProposed just wrote) can surface.
    window.dispatchEvent(new CustomEvent("loom-proposal-closed"));
  }

  function weaveIt() {
    if (!proposal) return;
    // The exact seam a typed build uses — Companion reads {text} and runs the
    // normal plan/build/gate/permission flow. `initiative: true` threads the
    // proposalSource through to the experience record.
    window.dispatchEvent(
      new CustomEvent("loom-utterance", {
        detail: { text: proposal.request, spoken: false, initiative: true },
      }),
    );
    markProposed(Date.now());
    close();
  }

  function notNow() {
    // 24h quiet — the archetype may return later, but not today.
    markProposed(Date.now());
    close();
  }

  function never() {
    if (!proposal) return;
    // Tombstone this archetype's id forever, and start the quiet window.
    addNever(proposal.id);
    markProposed(Date.now());
    close();
  }

  return (
    <AnimatePresence>
      {proposal && (
        <motion.div
          data-testid="proposal-card"
          initial={rm ? false : { opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={rm ? undefined : { opacity: 0, y: 16 }}
          transition={rm ? {} : { type: "spring", stiffness: 320, damping: 30 }}
          style={{
            position: "fixed",
            // Lower-center — clear of the bottom dock (z 1000, ~bottom 16) and
            // the minimized-chat pill; present without blocking the console.
            bottom: 96,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: PROPOSAL_Z,
            width: 360,
            maxWidth: "calc(100vw - 48px)",
            background: "var(--glass)",
            backdropFilter: "blur(var(--blur))",
            WebkitBackdropFilter: "blur(var(--blur))",
            border: "1px solid var(--glass-border)",
            borderRadius: 14,
            padding: "16px 18px",
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          {/* Header — the woven glyph + a quiet eyebrow */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <LoomGlyph size={16} />
            <span
              style={{
                fontFamily: "var(--f-mono)",
                fontSize: 10,
                letterSpacing: ".1em",
                textTransform: "uppercase",
                color: "var(--t3)",
              }}
            >
              an idea
            </span>
          </div>

          {/* First-ever intro — one calm line explaining what this is + silence path */}
          {firstEver && (
            <div
              data-testid="proposal-intro"
              style={{ fontSize: 12, color: "var(--t3)", lineHeight: 1.5 }}
            >
              i noticed a pattern and thought i could help. i only suggest things
              i can build from what you actually do — you can silence this any time
              in Settings.
            </div>
          )}

          {/* Title */}
          <div
            data-testid="proposal-title"
            style={{ fontSize: 15, fontWeight: 700, color: "var(--t1)" }}
          >
            {proposal.title}
          </div>

          {/* Rationale — the real evidence, in plain voice. Rendered as text
              (React escapes it), never as HTML — the honest defense against a
              crafted rationale. */}
          <div
            data-testid="proposal-rationale"
            style={{ fontSize: 13, color: "var(--t2)", lineHeight: 1.5, overflowWrap: "break-word" }}
          >
            {proposal.rationale}
          </div>

          {/* Powers — what the built organ will ask for, up front */}
          <div
            data-testid="proposal-powers"
            style={{
              fontFamily: "var(--f-mono)",
              fontSize: 11,
              color: "var(--t3)",
              lineHeight: 1.5,
              overflowWrap: "break-word",
            }}
          >
            {powersLine(proposal.powers)}
          </div>

          {/* Actions — BRAND voice, lowercase */}
          <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
            <button
              data-testid="proposal-weave"
              onClick={weaveIt}
              style={{
                background: "var(--accent)",
                color: "#04222b",
                border: "none",
                borderRadius: 6,
                padding: "7px 16px",
                fontWeight: 700,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              weave it
            </button>
            <button
              data-testid="proposal-not-now"
              onClick={notNow}
              style={{
                background: "rgba(255,255,255,.06)",
                color: "var(--t2)",
                border: "1px solid var(--glass-border)",
                borderRadius: 6,
                padding: "7px 16px",
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              not now
            </button>
            <button
              data-testid="proposal-never"
              onClick={never}
              style={{
                background: "none",
                color: "var(--t3)",
                border: "none",
                borderRadius: 6,
                padding: "7px 12px",
                fontSize: 13,
                cursor: "pointer",
                marginLeft: "auto",
              }}
            >
              never
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
