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
  | "cockpit.tapestry"
  | "cockpit.chatMin"
  | "cockpit.initiative"
  | "kernel.autoReweave";

export const SETTINGS_KEYS: readonly SettingsKey[] = [
  "voice.default",
  "voice.speakReplies",
  "orb.tier",
  "loom.reviewBeforeSave",
  "model.builder",
  "model.companion",
  "model.rewriter",
  "cockpit.tapestry",
  "cockpit.chatMin",
  "cockpit.initiative",
  "kernel.autoReweave",
];

// Keys that use free-text model-tag validation instead of enumeration
const MODEL_KEYS = new Set<SettingsKey>(["model.builder", "model.companion", "model.rewriter"]);

// Allowed values for enumerated keys (model.* keys validate via isValidModelTag instead)
const ALLOWED: Partial<Record<SettingsKey, readonly string[]>> = {
  "voice.default": VOICE_IDS,
  "voice.speakReplies": ["always", "whenSpoken", "never"],
  "orb.tier": ["auto", "flat"],
  "loom.reviewBeforeSave": ["0", "1"],
  "cockpit.tapestry": ["on", "off"],
  "cockpit.chatMin": ["on", "off"],
  "cockpit.initiative": ["on", "off"],
  "kernel.autoReweave": ["on", "off"],
};

const DEFAULTS: Record<SettingsKey, string> = {
  "voice.default": "en_US-lessac-medium",
  "voice.speakReplies": "whenSpoken",
  "orb.tier": "auto",
  "loom.reviewBeforeSave": "0",
  "model.builder": "",
  "model.companion": "",
  "model.rewriter": "",
  // Default ON — the Tapestry is the brand, not decoration.
  "cockpit.tapestry": "on",
  // Default OFF — the typing box is present until its owner folds it away.
  "cockpit.chatMin": "off",
  // Default ON — initiative is the vision; the toggle honors the house rule
  // that any active surface must be silenceable.
  "cockpit.initiative": "on",
  // Default OFF — a reweave closes LOOM and returns it; the owner opts in to
  // that happening on its own after every approved core edit (Phase 23).
  "kernel.autoReweave": "off",
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
  // Phase 23a (Rebirth): the Cockpit is gone — decks, watch, terminal, cloud.
  "cockpit.deck",
  "cockpit.interact",
  "cockpit.watchOpen",
  "terminal.symbols",
  "model.cloudBuilder",
  // The Cockpit's own stores (watch signals / watchlist / weights, the AUSPEX tour flag).
  "loom.watch.v1",
  "auspex.tour.seen.v1",
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
 * Clear all user settings and loom.* keys.
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
}
