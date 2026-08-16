import { normalize } from "./normalize";

export type Intent = "build_organ" | "edit_organ" | "act_on_organ" | "converse";

export type IntentResult = {
  intent: Intent;
  confidence: number;
  organId?: string;
  source: "rules" | "model";
};

export type HistoryMsg = { role: string; content: string };

const VALID_INTENTS = new Set<string>([
  "build_organ",
  "edit_organ",
  "act_on_organ",
  "converse",
]);

// Verbs that signal an intent to modify an existing organ.
const EDIT_VERB_RE =
  /\b(add|change|make|remove|fix|update|rename|set|edit)\b/;

// Phrases that signal intent to create a new organ.
const BUILD_PHRASE_RE =
  /\b(build|create|make me|new organ|i want a|i need a)\b/;

// Greeting words / thanks.
const GREETING_RE = /^(hi|hey|hello|thanks)\b/;

// Anaphora pronouns that refer back to a previously-named organ.
const ANAPHORA_RE = /\b(it|that|this one|the last one)\b/;

// Pattern to extract an organ id mentioned in a history message.
// Looks for "Built <id>:", "Edited <id>:" patterns written by Companion.
const HISTORY_ORGAN_RE = /\b(?:built|edited)\s+([\w-]+)\s*:/i;

/**
 * Return the normalized form(s) that an organ id appears as in utterances.
 * e.g. "water-tracker" → ["water-tracker", "water tracker"]
 */
function organVariants(id: string): string[] {
  const variants = [id];
  const withSpaces = id.replace(/-/g, " ");
  if (withSpaces !== id) variants.push(withSpaces);
  return variants;
}

/**
 * Check whether a normalized utterance mentions any of the given organ ids.
 * Returns the first matched organ id, or null.
 */
function findMentionedOrgan(
  utteranceLower: string,
  organIds: string[]
): string | null {
  for (const id of organIds) {
    for (const variant of organVariants(id)) {
      if (utteranceLower.includes(variant)) return id;
    }
  }
  return null;
}

/**
 * Scan history (most recent first) for the last assistant message that
 * names an organ via "Built <id>:" or "Edited <id>:" patterns.
 * Returns the organ id string, or null.
 */
function resolveOrganFromHistory(history: HistoryMsg[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role !== "assistant") continue;
    const m = HISTORY_ORGAN_RE.exec(msg.content);
    if (m) return m[1];
  }
  return null;
}

/**
 * Pure, transparent rule-based classifier.
 *
 * Precedence (highest → lowest):
 *   0. build_organ  — BUILD_PHRASE_RE wins even when an organ substring appears (misfire fix)
 *   1. edit_organ   — anaphora + history organ resolve                    (0.9)
 *   2. edit_organ   — organ mention + edit verb                           (0.9)
 *   3. build_organ  — build phrase + NO organ mention                     (0.85)
 *   4. act_on_organ — organ mentioned, no edit verb                       (0.7)
 *   5. converse     — greeting or bare question                           (0.8)
 *   6. null         — rules cannot decide
 */
