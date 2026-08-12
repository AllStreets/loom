import { normalize } from "./normalize";
import { classifyIntent, type Intent } from "./intent";

export type Compiled = {
  intent: Intent;
  confidence: number;
  source: "rules" | "model";
  organId?: string;
  request: string;
  utterance: string;
};

/**
 * Compile an utterance into an inspectable Compiled object.
 *
 * Steps:
 * 1. Normalize the utterance for classification
 * 2. Classify the intent using rules or model fallback
 * 3. Assemble the result, preserving both normalized request and original utterance
 *
 * @param utterance — The original user utterance (preserved as-is)
 * @param organIds — List of known organ ids for entity matching
 * @param askModel — Injected model function for fallback classification
 * @returns Compiled object with intent, confidence, source, organId (if set), request, and utterance
 */
export async function compile(
  utterance: string,
  organIds: string[],
  askModel: (prompt: string) => Promise<string>
): Promise<Compiled> {
  // 1. Normalize for classification
  const normalized = normalize(utterance);

  // 2. Classify intent (pass normalized string per Task 1 review note)
  const intentResult = await classifyIntent(normalized, organIds, askModel);

  // 3. Assemble result
  const compiled: Compiled = {
    intent: intentResult.intent,
    confidence: intentResult.confidence,
    source: intentResult.source,
    request: normalized,
    utterance: utterance,
  };

  // Only include organId if it was set by the classifier
  if (intentResult.organId !== undefined) {
    compiled.organId = intentResult.organId;
  }

  return compiled;
}
