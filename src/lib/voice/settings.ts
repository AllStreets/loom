/**
 * settings.ts — kernel settings store
 *
 * Single source of truth for all user-editable preferences. Only these keys
 * may be written via loom.settings; localStorage is the backing store so
 * the kernel and organs share the same values without extra IPC.
 *
 * orb.tier side-effect: setting "flat" also writes the legacy key `loom.orb`="flat"
 * (which detectTier reads); setting "auto" removes it.
 */

export const VOICE_IDS = [
  "en_US-lessac-medium",
  "en_GB-alba-medium",
  "en_US-libritts-high",
] as const;

export type VoiceId = (typeof VOICE_IDS)[number];

export const VOICE_LABELS: Record<VoiceId, string> = {
  "en_US-lessac-medium": "Lessac — warm, neutral (US)",
  "en_GB-alba-medium": "Alba — calm (British)",
  "en_US-libritts-high": "LibriTTS — rich (US)",
};

// ── Model tag validation ───────────────────────────────────────────────────────

/**
 * Validate an Ollama model tag.
 * Regex: ^[A-Za-z0-9][A-Za-z0-9._\-\/]*(:[A-Za-z0-9._\-]+)?$, max 128 chars.
 * Empty string is NOT valid here — callers that allow empty must check separately.
 */
export function isValidModelTag(tag: string): boolean {
  if (!tag || tag.length > 128) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._\-\/]*(:[A-Za-z0-9._\-]+)?$/.test(tag);
}

// ── Terminal watchlist validation ─────────────────────────────────────────────

/** One equity/index/future ticker: uppercase, 1–12 chars of A-Z 0-9 . ^ = - */
export const TICKER_RE = /^[A-Z0-9.^=-]{1,12}$/;

/** Rate-friendliness cap — the Terminal fans out one request per symbol. */
export const WATCHLIST_MAX = 24;

/**
 * Validate a candidate `terminal.symbols` value: a comma-joined list of
 * canonical tickers (no whitespace, already uppercased), each matching
 * TICKER_RE, at most WATCHLIST_MAX entries. Empty string = empty watchlist
 * (valid — the movers panel states it honestly).
 */
export function isValidSymbolList(value: string): boolean {
  if (value === "") return true;
  const parts = value.split(",");
  if (parts.length > WATCHLIST_MAX) return false;
  return parts.every((t) => TICKER_RE.test(t));
}

// ── Whitelist ──────────────────────────────────────────────────────────────────

export type SettingsKey =
  | "voice.default"
  | "voice.speakReplies"
  | "orb.tier"
  | "loom.reviewBeforeSave"
  | "model.builder"
  | "model.companion"
  | "model.rewriter"
  | "model.cloudBuilder"
  | "cockpit.deck"
  | "cockpit.interact"
  | "cockpit.tapestry"
  | "cockpit.watchOpen"
  | "cockpit.chatMin"
  | "terminal.symbols";

export const SETTINGS_KEYS: readonly SettingsKey[] = [
  "voice.default",
  "voice.speakReplies",
  "orb.tier",
  "loom.reviewBeforeSave",
  "model.builder",
  "model.companion",
  "model.rewriter",
  "model.cloudBuilder",
  "cockpit.deck",
  "cockpit.interact",
  "cockpit.tapestry",
  "cockpit.watchOpen",
  "cockpit.chatMin",
  "terminal.symbols",
];

// Keys that use free-text model-tag validation instead of enumeration
const MODEL_KEYS = new Set<SettingsKey>(["model.builder", "model.companion", "model.rewriter"]);

// Keys that hold a comma-joined ticker watchlist (isValidSymbolList)
const SYMBOL_LIST_KEYS = new Set<SettingsKey>(["terminal.symbols"]);

// Allowed values for enumerated keys (model.* keys validate via isValidModelTag instead)
const ALLOWED: Partial<Record<SettingsKey, readonly string[]>> = {
  "voice.default": VOICE_IDS,
  "voice.speakReplies": ["always", "whenSpoken", "never"],
  "orb.tier": ["auto", "flat"],
  "loom.reviewBeforeSave": ["0", "1"],
  "model.cloudBuilder": ["off", "anthropic"],
  "cockpit.deck": ["void", "globe", "terminal", "ember"],
  "cockpit.interact": ["on", "off"],
  "cockpit.tapestry": ["on", "off"],
  "cockpit.watchOpen": ["on", "off"],
  "cockpit.chatMin": ["on", "off"],
};

const DEFAULTS: Record<SettingsKey, string> = {
  "voice.default": "en_US-lessac-medium",
  "voice.speakReplies": "whenSpoken",
  "orb.tier": "auto",
  "loom.reviewBeforeSave": "0",
  "model.builder": "",
  "model.companion": "",
  "model.rewriter": "",
  "model.cloudBuilder": "off",
  "cockpit.deck": "void",
  "cockpit.interact": "on",
  // Default ON — the Tapestry is the brand, not decoration.
  "cockpit.tapestry": "on",
  "cockpit.watchOpen": "off",
  // Default OFF — the typing box is present until its owner folds it away.
  "cockpit.chatMin": "off",
  // The Terminal's default tape — the pre-watchlist hardcoded equities list.
  "terminal.symbols": "AAPL,MSFT,NVDA,GOOGL,AMZN,META,TSLA",
};

