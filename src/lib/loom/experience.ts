// src/lib/loom/experience.ts

export type BuildRecord = {
  ts: number;
  kind: "build" | "edit";
  request: string;
  organId: string;
  ok: boolean;
  stage?: string;
  repairRounds: number;
  manifest?: string;
  code?: string;
  tests?: string;
  failedTests?: string[];
  errors?: string[];
  /** Legacy (pre-Rebirth) records may carry a `brain` field; it is ignored on read. */
  /** Set when the build originated from an unprompted LOOM proposal (Phase 20). */
  proposalSource?: "initiative";
};

const STORE_KEY = "loom.exp.v1";
const MAX_RECORDS = 200;
/** Max bytes for a single record's manifest+code+tests combined. */
const MAX_RECORD_PAYLOAD_BYTES = 16 * 1024; // 16 KB
/** Max bytes for the full serialized store. */
const MAX_STORE_BYTES = 1.5 * 1024 * 1024; // 1.5 MB

function loadRecords(): BuildRecord[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as BuildRecord[];
  } catch {
    return [];
  }
}

/** Trim a single record's payload if manifest+code+tests exceeds MAX_RECORD_PAYLOAD_BYTES. */
function trimRecord(r: BuildRecord): BuildRecord {
  const size = (r.manifest?.length ?? 0) + (r.code?.length ?? 0) + (r.tests?.length ?? 0);
  if (size <= MAX_RECORD_PAYLOAD_BYTES) return r;
  // Drop tests first
  const withoutTests = { ...r, tests: undefined };
  const size2 = (withoutTests.manifest?.length ?? 0) + (withoutTests.code?.length ?? 0);
  if (size2 <= MAX_RECORD_PAYLOAD_BYTES) return withoutTests;
  // Drop code too, keep manifest + metadata
  return { ...withoutTests, code: undefined };
}

function saveRecords(records: BuildRecord[]): void {
  try {
    // Trim oversized individual records
    let trimmed = records.map(trimRecord);
    // Evict oldest until serialized size is under MAX_STORE_BYTES
    while (trimmed.length > 0) {
      const serialized = JSON.stringify(trimmed);
      if (serialized.length <= MAX_STORE_BYTES) break;
      trimmed = trimmed.slice(1); // drop oldest
    }
    localStorage.setItem(STORE_KEY, JSON.stringify(trimmed));
  } catch {
    // swallow storage errors
  }
}

/**
 * Read-only view of the experience log (oldest first).
 * The Tapestry weaves build history from this; storage errors read as empty.
 */
export function listExperience(): BuildRecord[] {
  return loadRecords();
}

export function recordExperience(r: BuildRecord): void {
  try {
    const records = loadRecords();
    records.push(r);
    // evict oldest if over cap
    const capped = records.length > MAX_RECORDS ? records.slice(records.length - MAX_RECORDS) : records;
    saveRecords(capped);
  } catch {
    // swallow all errors
  }
}

// Keyword/bigram overlap scoring
function scoreOverlap(a: string, b: string): number {
  const tokenize = (s: string): string[] =>
    s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const aWords = tokenize(a);
  const bWords = tokenize(b);
  // unigrams
  const aSet = new Set(aWords);
  const bSet = new Set(bWords);
  let score = 0;
  for (const w of aSet) { if (bSet.has(w)) score++; }
  // bigrams
  const bigrams = (words: string[]) => words.slice(0, -1).map((w, i) => w + " " + words[i + 1]);
  const aBigrams = new Set(bigrams(aWords));
  const bBigrams = new Set(bigrams(bWords));
  for (const bg of aBigrams) { if (bBigrams.has(bg)) score += 2; }
  return score;
}

export function retrieveExemplars(request: string, k: number): string {
  try {
    const records = loadRecords().filter((r) => r.ok);
    if (records.length === 0) return "";
    const scored = records
      .map((r) => ({ r, score: scoreOverlap(request, r.request) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
    if (scored.length === 0) return "";
    return scored.map(({ r }) => {
      const rounds = r.repairRounds === 0 ? "0 repair rounds" : `${r.repairRounds} repair round${r.repairRounds === 1 ? "" : "s"}`;
      const parts = [
        `PAST SUCCESSFUL BUILD (request: "${r.request}", passed in ${rounds}):`,
      ];
      if (r.manifest) parts.push(r.manifest);
      if (r.code) parts.push(r.code);
      return parts.join("\n");
    }).join("\n\n");
  } catch {
    return "";
  }
}

export function retrieveLessons(request: string, k: number): string {
  try {
    const records = loadRecords().filter((r) => !r.ok);
    if (records.length === 0) return "";
    const scored = records
      .map((r) => ({ r, score: scoreOverlap(request, r.request) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
    if (scored.length === 0) return "";
    return scored.map(({ r }) => {
      const stage = r.stage ?? "unknown";
      const firstError = r.errors?.[0]?.split("\n")[0] ?? "unknown error";
      return `A similar past build ("${r.request}") failed at stage ${stage} with: ${firstError}. Avoid that failure mode.`;
    }).join("\n");
  } catch {
    return "";
  }
}

export function exportCorpus(): string {
  try {
    const records = loadRecords();
    const lines: string[] = [];
    for (const r of records) {
      if (r.manifest) {
        lines.push(JSON.stringify({ prompt: `manifest: ${r.request}`, completion: r.manifest, verdict: r.ok ? "pass" : "fail" }));
      }
      if (r.code) {
        lines.push(JSON.stringify({ prompt: `code: ${r.request}`, completion: r.code, verdict: r.ok ? "pass" : "fail" }));
      }
      if (r.tests) {
        lines.push(JSON.stringify({ prompt: `tests: ${r.request}`, completion: r.tests, verdict: r.ok ? "pass" : "fail" }));
      }
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}

// Dev-only export hook
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__loomExportCorpus = exportCorpus;
}
