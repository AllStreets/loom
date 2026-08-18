/**
 * commands.ts — phrase → bridge-command map for globe deck voice control.
 *
 * Pure function: no side-effects, no I/O. Takes a normalized utterance and
 * the current deck state; returns the commands to dispatch.
 *
 * AUSPEX category ids (verbatim from public/decks/auspex/js/config.js CATS):
 *   all | geo | military | finance | climate | tech
 *
 * AUSPEX bridge verbs (verbatim from public/decks/auspex/js/main.js executeCmd):
 *   set_cat        { cat: string }
 *   toggle_overlay { overlay: string }  — "vessels" for live AIS ships
 *   reset_view     {}
 *   set_spin       { on: boolean }
 */

export type BridgeCmd =
  | { type: "set_cat"; cat: string }
  | { type: "toggle_overlay"; overlay: string }
  | { type: "reset_view" }
  | { type: "set_spin"; on: boolean };

export type DeckCommandResult = {
  /** deck switch that must fire BEFORE bridge cmds (only set when needed) */
  deckSwitch?: "globe" | "void";
  /** bridge commands to post into the AUSPEX iframe (may be empty) */
  bridgeCmds: BridgeCmd[];
  /** short confirmation line for the companion to speak ("Globe up.", etc.) */
  confirmation: string;
};

// ── Patterns ────────────────────────────────────────────────────────────────

// Deck show: "show the globe", "open the world", "show map", etc.
const DECK_SHOW_RE =
  /\b(show|open)\b.{0,20}?\b(globe|world|map)\b/i;

// Deck hide: "hide the globe", "back to void", "close the world", etc.
const DECK_HIDE_RE =
  /\b(hide|close)\b.{0,20}?\b(globe|world|map)\b|back to (the )?void/i;

// Category filter: "show military news", "show geopolitical", "switch to finance", etc.
const CAT_RE =
  /\b(show|filter|switch to|switch|display)\b.{0,25}?\b(military|geopolitical|geo|finance|financial|climate|tech|technology|all)\b/i;

// Vessels / ships overlay toggle
const VESSELS_RE =
  /\b(show|toggle)\b.{0,15}?\b(vessels|ships)\b/i;

// Spin: "start spinning", "stop rotation", etc.
const SPIN_START_RE = /\bstart\b.{0,15}?\b(spinning|rotation|spin)\b/i;
const SPIN_STOP_RE = /\bstop\b.{0,15}?\b(spinning|rotation|spin)\b/i;

// Reset view
const RESET_RE = /\breset\b.{0,20}?\b(view|globe|camera)\b/i;

// ── Category id mapping ──────────────────────────────────────────────────────

const CAT_MAP: Record<string, string> = {
  military: "military",
  geopolitical: "geo",
  geo: "geo",
  finance: "finance",
  financial: "finance",
  climate: "climate",
  tech: "tech",
  technology: "tech",
  all: "all",
};

function extractCat(utterance: string): string | null {
  const m = CAT_RE.exec(utterance);
  if (!m) return null;
  const raw = m[2].toLowerCase();
  return CAT_MAP[raw] ?? null;
}

// ── Confirmation text ────────────────────────────────────────────────────────

const CAT_LABELS: Record<string, string> = {
  military: "military",
  geo: "geopolitical",
  finance: "finance",
  climate: "climate",
  tech: "tech",
  all: "all",
};

// ── Main classifier ──────────────────────────────────────────────────────────

/**
 * Classify a (normalized, lowercased) utterance into a DeckCommandResult.
 *
 * @param utterance  — the utterance to classify (already normalized)
 * @param currentDeck — current cockpit.deck value ("void" | "globe")
 * @returns DeckCommandResult if utterance matches a deck command; null otherwise.
 *
 * Globe-only commands ("show vessels", category filters, spin, reset) when
 * currentDeck is "void" will include deckSwitch:"globe" so the shell shows
 * the globe BEFORE applying the bridge command (spec requirement 4).
 */
export function classifyDeckCommand(
  utterance: string,
  currentDeck: "void" | "globe"
): DeckCommandResult | null {
  // Deck show
  if (DECK_SHOW_RE.test(utterance)) {
    return {
      deckSwitch: "globe",
      bridgeCmds: [],
      confirmation: "Globe up.",
    };
  }

  // Deck hide
  if (DECK_HIDE_RE.test(utterance)) {
    return {
      deckSwitch: "void",
      bridgeCmds: [],
      confirmation: "Back to the void.",
    };
  }

  // Category filter — globe-only (auto-switch if in void)
  const cat = extractCat(utterance);
  if (cat !== null) {
    const result: DeckCommandResult = {
      bridgeCmds: [{ type: "set_cat", cat }],
      confirmation: `Filtering: ${CAT_LABELS[cat] ?? cat}.`,
    };
    if (currentDeck === "void") result.deckSwitch = "globe";
    return result;
  }

  // Vessels overlay — globe-only
  if (VESSELS_RE.test(utterance)) {
    const result: DeckCommandResult = {
      bridgeCmds: [{ type: "toggle_overlay", overlay: "vessels" }],
      confirmation: "Vessels overlay toggled.",
    };
    if (currentDeck === "void") result.deckSwitch = "globe";
    return result;
  }

  // Spin start — globe-only
  if (SPIN_START_RE.test(utterance)) {
    const result: DeckCommandResult = {
      bridgeCmds: [{ type: "set_spin", on: true }],
      confirmation: "Spinning.",
    };
    if (currentDeck === "void") result.deckSwitch = "globe";
    return result;
  }

  // Spin stop — globe-only
  if (SPIN_STOP_RE.test(utterance)) {
    const result: DeckCommandResult = {
      bridgeCmds: [{ type: "set_spin", on: false }],
      confirmation: "Rotation stopped.",
    };
    if (currentDeck === "void") result.deckSwitch = "globe";
    return result;
  }

  // Reset view — globe-only
  if (RESET_RE.test(utterance)) {
    const result: DeckCommandResult = {
      bridgeCmds: [{ type: "reset_view" }],
      confirmation: "View reset.",
    };
    if (currentDeck === "void") result.deckSwitch = "globe";
    return result;
  }

  return null;
}
