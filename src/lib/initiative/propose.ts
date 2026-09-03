/**
 * propose.ts — the rules engine (pure, deterministic, the heart)
 *
 * LOOM only proposes an organ when concrete observed behaviour crosses a hard
 * threshold. Below the threshold, `proposeFromObservation` returns null — and
 * NULL IS THE COMMON, CORRECT CASE. Silence is the default. Every proposal
 * quotes the real counts it fired on, in LOOM's calm lowercase voice.
 *
 * The engine never calls a model. Detection is deterministic and exhaustively
 * tested; only the downstream build (the normal pipeline) may use inference —
 * exactly as a typed request would.
 *
 * Rebirth: the Cockpit archetypes (price-alert, topic-digest, the watch-fed
 * morning brief) are gone with the surfaces that earned them. One archetype
 * remains, rooted in evidence LOOM itself produces: a morning habit plus a
 * weave with history to read.
 */

import type { UsageLedger } from "./observe";

const RATE_LIMIT_MS = 24 * 3600 * 1000; // at most one idea per day

// ── Gates (hard minimums — below these, silence) ─────────────────────────────

const MORNING_BRIEF_MORNINGS = 3; // distinct morning days, running
const MORNING_BRIEF_MIN_ORGANS = 1; // there must be a weave to read about

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Proposal {
  /** STABLE per archetype (+ param) — the never-list key. */
  id: string;
  archetype: "morning-brief";
  title: string;
  /** Evidence in plain LOOM voice, quoting real observed counts. */
  rationale: string;
  /** The synthetic build sentence fed to the normal pipeline. */
  request: string;
  /** The powers the built organ will ask for (shown up front). */
  powers: string[];
}

export interface OrganRef {
  id: string;
  title: string;
}

export interface ProposeInputs {
  ledger: UsageLedger;
  organs: OrganRef[];
  neverList: string[];
  lastProposalTs: number;
  now: number;
  enabled: boolean;
}

// A firing rule carries its proposal plus the evidence magnitude used to rank
// competing rules (higher = stronger earned evidence).
interface Candidate {
  proposal: Proposal;
  evidence: number;
}

// ── The engine ────────────────────────────────────────────────────────────────

/**
 * Evaluate all archetype rules against the observation. Returns the single
 * highest-evidence proposal, or null when nothing is earned, the setting is
 * off, or the 24h rate-limit has not elapsed.
 */
export function proposeFromObservation(inputs: ProposeInputs): Proposal | null {
  const { enabled, now, lastProposalTs } = inputs;

  // Governance short-circuits — cheapest first.
  if (!enabled) return null;
  if (now - lastProposalTs < RATE_LIMIT_MS) return null;

  // Gather every firing rule.
  const candidates: Candidate[] = [];
  const mb = ruleMorningBrief(inputs);
  if (mb) candidates.push(mb);

  // Exclude never-listed ids and already-installed organs.
  const eligible = candidates.filter(
    (c) => !inputs.neverList.includes(c.proposal.id) && !organExists(c.proposal, inputs.organs)
  );

  if (eligible.length === 0) return null;

  // Highest evidence wins; ties broken by a stable archetype order.
  eligible.sort((a, b) => b.evidence - a.evidence || a.proposal.id.localeCompare(b.proposal.id));
  return eligible[0].proposal;
}

// ── Existing-organ match ──────────────────────────────────────────────────────

/**
 * True when an installed organ looks like this proposal's target — matched by
 * a loose token overlap of the proposal's title against organ titles/ids.
 */
function organExists(p: Proposal, organs: OrganRef[]): boolean {
  const needle = matchKey(p);
  return organs.some((o) => {
    const hay = `${o.id} ${o.title}`.toLowerCase();
    return needle.every((tok) => hay.includes(tok));
  });
}

/** The tokens that must all appear in an installed organ for it to count as "this one". */
function matchKey(p: Proposal): string[] {
  switch (p.archetype) {
    case "morning-brief":
      return ["morning", "brief"];
  }
}

// ── morning-brief ─────────────────────────────────────────────────────────────

function ruleMorningBrief(inputs: ProposeInputs): Candidate | null {
  const { ledger, organs } = inputs;
  const mornings = ledger.morningActivity;
  const organCount = organs.length;

  // A brief that reads aloud what changed in the weave is worthless — and
  // dishonest to propose — when there is no weave yet. This is the load-bearing
  // "buildable and worth having" guard.
  if (organCount < MORNING_BRIEF_MIN_ORGANS) return null;
  if (mornings < MORNING_BRIEF_MORNINGS) return null;

  const organWord = organCount === 1 ? "organ" : "organs";
  const rationale =
    `you've been here ${mornings} mornings running, and the weave holds ${organCount} ${organWord}. ` +
    `i could read aloud what changed in the weave each morning.`;

  return {
    evidence: mornings * 3,
    proposal: {
      id: "morning-brief",
      archetype: "morning-brief",
      title: "a morning brief",
      rationale,
      request:
        "Build a morning-brief organ that each morning reads aloud the three most recent commits in my timeline.",
      powers: ["pulse", "timeline", "voice"],
    },
  };
}
