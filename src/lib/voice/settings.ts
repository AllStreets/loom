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

// ── AGORA path validation ─────────────────────────────────────────────────────

/**
 * Validate a candidate AGORA path.
 * Empty string is treated as "use default" — Rust uses ~/Downloads/AGORA.
 * Non-empty: any non-empty string passes client-side; Rust validates existence/structure.
 */
export function isValidAgoraPath(_path: string): boolean {
  // Empty means "use default" — always valid client-side
  // Non-empty: Rust validates existence, dir-under-home, package.json, scripts.dev
  return true; // always true — Rust validates
}

// ── AGORA URL validation ───────────────────────────────────────────────────────

/**
 * Validate a candidate AGORA URL.
 * MUST be http or https with hostname exactly "localhost" or "127.0.0.1" (any port).
 * Empty string is treated as "use default" — returns true.
 * Any other value (remote URLs, file://, wrong hostname) returns false.
 */
export function isValidAgoraUrl(url: string): boolean {
  if (url === "") return true; // empty = use default
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  } catch {
    return false;
  }
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
  | "deck.agora.url"
  | "deck.agora.path";

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
  "deck.agora.url",
  "deck.agora.path",
];

// Keys that use free-text model-tag validation instead of enumeration
const MODEL_KEYS = new Set<SettingsKey>(["model.builder", "model.companion", "model.rewriter"]);

// Keys that use free-text URL validation instead of enumeration
const URL_KEYS = new Set<SettingsKey>(["deck.agora.url"]);

// Keys that use free-text path validation (Rust validates existence/structure)
const PATH_KEYS = new Set<SettingsKey>(["deck.agora.path"]);

// Allowed values for enumerated keys (model.* keys validate via isValidModelTag instead)
const ALLOWED: Partial<Record<SettingsKey, readonly string[]>> = {
  "voice.default": VOICE_IDS,
  "voice.speakReplies": ["always", "whenSpoken", "never"],
  "orb.tier": ["auto", "flat"],
  "loom.reviewBeforeSave": ["0", "1"],
  "model.cloudBuilder": ["off", "anthropic"],
  "cockpit.deck": ["void", "globe", "terminal", "ember", "agora"],
  "cockpit.interact": ["on", "off"],
  "cockpit.tapestry": ["on", "off"],
  "cockpit.watchOpen": ["on", "off"],
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
  "deck.agora.url": "http://localhost:3000",
  "deck.agora.path": "",
};

// Legacy key the orb's detectTier reads
const LEGACY_ORB_KEY = "loom.orb";

// Settings keys that no longer exist. Their stored values are deleted at boot
// by migrateSettings() — same discipline as the organ tombstone list: a removed
// feature must not leave orphaned state behind.
const RETIRED_KEYS: readonly string[] = [
  // Phase 16: the constellation died; the Tapestry (cockpit.tapestry) lives.
  "cockpit.constellation",
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
  } else if (URL_KEYS.has(k)) {
    // Free-text URL: empty string resets to default; non-empty must be a valid local URL
    if (!isValidAgoraUrl(value)) {
      throw new Error(
        `Invalid URL "${value}" for key "${key}". Must be http(s)://localhost[:<port>] or http(s)://127.0.0.1[:<port>], or empty to reset to default.`
      );
    }
  } else if (PATH_KEYS.has(k)) {
    // Free-text path: client-side always valid; Rust validates existence/structure
    if (!isValidAgoraPath(value)) {
      throw new Error(`Invalid path "${value}" for key "${key}".`);
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
