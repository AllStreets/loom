import { normalize } from "./normalize";

export type Intent = "build_organ" | "edit_organ" | "act_on_organ" | "converse";

export type IntentResult = {
  intent: Intent;
  confidence: number;
  organId?: string;
  source: "rules" | "model";
};

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
 * Pure, transparent rule-based classifier.
 *
 * Precedence (highest → lowest):
 *   1. edit_organ   — organ mention + edit verb               (0.9)
 *   2. build_organ  — build phrase + NO organ mention         (0.85)
 *   3. act_on_organ — organ mention, no edit verb             (0.7)
 *   4. converse     — greeting or bare question               (0.8)
 *   5. null         — rules cannot decide
 */
export function classifyByRules(
  utterance: string,
  organIds: string[]
): IntentResult | null {
  const normed = normalize(utterance);
  const lower = normed.toLowerCase();

  const mentionedOrgan = findMentionedOrgan(lower, organIds);
  const hasEditVerb = EDIT_VERB_RE.test(lower);
  const hasBuildPhrase = BUILD_PHRASE_RE.test(lower);

  // 1. edit_organ — organ must be mentioned and an edit verb must be present.
  if (mentionedOrgan !== null && hasEditVerb) {
    return {
      intent: "edit_organ",
      confidence: 0.9,
      organId: mentionedOrgan,
      source: "rules",
    };
  }

  // 2. build_organ — build phrase present AND no existing organ mentioned.
  if (hasBuildPhrase && mentionedOrgan === null) {
    return { intent: "build_organ", confidence: 0.85, source: "rules" };
  }

  // 3. act_on_organ — organ mentioned but no edit verb.
  if (mentionedOrgan !== null) {
    return {
      intent: "act_on_organ",
      confidence: 0.7,
      organId: mentionedOrgan,
      source: "rules",
    };
  }

  // 4. converse — greeting word or question (no organ, no build phrase).
  const isGreeting = GREETING_RE.test(lower);
  const isQuestion = lower.endsWith("?") && !hasBuildPhrase;
  if (isGreeting || isQuestion) {
    return { intent: "converse", confidence: 0.8, source: "rules" };
  }

  // 5. Rules unsure.
  return null;
}

const MODEL_PROMPT_TEMPLATE = `You are an intent classifier for a voice assistant.
Classify the user utterance into exactly one of: build_organ, edit_organ, act_on_organ, converse.
Reply with a single line of JSON and nothing else: {"intent":"<value>","organId":null}
If an organ id is known, put it in organId; otherwise null.

Utterance: `;

/**
 * Classify intent using rules first; fall back to the provided askModel
 * function when rules return null.
 *
 * The askModel function is injected so it can be mocked in tests with no
 * network calls required.
 */
export async function classifyIntent(
  utterance: string,
  organIds: string[],
  askModel: (prompt: string) => Promise<string>
): Promise<IntentResult> {
  const rulesResult = classifyByRules(utterance, organIds);
  if (rulesResult !== null) return rulesResult;

  const prompt = MODEL_PROMPT_TEMPLATE + utterance;
  const reply = await askModel(prompt);

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
