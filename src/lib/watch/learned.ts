/**
 * learned.ts — Transparent local weight table
 *
 * Computes per-feature weights from engagement signals. Stateless + auditable:
 * same signals → same weights. Weights are recomputed each poll (not stored),
 * so the source of truth is always the signal log.
 *
 * Weight update per signal:
 *   open   → +0.05 applied to category, source, each title token
 *   act    → +0.10 applied to category, source, each title token
 *   dismiss → -0.08 applied to category, source, each title token
 *
 * Final table: { category: {[cat]: w}, source: {[src]: w}, token: {[tok]: w} }
 * All weights clamped to [-0.5, +0.5]. Token table capped at 200 by |weight|.
 */

export interface LearnedWeights {
  category: Record<string, number>;
  source: Record<string, number>;
  token: Record<string, number>;
}

const DELTAS: Record<string, number> = { open: 0.05, act: 0.10, dismiss: -0.08 };
const CLAMP = 0.5;
const TOKEN_CAP = 200;

const STOPWORDS = new Set([
  "a","an","the","and","or","but","in","on","at","to","for","of","with","by",
  "from","as","is","was","are","were","be","been","being","have","has","had",
  "do","does","did","not","that","this","it","its","he","she","they","we","you",
  "i","up","out","about","into","than","then","so","if","after","before","over",
  "new","more","will","can","just","also","now","says","said","after","no","s",
]);

/** Tokenize a title into lowercase stopword-filtered unigrams, capped at maxTokens. */
export function tokenize(title: string, maxTokens = 10): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
    .slice(0, maxTokens);
}

function clamp(v: number): number {
  return Math.max(-CLAMP, Math.min(CLAMP, v));
}

/** Apply delta to a key in a record, clamping result. */
function apply(table: Record<string, number>, key: string, delta: number): void {
  table[key] = clamp((table[key] ?? 0) + delta);
}

/** Trim token table to TOKEN_CAP entries by descending |weight|. */
function trimTokenTable(table: Record<string, number>): Record<string, number> {
  const entries = Object.entries(table);
  if (entries.length <= TOKEN_CAP) return table;
  entries.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  return Object.fromEntries(entries.slice(0, TOKEN_CAP));
}

/**
 * Compute the learned weight table from stored engagement signals.
 * Signals without feature snapshots (old format) are skipped gracefully.
 * Pure function: deterministic, no I/O.
 */
export function computeWeights(
  signals: Array<{
    action: "open" | "dismiss" | "act";
    category?: string;
    source?: string;
    titleTokens?: string[];
  }>
): LearnedWeights {
  const category: Record<string, number> = {};
  const source: Record<string, number> = {};
  const token: Record<string, number> = {};

  for (const sig of signals) {
    const delta = DELTAS[sig.action] ?? 0;
    if (delta === 0) continue;
    // Skip signals without any features (old format)
    const hasFeatures = sig.category || sig.source || (sig.titleTokens && sig.titleTokens.length > 0);
    if (!hasFeatures) continue;

    if (sig.category) apply(category, sig.category, delta);
    if (sig.source) apply(source, sig.source, delta);
    if (sig.titleTokens) {
      for (const tok of sig.titleTokens) {
        apply(token, tok, delta);
      }
    }
  }

  return {
    category,
    source,
    token: trimTokenTable(token),
  };
}