export function classifyByRules(
  utterance: string,
  organIds: string[],
  history: HistoryMsg[] = []
): IntentResult | null {
  const normed = normalize(utterance);
  const lower = normed.toLowerCase();

  const hasBuildPhrase = BUILD_PHRASE_RE.test(lower);
  const hasEditVerb = EDIT_VERB_RE.test(lower);
  const hasAnaphora = ANAPHORA_RE.test(lower);

  // 0. BUILD_PHRASE takes priority — even if an organ substring appears in the
  //    utterance (e.g. "make me something like notes but for tasks" where
  //    "notes" matches a "notes" organ id). This fixes the misfire where
  //    EDIT_VERB "make" + organ-substring beats BUILD_PHRASE "make me".
  if (hasBuildPhrase && !hasAnaphora) {
    return { intent: "build_organ", confidence: 0.85, source: "rules" };
  }

  // 1. Anaphora resolution — utterance contains a pronoun ("it", "that", etc.)
  //    and an edit verb. Try to resolve the target from history before model.
  if (hasAnaphora && hasEditVerb) {
    const historyOrgan = resolveOrganFromHistory(history);
    if (historyOrgan !== null) {
      return {
        intent: "edit_organ",
        confidence: 0.9,
        organId: historyOrgan,
        source: "rules",
      };
    }
    // Anaphora with edit verb but no history resolution — fall through to model
    return null;
  }

  const mentionedOrgan = findMentionedOrgan(lower, organIds);

  // 2. edit_organ — organ must be mentioned and an edit verb must be present.
  if (mentionedOrgan !== null && hasEditVerb) {
    return {
      intent: "edit_organ",
      confidence: 0.9,
      organId: mentionedOrgan,
      source: "rules",
    };
  }

  // 3. build_organ — build phrase present AND no existing organ mentioned.
  //    (anaphora-free path already handled at step 0 above)
  if (hasBuildPhrase && mentionedOrgan === null) {
    return { intent: "build_organ", confidence: 0.85, source: "rules" };
  }

  // 4. act_on_organ — organ mentioned but no edit verb.
  if (mentionedOrgan !== null) {
    return {
      intent: "act_on_organ",
      confidence: 0.7,
      organId: mentionedOrgan,
      source: "rules",
    };
  }

  // 5. converse — greeting word or question (no organ, no build phrase).
  const isGreeting = GREETING_RE.test(lower);
  const isQuestion = lower.endsWith("?") && !hasBuildPhrase;
  if (isGreeting || isQuestion) {
    return { intent: "converse", confidence: 0.8, source: "rules" };
  }

  // 6. Rules unsure.
  return null;
}

const FEW_SHOT_SYSTEM = `You are an intent classifier for a voice assistant. Classify utterances into exactly one of: build_organ, edit_organ, act_on_organ, converse.

Examples:
User: "build me a sleep tracker" -> {"intent":"build_organ","organId":null}
User: "make me something like notes but for tasks" -> {"intent":"build_organ","organId":null}
User: "add a delete button to the water tracker" -> {"intent":"edit_organ","organId":"water-tracker"}
User: "make it dark mode" (after assistant: "Built water-tracker: ...") -> {"intent":"edit_organ","organId":"water-tracker"}
User: "open the budget tool" -> {"intent":"act_on_organ","organId":"budget-tool"}
User: "what can you do?" -> {"intent":"converse","organId":null}

Reply with a single line of JSON and nothing else: {"intent":"<value>","organId":null}
If an organ id is known from context, put it in organId; otherwise null.`;

/**
 * Format history into a compact block for the model user message.
 * Truncates each turn to 160 chars.
 */
function formatHistoryBlock(history: HistoryMsg[]): string {
  if (history.length === 0) return "";
  const lines = history.map(
    (m) =>
      `${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 160)}`
  );
  return "\n\nRecent conversation:\n" + lines.join("\n");
}

/**
 * Classify intent using rules first; fall back to the provided askModel
 * function when rules return null.
 *
 * The askModel function is injected so it can be mocked in tests with no
 * network calls required.
 *
 * history (optional) — last few turns, used for anaphora resolution and
 * included in the model fallback prompt for context.
 */
export async function classifyIntent(
  utterance: string,
  organIds: string[],
  askModel: (system: string, prompt: string) => Promise<string>,
  history: HistoryMsg[] = []
): Promise<IntentResult> {
  const rulesResult = classifyByRules(utterance, organIds, history);
  if (rulesResult !== null) return rulesResult;

  const historyBlock = formatHistoryBlock(history);
  const userMessage = `${historyBlock}\n\nUtterance: ${utterance}`;
  const reply = await askModel(FEW_SHOT_SYSTEM, userMessage);

  // Tolerant parse: find first {...} substring in the reply.
  const match = reply.match(/\{[^}]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as Record<string, unknown>;
      const intent = parsed.intent as string | undefined;
      if (typeof intent === "string" && VALID_INTENTS.has(intent)) {
        const result: IntentResult = {
          intent: intent as Intent,
          confidence: 0.6,
          source: "model",
        };
        if (
          typeof parsed.organId === "string" &&
          parsed.organId.length > 0
        ) {
          result.organId = parsed.organId;
        }
        return result;
      }
    } catch {
      // fall through to converse default
    }
  }

  return { intent: "converse", confidence: 0.3, source: "model" };
}
