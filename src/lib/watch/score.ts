/**
 * score.ts — The Salience Engine
 *
 * "Not a black box: you can see and edit *why* it thinks something matters."
 * Pure function — no I/O, no side effects. Ported faithfully from AgentZeus
 * src/lib/watch/score.ts and adapted to LOOM types.
 *
 * Every factor appends a human-readable reason string so the cockpit can always
 * show the full breakdown. Phase 8 graduates this heuristic to a local model
 * trained on signals these events generate — but the contract
 * (event + watchlist + engagement → {score, reasons}) stays identical.
 */

import type { WatchEvent, ScoredEvent } from "./types";
import { tokenize, type LearnedWeights } from "./learned";

export interface WatchlistEntry {
  kind: "entity" | "topic" | "place" | "source";
  value: string;
}

/** Baseline trust per source — how much attention a source earns by default. */
const SOURCE_BASE: Record<string, number> = {
  auspex: 0.42, // AUSPEX typed events (disasters, launches) — globe-worthy by nature
  quakes: 0.3,
  world: 0.28,
};

/**
 * Category nudges — some domains are intrinsically louder than others.
 * Keeps a seismic category for USGS quakes in addition to AUSPEX categories.
 */
const CATEGORY_WEIGHT: Record<string, number> = {
  // AUSPEX story categories
  military: 0.18,
  finance: 0.12,
  geo: 0.1,
  climate: 0.12,
  tech: 0.1,
  // AUSPEX typed event categories
  launch: 0.2,
  space: 0.16,
  cyclone: 0.2,
  volcano: 0.2,
  fire: 0.18,
  flood: 0.15,
  drought: 0.12,
  earthquake: 0.06,
  disaster: 0.16,
  medical: 0.15,
  physics: 0.12,
  science: 0.12,
  outage: 0.4,
  // USGS quake sensor — separate from AUSPEX earthquake category
  seismic: 0.08,
  "seismic-major": 0.35, // mag >= 6.0
};

const HOUR = 3_600_000;

/** Recency decay: full credit < 1h, tapering to ~0 by ~1 week. */
function recencyBoost(publishedAt: string): { boost: number; label: string } {
  const ageMs = Date.now() - new Date(publishedAt).getTime();
  const ageH = ageMs / HOUR;
  if (ageH < 0) return { boost: 0.25, label: "scheduled ahead" };
  if (ageH < 1) return { boost: 0.25, label: "breaking (<1h)" };
  if (ageH < 6) return { boost: 0.18, label: "recent (<6h)" };
  if (ageH < 24) return { boost: 0.1, label: "today" };
  if (ageH < 72) return { boost: 0.04, label: "this week" };
  return { boost: 0, label: "" };
}

function norm(s: string): string {
  return s.toLowerCase().trim();
}

/**
 * Net engagement per source/category, derived from past open/act/dismiss
 * signals. Keyed `source:<id>` and `category:<cat>`, valued roughly in [-1, 1].
 * This is the v1 "learns from you" factor — fully transparent (it adds a spoken
 * reason), not the black-box model (that's Phase 8).
 */
export type EngagementMap = Record<string, number>;

/**
 * learnedBoost — applies the user's learned weight table to an event.
 * Sums: category weight + source weight + top-3 |weight| matched title tokens.
 * Emits a reason for each contribution with |w| >= 0.02.
 */
export function learnedBoost(
  event: WatchEvent,
  weights: LearnedWeights
): { boost: number; reasons: string[] } {
  const reasons: string[] = [];
  let boost = 0;

  // Category contribution
  if (event.category) {
    const w = weights.category[event.category] ?? 0;
    if (Math.abs(w) >= 0.02) {
      boost += w;
      const sign = w >= 0 ? `+${w.toFixed(2)}` : w.toFixed(2);
      const verb = w >= 0 ? "often open" : "tend to dismiss";
      reasons.push(`learned: you ${verb} ${event.category} stories (${sign})`);
    }
  }

  // Source contribution
  {
    const w = weights.source[event.source] ?? 0;
    if (Math.abs(w) >= 0.02) {
      boost += w;
      const sign = w >= 0 ? `+${w.toFixed(2)}` : w.toFixed(2);
      const verb = w >= 0 ? "favor" : "avoid";
      reasons.push(`learned: you ${verb} ${event.source} (${sign})`);
    }
  }

  // Token contributions — top 3 by |weight|
  if (weights.token && Object.keys(weights.token).length > 0) {
    const titleToks = new Set(tokenize(event.title ?? "", 50));
    const matched = Object.entries(weights.token)
      .filter(([tok]) => titleToks.has(tok))
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .slice(0, 3);
    for (const [tok, w] of matched) {
      if (Math.abs(w) >= 0.02) {
        boost += w;
        const sign = w >= 0 ? `+${w.toFixed(2)}` : w.toFixed(2);
        const verb = w >= 0 ? "draws you" : "you avoid";
        reasons.push(`learned: "${tok}" ${verb} (${sign})`);
      }
    }
  }

  return { boost, reasons };
}

/**
 * Score a single WatchEvent against the user's watchlist and engagement history.
 * Returns a ScoredEvent with a score in [0, 1] and human-readable reason strings.
 *
 * PURE FUNCTION — no I/O, no random, same input → same output.
 */
