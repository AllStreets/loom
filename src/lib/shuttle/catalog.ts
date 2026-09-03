/**
 * catalog.ts — THE SHUTTLE's command catalog.
 *
 * The shuttle is the part of a loom that carries the weft through the warp —
 * here, the piece that carries the owner's intent through the machine. This
 * module is the single source of truth for every command LOOM understands:
 * the Cmd+K palette and voice discoverability ("what can you do") both read
 * it, so the sayable and the typeable cannot drift apart.
 *
 * Nothing here is invented: every entry is DERIVED from a real capability —
 *   build  → the build_organ intent ("build me a …" template)
 *   organs → the live organ list ("open <organ>" via act_on_organ)
 *   system → the settings organ + HELP_PHRASES
 *
 * Execution is NOT wired here — entries carry a canonical phrase that the
 * palette dispatches through the exact same `loom-utterance` seam voice
 * transcripts take. Pure data + pure functions; no side effects, no I/O.
 */

import { HELP_PHRASES, SELF_EDIT_PHRASES } from "../compiler/intent";

// ── Types ────────────────────────────────────────────────────────────────────

export type CatalogGroup = "build" | "organs" | "system";

export type CatalogEntry = {
  id: string;
  /** canonical phrase — dispatched verbatim through the voice utterance seam */
  phrase: string;
  aliases: string[];
  /** short palette description */
  hint: string;
  group: CatalogGroup;
  /**
   * "utterance" executes the phrase immediately; "template" pre-fills the
   * palette input with the phrase (minus the trailing ellipsis) so the owner
   * completes it — the completed text then executes as an utterance.
   */
  kind: "utterance" | "template";
};

export type CatalogCtx = {
  /** live organ list (id + human title) — omitted → no organs group */
  organs?: { id: string; title: string }[];
};

/** Palette + help ordering. Groups render contiguously in this order. */
export const GROUP_ORDER: readonly CatalogGroup[] = [
  "build",
  "organs",
  "system",
];

// ── Catalog derivation ───────────────────────────────────────────────────────

function buildEntries(): CatalogEntry[] {
  return [
    {
      id: "build-organ",
      phrase: "build me a …",
      aliases: ["create", "make me a …", "i want a …"],
      hint: "describe a capability — LOOM weaves the organ",
      group: "build",
      kind: "template",
    },
  ];
}

function organEntries(ctx: CatalogCtx): CatalogEntry[] {
  const organs = ctx.organs ?? [];
  return organs
    .filter((o) => o.id !== "settings") // settings lives in the system group
    .map((o) => {
      // The phrase is derived from the id (dashes → spaces) because that is
      // exactly what the intent rules resolve (organVariants in intent.ts).
      const spoken = o.id.replace(/-/g, " ");
      const aliases = [o.id];
      if (o.title && o.title.toLowerCase() !== spoken) aliases.push(o.title);
      return {
        id: `organ-open-${o.id}`,
        phrase: `open ${spoken}`,
        aliases,
        hint: o.title && o.title.toLowerCase() !== spoken ? o.title : "open this organ",
        group: "organs" as const,
        kind: "utterance" as const,
      };
    });
}

function systemEntries(ctx: CatalogCtx): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  // Settings organ — only advertised when it actually exists (seed-installed);
  // without an organs context the phrase cannot route (findMentionedOrgan
  // matches against real organ ids), so it is not advertised.
  const hasSettings = (ctx.organs ?? []).some((o) => o.id === "settings");
  if (hasSettings) {
    entries.push({
      id: "system-settings",
      phrase: "open settings",
      aliases: ["settings"],
      hint: "voice, models",
      group: "system",
      kind: "utterance",
    });
  }
  const [helpCanonical, ...helpAliases] = HELP_PHRASES;
  entries.push({
    id: "system-help",
    phrase: helpCanonical,
    aliases: [...helpAliases],
    hint: "LOOM speaks its command grammar",
    group: "system",
    kind: "utterance",
  });
  // Self-edit — the deliberate, weightier act. A TEMPLATE (not immediate): the
  // owner completes "change yourself: …" so nothing self-modifies on a stray
  // click. Derived from SELF_EDIT_PHRASES so the sayable and typeable can't
  // drift from the classifier.
  const [selfCanonical, ...selfAliases] = SELF_EDIT_PHRASES;
  entries.push({
    id: "system-self-edit",
    phrase: `${selfCanonical}: …`,
    aliases: [...selfAliases],
    hint: "LOOM edits its own kernel — dev mode, behind the walls",
    group: "system",
    kind: "template",
  });
  return entries;
}

/**
 * Build the full catalog from live context. Deterministic: same ctx → same
 * entries in the same order (GROUP_ORDER, then derivation order).
 */
export function buildCatalog(ctx: CatalogCtx = {}): CatalogEntry[] {
  return [
    ...buildEntries(),
    ...organEntries(ctx),
    ...systemEntries(ctx),
  ];
}

// ── Fuzzy filter ─────────────────────────────────────────────────────────────

/**
 * Score one candidate string against a normalized query.
 * exact (100) > prefix (90) > word-prefix (70) > subsequence (40) > none (0).
 */
function scoreText(q: string, text: string): number {
  const t = text.toLowerCase();
  if (t === q) return 100;
  if (t.startsWith(q)) return 90;
  const words = t.split(/\s+/);
  const qWords = q.split(/\s+/);
  if (qWords.every((w) => words.some((tw) => tw.startsWith(w)))) return 70;
  // subsequence over the raw query (spaces included must appear in order)
  let i = 0;
  for (const ch of t) {
    if (ch === q[i]) i++;
    if (i === q.length) break;
  }
  if (i === q.length) return 40;
  return 0;
}

function scoreEntry(q: string, e: CatalogEntry): number {
  let best = scoreText(q, e.phrase);
  for (const a of e.aliases) {
    const s = scoreText(q, a);
    // alias matches rank a hair under the same-quality phrase match so the
    // canonical phrase wins ties, but an exact alias still beats a phrase
    // subsequence.
    if (s - 1 > best) best = s - 1;
  }
  return best;
}

/**
 * Pure fuzzy filter over catalog entries.
 * - empty/whitespace query → all entries, catalog order
 * - matches phrase and aliases (case-insensitive)
 * - result is group-preserving (GROUP_ORDER) and stable: within a group,
 *   higher scores first, ties keep catalog order
 */
export function fuzzyFilter(query: string, entries: CatalogEntry[]): CatalogEntry[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...entries];
  const scored = entries
    .map((e, i) => ({ e, i, s: scoreEntry(q, e) }))
    .filter((x) => x.s > 0);
  scored.sort((a, b) => {
    const ga = GROUP_ORDER.indexOf(a.e.group);
    const gb = GROUP_ORDER.indexOf(b.e.group);
    if (ga !== gb) return ga - gb;
    if (a.s !== b.s) return b.s - a.s;
    return a.i - b.i;
  });
  return scored.map((x) => x.e);
}

// ── Voice discoverability ────────────────────────────────────────────────────

/**
 * Spoken help line generated FROM the catalog — group names plus up to two
 * example phrases per group. No model call; pure string assembly.
 */
export function helpText(entries: CatalogEntry[]): string {
  const parts: string[] = [];
  for (const g of GROUP_ORDER) {
    const examples = entries
      .filter((e) => e.group === g)
      .slice(0, 2)
      .map((e) => `"${e.phrase}"`);
    if (examples.length === 0) continue;
    parts.push(`${g} — ${examples.join(", ")}`);
  }
  return `I understand ${parts.length} groups of commands. ${parts.join(". ")}. Anything else you type or say goes to the companion.`;
}
