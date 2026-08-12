/**
 * Normalize a user utterance before rule or model classification.
 *
 * Operations (in order):
 * 1. Strip zero-width / invisible characters.
 * 2. Collapse all whitespace runs (space, tab, newline, etc.) to a single space.
 * 3. Trim leading/trailing whitespace.
 * 4. Apply Unicode NFC normalization.
 */
export function normalize(s: string): string {
  // Zero-width space U+200B, zero-width non-joiner U+200C, zero-width joiner U+200D,
  // BOM / zero-width no-break space U+FEFF, soft hyphen U+00AD.
  const stripped = s.replace(/[​‌‍﻿­]/g, "");
  const collapsed = stripped.replace(/\s+/g, " ").trim();
  return collapsed.normalize("NFC");
}
