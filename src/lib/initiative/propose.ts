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
 */

import type { UsageLedger } from "./observe";
import type { LearnedWeights } from "../watch/learned";
import type { EngagementSignal } from "../watch/store";

const RATE_LIMIT_MS = 24 * 3600 * 1000; // at most one idea per day

// ── Gates (hard minimums — below these, silence) ─────────────────────────────

const MORNING_BRIEF_WATCH_OPENS = 5; // path A: watch opens
const MORNING_BRIEF_BRIEF_SIGNALS = 3; // path A: brief/watch utterances
const MORNING_BRIEF_MORNINGS = 3; // path B: distinct morning days
const PRICE_ALERT_FLOOR_OPENS = 4; // floor opens on one product
const TOPIC_DIGEST_ACT_SIGNALS = 4; // "act" signals in one category

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Proposal {
  /** STABLE per archetype (+ param) — the never-list key. */
  id: string;
  archetype: "morning-brief" | "price-alert" | "topic-digest";
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
  signals: EngagementSignal[];
  weights: LearnedWeights;
  organs: OrganRef[];
  /**
   * How many entries are in the actual watch watchlist right now. morning-brief
   * only proposes to read items aloud when there ARE items — an empty watchlist
   * means the built organ would read nothing, so it must not fire.
   */
  watchlistCount: number;
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
  const pa = rulePriceAlert(inputs);
  candidates.push(...pa);
  const td = ruleTopicDigest(inputs);
  if (td) candidates.push(td);

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
 * a loose token overlap of the proposal's title/param against organ titles/ids.
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
    case "price-alert": {
      const product = p.id.split(":")[1]?.toLowerCase() ?? "";
      return [product, "alert"];
    }
    case "morning-brief":
      return ["morning", "brief"];
    case "topic-digest": {
      const cat = p.id.split(":")[1]?.toLowerCase() ?? "";
      return [cat, "digest"];
    }
  }
}

// ── morning-brief ─────────────────────────────────────────────────────────────

function ruleMorningBrief(inputs: ProposeInputs): Candidate | null {
  const { ledger, watchlistCount } = inputs;
  const watchOpens = ledger.watchOpens;
  const feedSignals = (ledger.commands.brief ?? 0) + (ledger.commands.watch ?? 0);

  // Either path requires an actual non-empty watchlist — an organ that reads
  // "your top items aloud" is worthless (and dishonest to propose) with nothing
  // on the watch. This is the load-bearing "buildable and worth having" guard.
  if (watchlistCount <= 0) return null;

  // Path A: heavy watch use AND explicit asks about the feed.
  const pathA = watchOpens >= MORNING_BRIEF_WATCH_OPENS && feedSignals >= MORNING_BRIEF_BRIEF_SIGNALS;
  // Path B: a morning habit (the watchlist gate above already applies).
  const pathB = ledger.morningActivity >= MORNING_BRIEF_MORNINGS;

  if (!pathA && !pathB) return null;

  // feedSignals combines "brief me" and watch/news asks — the rationale says so
  // honestly rather than claiming they were all briefing requests.
  const rationale = pathA
    ? `you opened the watch ${watchOpens} times and asked about your feed ${feedSignals} times, and you keep ${watchlistCount} on the watch. i could read your top items aloud each morning.`
    : `you've been active ${ledger.morningActivity} mornings running, and you keep ${watchlistCount} on the watch. i could read your top items aloud each morning.`;

  const evidence = pathA ? watchOpens + feedSignals : ledger.morningActivity * 3;

  return {
    evidence,
    proposal: {
      id: "morning-brief",
      archetype: "morning-brief",
      title: "a morning brief",
      rationale,
      request:
        "Build a morning-brief organ that each morning reads my top three watch items aloud.",
      powers: ["pulse", "watch", "voice"],
    },
  };
}

// ── price-alert ──────────────────────────────────────────────────────────────

function rulePriceAlert(inputs: ProposeInputs): Candidate[] {
  const out: Candidate[] = [];
  for (const [product, count] of Object.entries(inputs.ledger.floorOpens)) {
    if (count < PRICE_ALERT_FLOOR_OPENS) continue;
    out.push({
      evidence: count,
      proposal: {
        id: `price-alert:${product}`,
        archetype: "price-alert",
        title: `a ${product} price alert`,
        rationale: `you opened the ${product} floor ${count} times. i could notify you when it moves more than 3% in an hour.`,
        request: `Build a price-alert organ that notifies me when ${product} moves more than 3% in an hour.`,
        powers: ["pulse", "market", "notify"],
      },
    });
  }
  return out;
}

// ── topic-digest ──────────────────────────────────────────────────────────────

function ruleTopicDigest(inputs: ProposeInputs): Candidate | null {
  // Count "act" signals per category.
  const acts: Record<string, number> = {};
  for (const s of inputs.signals) {
    if (s.action === "act" && s.category) acts[s.category] = (acts[s.category] ?? 0) + 1;
  }

  let best: { category: string; count: number } | null = null;
  for (const [category, count] of Object.entries(acts)) {
    if (count < TOPIC_DIGEST_ACT_SIGNALS) continue;
    // Require a net-positive learned weight on the category — the engagement
    // must be genuine interest, not churn.
    const weight = inputs.weights.category[category] ?? 0;
    if (weight <= 0) continue;
    if (!best || count > best.count) best = { category, count };
  }

  if (!best) return null;

  const { category, count } = best;
  return {
    evidence: count,
    proposal: {
      id: `topic-digest:${category}`,
      archetype: "topic-digest",
      title: `a ${category} digest`,
      rationale: `you acted on ${count} ${category} stories. i could notify you when a top ${category} story crosses the watch.`,
      request: `Build a digest organ that notifies me when a top ${category} story crosses the watch.`,
      powers: ["pulse", "watch", "notify"],
    },
  };
}

