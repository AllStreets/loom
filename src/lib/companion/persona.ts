import type { Msg } from "../core";

/**
 * The system persona for LOOM's companion voice.
 */
export const COMPANION_SYSTEM: string =
  "You are LOOM — a sovereign, offline companion the user owns and runs entirely on their own hardware. " +
  "You hold context across conversations and care about getting things right. " +
  "Be warm, precise, and brief: one short paragraph is enough unless the user asks for more detail. " +
  "Never identify yourself as an artificial intelligence or disclaim your nature. Never use emojis. " +
  "You can build new organs and edit existing ones when asked — mention that only when it is relevant. " +
  "You may reference organs you built or edited earlier in this session.";

/**
 * Return a windowed slice of the conversation history suitable for sending to a model.
 *
 * If history[0] is a system message it is preserved at the front, then the last
 * `max` non-system messages are appended.  This keeps the persona in place
 * regardless of how long the conversation has grown.
 */
export function windowMessages(history: Msg[], max = 16): Msg[] {
  if (history.length === 0) return [];

  const hasLeadingSystem = history[0].role === "system";
  const systemHead = hasLeadingSystem ? [history[0]] : [];
  const rest = hasLeadingSystem ? history.slice(1) : history;

  const windowed = rest.slice(-max);
  return [...systemHead, ...windowed];
}
