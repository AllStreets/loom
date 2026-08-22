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
  | { type: "set_spin"; on: boolean }
  | { type: "fly_to"; lat: number; lng: number; altitude?: number };

export type DeckCommandResult = {
  /** deck switch that must fire BEFORE bridge cmds (only set when needed) */
  deckSwitch?: "globe" | "void" | "terminal" | "ember" | "agora";
  /** bridge commands to post into the AUSPEX iframe (may be empty) */
  bridgeCmds: BridgeCmd[];
  /** short confirmation line for the companion to speak ("Globe up.", etc.) */
  confirmation: string;
};

// ── Patterns ────────────────────────────────────────────────────────────────

// Deck show: "show the globe", "open the world", "show map", etc.
const DECK_SHOW_RE =
  /\b(show|open)\b.{0,20}?\b(globe|world|map)\b/i;

// Terminal show: "show the terminal", "show the tape", "show (the) markets", etc.
// NOTE: category-adjective phrases like "show financial markets" must NOT reach this
// regex. The classifier checks CAT_RE first (priority fix); by the time this runs the
// utterance is known not to match a category filter.
const TERMINAL_SHOW_RE =
  /\b(show|open)\b.{0,20}?\b(terminal|markets|market|the tape|tape)\b/i;

// Terminal hide: "hide the terminal", "close markets", "close the tape".
const TERMINAL_HIDE_RE =
  /\b(hide|close)\b.{0,20}?\b(terminal|markets|market|tape)\b/i;

// Deck hide: "hide the globe", "back to void", "close the world", etc.
const DECK_HIDE_RE =
  /\b(hide|close)\b.{0,20}?\b(globe|world|map)\b|back to (the )?void/i;

// Ember show: "show ember", "show survival", "the failsafe", "open the failsafe"
// The bare "failsafe" / "the failsafe" trigger without a show/open verb (wake-word style).
const EMBER_SHOW_RE =
  /(?:\b(show|open)\b.{0,20}?\b(ember|survival|failsafe)\b)|\bthe failsafe\b/i;

// AGORA show: "show agora", "open agora", "show the exchange", "open the floor"
const AGORA_SHOW_RE =
  /(?:\b(show|open)\b.{0,20}?\b(agora|the exchange|exchange)\b)|\bopen the floor\b/i;

// Category filter: "show military news", "show geopolitical", "switch to finance", etc.
// The "all" token requires a news-context word to avoid false positives like
// "show all my notes" (M1 fix: without the guard, "show all" would match set_cat all).
const CAT_RE =
  /\b(show|filter|switch to|switch|display)\b.{0,25}?\b(military|geopolitical|geo|finance|financial|climate|tech|technology)\b|\b(show|filter|switch to|switch|display)\b.{0,40}?\b(all)\b.{0,30}?\b(news|coverage|categories)\b/i;

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
  // Group 2 = named-category branch; group 4 = "all" (news-context branch).
  const raw = (m[2] ?? m[4]).toLowerCase();
  return CAT_MAP[raw] ?? null;
}

// ── Confirmation text ────────────────────────────────────────────────────────

export const CAT_LABELS: Record<string, string> = {
  military: "military",
  geo: "geopolitical",
  finance: "finance",
  climate: "climate",
  tech: "tech",
  all: "all",
};

// ── Phrase table (data for the shuttle catalog) ──────────────────────────────
// One row per deck voice command, phrased so every phrase and alias matches the
// classifier regexes above. The shuttle catalog derives its DECKS group from
// this table — catalog.test.ts asserts each row still classifies, so the
// phrases and the patterns cannot drift apart. Category-filter commands are
// derived separately from CAT_LABELS ("show <label> news").

export type DeckCommandMeta = {
  id: string;
  /** canonical utterance — dispatched verbatim through the voice path */
  phrase: string;
  aliases: string[];
  /** short palette description (mirrors the spoken confirmation) */
  hint: string;
};

export const DECK_COMMAND_META: readonly DeckCommandMeta[] = [
  { id: "deck-globe-show", phrase: "show the globe", aliases: ["open the world", "show the map"], hint: "globe up" },
  { id: "deck-globe-hide", phrase: "hide the globe", aliases: ["back to the void", "close the world"], hint: "back to the void" },
  { id: "deck-terminal-show", phrase: "show the terminal", aliases: ["show the tape", "open the markets"], hint: "the tape is live" },
  { id: "deck-terminal-hide", phrase: "hide the terminal", aliases: ["close the tape"], hint: "back to the void" },
  { id: "deck-ember-show", phrase: "show ember", aliases: ["the failsafe", "show survival"], hint: "failsafe up" },
  { id: "deck-agora-show", phrase: "show agora", aliases: ["open the exchange", "open the floor"], hint: "the exchange is live" },
  { id: "globe-vessels", phrase: "show vessels", aliases: ["show ships", "toggle vessels"], hint: "live AIS ships overlay" },
  { id: "globe-spin-start", phrase: "start spinning", aliases: ["start rotation"], hint: "spin the globe" },
  { id: "globe-spin-stop", phrase: "stop spinning", aliases: ["stop rotation"], hint: "stop the globe" },
  { id: "globe-reset", phrase: "reset the view", aliases: ["reset the globe", "reset the camera"], hint: "reset the camera" },
];

