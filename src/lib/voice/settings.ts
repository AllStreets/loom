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
  | "cockpit.deck";

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
];

// Keys that use free-text model-tag validation instead of enumeration
const MODEL_KEYS = new Set<SettingsKey>(["model.builder", "model.companion", "model.rewriter"]);

// Allowed values for enumerated keys (model.* keys validate via isValidModelTag instead)
const ALLOWED: Partial<Record<SettingsKey, readonly string[]>> = {
  "voice.default": VOICE_IDS,
  "voice.speakReplies": ["always", "whenSpoken", "never"],
  "orb.tier": ["auto", "flat"],
  "loom.reviewBeforeSave": ["0", "1"],
  "model.cloudBuilder": ["off", "anthropic"],
  "cockpit.deck": ["void", "globe", "terminal"],
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
};

// Legacy key the orb's detectTier reads
const LEGACY_ORB_KEY = "loom.orb";

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
  } else {
    const allowed = ALLOWED[k]!;
    if (!allowed.includes(value)) {
      throw new Error(
        `Invalid value "${value}" for key "${key}". Allowed: ${allowed.join(", ")}`
      );
    }
  }

  localStorage.setItem(k, value);

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