export function scoreEvent(
  event: WatchEvent,
  watchlist: WatchlistEntry[] = [],
  engagement: EngagementMap = {},
  learnedWeights?: LearnedWeights
): ScoredEvent {
  const reasons: string[] = [];
  let score = 0;

  // 1. Source trust — baseline relevance per source type.
  const base = SOURCE_BASE[event.source] ?? 0.25;
  score += base;
  reasons.push(`base relevance ${base.toFixed(2)}`);

  // 2. Category weight — intrinsic loudness of the domain.
  if (event.category && CATEGORY_WEIGHT[event.category] != null) {
    score += CATEGORY_WEIGHT[event.category];
    reasons.push(`category "${event.category}" +${CATEGORY_WEIGHT[event.category].toFixed(2)}`);
  }

  // 3. Recency decay — fresh events earn more attention.
  const { boost: recencyScore, label: recencyLabel } = recencyBoost(event.publishedAt);
  if (recencyScore > 0) {
    score += recencyScore;
    reasons.push(`${recencyLabel} +${recencyScore.toFixed(2)}`);
  }

  // 3b. Intrinsic importance — quake magnitude drives a bonus bump.
  if (event.magnitude != null && event.magnitude > 0) {
    // Normalise magnitude: mag 4.5 → 0.0 bonus, mag 8.0 → 0.5 bonus (capped).
    const normalised = Math.max(0, Math.min(1, (event.magnitude - 4.0) / 7.0));
    const bump = 0.25 * normalised;
    if (bump > 0.01) {
      score += bump;
      reasons.push(`M${event.magnitude.toFixed(1)} magnitude +${bump.toFixed(2)}`);
    }
  }

  // 4. Watchlist match — the strongest, most personal signal.
  const haystack = norm(
    [event.title, event.summary].filter(Boolean).join(" • ")
  );
  let matchCount = 0;
  for (const entry of watchlist) {
    const term = norm(entry.value);
    if (!term) continue;
    let hit = false;
    if (entry.kind === "place") {
      // Places match against title/summary (we don't have a separate place field in WatchEvent)
      hit = haystack.includes(term);
    } else if (entry.kind === "source") {
      hit = norm(event.source) === term || norm(event.category ?? "") === term;
    } else {
      // entity or topic — search the full haystack
      hit = haystack.includes(term);
    }
    if (hit) {
      const bump = 0.3;
      score += bump;
      matchCount++;
      reasons.push(`watchlist "${entry.value}" +${bump.toFixed(2)}`);
    }
  }
  if (matchCount > 1) reasons.push(`${matchCount} watchlist hits`);

  // 5. Engagement — what you've historically acted on vs dismissed.
  const applyEngagement = (key: string, label: string) => {
    const e = engagement[key];
    if (e == null || Math.abs(e) < 0.05) return;
    const bump = 0.15 * Math.max(-1, Math.min(1, e));
    score += bump;
    const verb = bump >= 0 ? "act on" : "dismiss";
    reasons.push(`you usually ${verb} ${label} ${bump >= 0 ? "+" : ""}${bump.toFixed(2)}`);
  };
  applyEngagement(`source:${event.source}`, event.source);
  if (event.category) applyEngagement(`category:${event.category}`, event.category);

  // 6. Learned weights — transparent per-feature weights from engagement signals
  if (learnedWeights) {
    const lb = learnedBoost(event, learnedWeights);
    score += lb.boost;
    reasons.push(...lb.reasons);
  }

  return { ...event, score: Math.max(0, Math.min(1, score)), reasons };
}

/**
 * Fold raw engagement signals into a net engagement map.
 * act/open are positive intent; dismiss is negative.
 * The ratio is squashed to [-1, 1] and damped by volume so
 * a single click doesn't swing the model.
 */
export function buildEngagementMap(
  signals: { eventKey: string; action: "open" | "dismiss" | "act"; ts: number }[],
  allEvents?: WatchEvent[]
): EngagementMap {
  // Build a lookup from eventKey → {source, category}
  const lookup: Record<string, { source: string; category: string | undefined }> = {};
  for (const e of allEvents ?? []) {
    lookup[e.id] = { source: e.source, category: e.category };
  }

  const tally: Record<string, { pos: number; neg: number }> = {};
  const bump = (key: string | null | undefined, positive: boolean) => {
    if (!key) return;
    (tally[key] ??= { pos: 0, neg: 0 });
    if (positive) tally[key].pos++;
    else tally[key].neg++;
  };

  for (const s of signals) {
    const positive = s.action === "act" || s.action === "open";
    const negative = s.action === "dismiss";
    if (!positive && !negative) continue;
    const meta = lookup[s.eventKey];
    if (meta) {
      bump(`source:${meta.source}`, positive);
      if (meta.category) bump(`category:${meta.category}`, positive);
    }
  }

  const out: EngagementMap = {};
  for (const [k, { pos, neg }] of Object.entries(tally)) {
    const total = pos + neg;
    if (total < 3) continue; // need a little evidence before nudging
    const ratio = (pos - neg) / total; // -1..1
    const damp = Math.min(1, total / 10); // ramp up confidence with volume
    out[k] = ratio * damp;
  }
  return out;
}