// ── Main classifier ──────────────────────────────────────────────────────────

/**
 * Classify a (normalized, lowercased) utterance into a DeckCommandResult.
 *
 * @param utterance  — the utterance to classify (already normalized)
 * @param currentDeck — current cockpit.deck value ("void" | "globe" | "terminal" | "ember" | "agora")
 * @returns DeckCommandResult if utterance matches a deck command; null otherwise.
 *
 * Globe-only commands ("show vessels", category filters, spin, reset) when
 * currentDeck is not "globe" (i.e. "void" or "terminal") will include
 * deckSwitch:"globe" so the shell shows the globe BEFORE applying the bridge
 * command (spec requirement 4 — auto-switch must fire from any non-globe deck).
 *
 * Precedence (highest → lowest):
 *   1. Category filter (CAT_RE) — "show financial markets" → set_cat finance.
 *      Must precede TERMINAL_SHOW_RE so category-adjective phrases are not
 *      swallowed by the generic markets token in TERMINAL_SHOW_RE.
 *   2. Deck show/hide (DECK_SHOW_RE / DECK_HIDE_RE)
 *   3. Terminal show/hide (TERMINAL_SHOW_RE / TERMINAL_HIDE_RE)
 *   4. Vessels, spin, reset
 */
export function classifyDeckCommand(
  utterance: string,
  currentDeck: "void" | "globe" | "terminal" | "ember" | "agora"
): DeckCommandResult | null {
  // 1. Category filter — highest priority so "show financial markets" routes to
  //    set_cat, NOT to the terminal deck. Globe-only: auto-switch from any non-globe deck.
  const cat = extractCat(utterance);
  if (cat !== null) {
    const result: DeckCommandResult = {
      bridgeCmds: [{ type: "set_cat", cat }],
      confirmation: `Filtering: ${CAT_LABELS[cat] ?? cat}.`,
    };
    if (currentDeck !== "globe") result.deckSwitch = "globe";
    return result;
  }

  // 2. Deck show / hide
  if (DECK_SHOW_RE.test(utterance)) {
    return {
      deckSwitch: "globe",
      bridgeCmds: [],
      confirmation: "Globe up.",
    };
  }

  if (DECK_HIDE_RE.test(utterance)) {
    return {
      deckSwitch: "void",
      bridgeCmds: [],
      confirmation: "Back to the void.",
    };
  }

  // 3. Terminal show / hide — "show markets"/"show the tape" reaches here only
  //    after failing the category-filter check above.
  if (TERMINAL_SHOW_RE.test(utterance)) {
    return {
      deckSwitch: "terminal",
      bridgeCmds: [],
      confirmation: "The tape is live.",
    };
  }

  if (TERMINAL_HIDE_RE.test(utterance)) {
    return {
      deckSwitch: "void",
      bridgeCmds: [],
      confirmation: "Back to the void.",
    };
  }

  // 3.5. Ember show: "show ember", "show survival", "the failsafe"
  if (EMBER_SHOW_RE.test(utterance)) {
    return {
      deckSwitch: "ember",
      bridgeCmds: [],
      confirmation: "Failsafe up.",
    };
  }

  // 3.6. AGORA show: "show agora", "open agora", "show the exchange", "open the floor"
  if (AGORA_SHOW_RE.test(utterance)) {
    return {
      deckSwitch: "agora",
      bridgeCmds: [],
      confirmation: "The exchange is live.",
    };
  }

  // 4. Globe-only overlay / motion commands — auto-switch from any non-globe deck.

  // Vessels overlay
  if (VESSELS_RE.test(utterance)) {
    const result: DeckCommandResult = {
      bridgeCmds: [{ type: "toggle_overlay", overlay: "vessels" }],
      confirmation: "Vessels overlay toggled.",
    };
    if (currentDeck !== "globe") result.deckSwitch = "globe";
    return result;
  }

  // Spin start
  if (SPIN_START_RE.test(utterance)) {
    const result: DeckCommandResult = {
      bridgeCmds: [{ type: "set_spin", on: true }],
      confirmation: "Spinning.",
    };
    if (currentDeck !== "globe") result.deckSwitch = "globe";
    return result;
  }

  // Spin stop
  if (SPIN_STOP_RE.test(utterance)) {
    const result: DeckCommandResult = {
      bridgeCmds: [{ type: "set_spin", on: false }],
      confirmation: "Rotation stopped.",
    };
    if (currentDeck !== "globe") result.deckSwitch = "globe";
    return result;
  }

  // Reset view
  if (RESET_RE.test(utterance)) {
    const result: DeckCommandResult = {
      bridgeCmds: [{ type: "reset_view" }],
      confirmation: "View reset.",
    };
    if (currentDeck !== "globe") result.deckSwitch = "globe";
    return result;
  }

  return null;
}