// Legacy key the orb's detectTier reads
const LEGACY_ORB_KEY = "loom.orb";

// Settings keys that no longer exist. Their stored values are deleted at boot
// by migrateSettings() — same discipline as the organ tombstone list: a removed
// feature must not leave orphaned state behind.
const RETIRED_KEYS: readonly string[] = [
  // Phase 16: the constellation died; the Tapestry (cockpit.tapestry) lives.
  "cockpit.constellation",
  // Phase 18: AGORA left the ship; the floor lives in the Terminal.
  "deck.agora.url",
  "deck.agora.path",
  "deck.agora.product",
];

/**
 * Boot migration: delete stored values for retired settings keys.
 * Idempotent — removing an absent key is a no-op, so this can run every boot.
 * Called from Shell's mount effect.
 */
export function migrateSettings(): void {
  for (const k of RETIRED_KEYS) {
    try {
      localStorage.removeItem(k);
    } catch {
      // storage unavailable — nothing to migrate
    }
  }
  // A retired VALUE can hide under a live key: an owner whose last deck was
  // AGORA still has cockpit.deck="agora" stored. Deleting it falls back to
  // the default ("void") — removing an absent key stays a no-op (idempotent).
  try {
    if (localStorage.getItem("cockpit.deck") === "agora") {
      localStorage.removeItem("cockpit.deck");
    }
  } catch {
    // storage unavailable — nothing to migrate
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Read a setting. Returns the default if never set.
 * Throws if key is not in the whitelist.
 */
export function getSetting(key: string): string {
  if (!SETTINGS_KEYS.includes(key as SettingsKey)) {
    throw new Error(`Unknown settings key: "${key}"`);
  }
  const k = key as SettingsKey;
  return localStorage.getItem(k) ?? DEFAULTS[k];
}

/**
 * Write a setting. Validates key and value; throws on either being unknown/invalid.
 * The orb.tier key has a legacy side-effect (see module docblock).
 * model.* keys accept any valid Ollama model tag or empty string (= unset).
 */
export function setSetting(key: string, value: string): void {
  if (!SETTINGS_KEYS.includes(key as SettingsKey)) {
    throw new Error(`Unknown settings key: "${key}"`);
  }
  const k = key as SettingsKey;

  if (MODEL_KEYS.has(k)) {
    // Free-text: empty string resets to default; non-empty must be a valid model tag
    if (value !== "" && !isValidModelTag(value)) {
      throw new Error(
        `Invalid model tag "${value}" for key "${key}". Must match ^[A-Za-z0-9][A-Za-z0-9._\\-\\/]*(:[A-Za-z0-9._\\-]+)?$ (max 128 chars) or be empty.`
      );
    }
  } else if (SYMBOL_LIST_KEYS.has(k)) {
    // Comma-joined ticker watchlist; empty = empty watchlist
    if (!isValidSymbolList(value)) {
      throw new Error(
        `Invalid symbol list "${value}" for key "${key}". Comma-joined tickers matching ${TICKER_RE}, max ${WATCHLIST_MAX}, or empty.`
      );
    }
  } else {
    const allowed = ALLOWED[k]!;
    if (!allowed.includes(value)) {
      throw new Error(
        `Invalid value "${value}" for key "${key}". Allowed: ${allowed.join(", ")}`
      );
    }
  }

  localStorage.setItem(k, value);

  // Dispatch a live-update event so Shell/Tapestry react without restart
  window.dispatchEvent(new CustomEvent("loom-settings-changed", { detail: { key: k, value } }));

  // Legacy side-effect for orb.tier
  if (k === "orb.tier") {
    if (value === "flat") {
      localStorage.setItem(LEGACY_ORB_KEY, "flat");
    } else {
      // "auto" — remove legacy key so detectTier falls back to auto-detection
      localStorage.removeItem(LEGACY_ORB_KEY);
    }
  }
}

/**
 * Clear all user settings, loom.* keys, and auspex tour key.
 * Called by loom.settings.resetAll() in api.ts (also clears tombstones).
 * Does NOT touch organ git files.
 */
export function resetAllSettings(): void {
  // Remove all known settings keys
  for (const k of SETTINGS_KEYS) {
    localStorage.removeItem(k);
  }
  // Remove all loom.* keys (includes loom.organs.deleted tombstones, loom.win.*, loom.minimized, etc.)
  const loomKeys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith("loom.")) loomKeys.push(k);
  }
  loomKeys.forEach((k) => localStorage.removeItem(k));
  // Also remove the auspex tour key
  localStorage.removeItem("auspex.tour.seen.v1");
}
