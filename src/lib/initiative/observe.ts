/**
 * observe.ts — the usage observer (sovereign, local, passive)
 *
 * LOOM watches how it is actually used and folds that into a small, capped
 * local ledger `loom.usage.v1`. This is the evidence the rules engine
 * (propose.ts) reads before it dares to suggest anything. No telemetry, no
 * network — the ledger never leaves the machine.
 *
 * The reducer `foldUsage` is pure and deterministic (same events → same
 * ledger). `mountObserver` is a thin wire that subscribes to the EXISTING
 * event bus and folds — no feature components are edited.
 *
 * Watch-open observation: the WATCH toggle in Shell writes
 * `setSetting('cockpit.watchOpen', 'on')`, which dispatches
 * `loom-settings-changed`. We listen for that transition to "on" — an honest
 * existing signal, no new dispatch added anywhere.
 */

const STORE_KEY = "loom.usage.v1";
const MAX_COMMANDS = 40; // commands map ≤ 40 keys
const MAX_FLOOR_PRODUCTS = 40; // floorOpens map guard (same discipline)
const MAX_BYTES = 32 * 1024; // 32KB total guard — usage is small by design

// The 5am–11am local "morning" window (hours, inclusive-exclusive on the end).
const MORNING_START_HOUR = 5;
const MORNING_END_HOUR = 11;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UsageLedger {
  decks: Record<string, { count: number; lastTs: number }>;
  commands: Record<string, number>; // utterance intent kinds
  watchOpens: number;
  terminalOpens: number;
  floorOpens: Record<string, number>; // per crypto product
  morningActivity: number; // distinct calendar days active 5am–11am local
  lastMorningDay: string; // "YYYY-M-D" of the last counted morning (dedupe key)
  firstSeenTs: number;
  updatedAt: number;
}

/** The events the observer folds. Discriminated on `type`. */
export type UsageEvent =
  | { type: "deck"; deck: string }
  | { type: "utterance"; text: string }
  | { type: "watch-open" }
  | { type: "terminal-open" }
  | { type: "floor-open"; product: string }
  // Pre-classified intent bump — used by the utterance classifier internally
  // and available for direct injection (kind bucket, +weight).
  | { type: "intent"; kind: string; weight: number };

// ── Empty ledger ────────────────────────────────────────────────────────────

export function emptyLedger(now: number): UsageLedger {
  return {
    decks: {},
    commands: {},
    watchOpens: 0,
    terminalOpens: 0,
    floorOpens: {},
    morningActivity: 0,
    lastMorningDay: "",
    firstSeenTs: now,
    updatedAt: now,
  };
}

// ── Utterance intent classification ───────────────────────────────────────────

/**
 * Classify an utterance into a coarse intent bucket. Deterministic keyword
 * match, first-hit wins (order matters: specific before generic). Returns
 * null for empty/whitespace input.
 */
export function classifyIntent(text: string): string | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  // brief / briefing / summarize the day
  if (/\b(brief(?:ing)?|summar\w+|catch me up|digest)\b/.test(t)) return "brief";
  // alert / notify / warn / ping / tell me when
  if (/\b(alert\w*|notif\w*|warn\w*|ping|tell me when|let me know)\b/.test(t)) return "alert";
  // build / make / create an organ
  if (/\b(build|make|create|weave|generate)\b/.test(t)) return "build";
  // watch / news / headlines / feed
  if (/\b(watch|news|headlines?|feeds?)\b/.test(t)) return "watch";
  // price / market / crypto / ticker
  if (/\b(price\w*|market\w*|crypto|bitcoin|btc|eth|stock\w*|ticker\w*)\b/.test(t)) return "market";
  return "other";
}

// ── Caps ─────────────────────────────────────────────────────────────────────

/** Trim a count-map to `max` keys, dropping the smallest counts first. */
function capCountMap(map: Record<string, number>, max: number): Record<string, number> {
  const keys = Object.keys(map);
  if (keys.length <= max) return map;
  const kept = keys
    .sort((a, b) => map[b] - map[a]) // largest counts survive
    .slice(0, max);
  const out: Record<string, number> = {};
  for (const k of kept) out[k] = map[k];
  return out;
}

// ── Morning detection ─────────────────────────────────────────────────────────

/** Local calendar-day key "YYYY-M-D" for dedupe (month 1-indexed). */
function dayKey(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** True when `now` falls in the local 5am–11am window. */
function isMorning(now: number): boolean {
  const h = new Date(now).getHours();
  return h >= MORNING_START_HOUR && h < MORNING_END_HOUR;
}

// ── The reducer (pure) ────────────────────────────────────────────────────────

/**
 * Fold one usage event into the ledger at time `now`. Pure: returns a new
 * ledger, never mutates the input. Also detects morning sessions from `now`
 * (once per calendar day).
 */
export function foldUsage(ledger: UsageLedger, event: UsageEvent, now: number): UsageLedger {
  // Shallow-clone the containers we might touch (keeps the input frozen).
  const next: UsageLedger = {
    ...ledger,
    decks: { ...ledger.decks },
    commands: { ...ledger.commands },
    floorOpens: { ...ledger.floorOpens },
    updatedAt: now,
  };

  switch (event.type) {
    case "deck": {
      const prev = next.decks[event.deck] ?? { count: 0, lastTs: 0 };
      next.decks[event.deck] = { count: prev.count + 1, lastTs: now };
      // A terminal deck visit is also a terminal-open.
      if (event.deck === "terminal") next.terminalOpens = next.terminalOpens + 1;
      break;
    }
    case "utterance": {
      const kind = classifyIntent(event.text);
      if (kind) next.commands[kind] = (next.commands[kind] ?? 0) + 1;
      break;
    }
    case "intent": {
      next.commands[event.kind] = (next.commands[event.kind] ?? 0) + event.weight;
      break;
    }
    case "watch-open":
      next.watchOpens = next.watchOpens + 1;
      break;
    case "terminal-open":
      next.terminalOpens = next.terminalOpens + 1;
      break;
    case "floor-open":
      next.floorOpens[event.product] = (next.floorOpens[event.product] ?? 0) + 1;
      break;
  }

  // Morning-session detection — once per local calendar day.
  if (isMorning(now)) {
    const key = dayKey(now);
    if (next.lastMorningDay !== key) {
      next.lastMorningDay = key;
      next.morningActivity = next.morningActivity + 1;
    }
  }

  // Caps.
  next.commands = capCountMap(next.commands, MAX_COMMANDS);
  next.floorOpens = capCountMap(next.floorOpens, MAX_FLOOR_PRODUCTS);

  return next;
}

// ── Load / save ────────────────────────────────────────────────────────────

/** Load the ledger, tolerating absence, corruption, and partial objects. */
export function loadUsage(): UsageLedger {
  const fresh = emptyLedger(Date.now());
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return fresh;
    const p = JSON.parse(raw) as Partial<UsageLedger>;
    if (!p || typeof p !== "object") return fresh;
    return {
      decks: isPlainObject(p.decks) ? (p.decks as UsageLedger["decks"]) : {},
      commands: isPlainObject(p.commands) ? (p.commands as Record<string, number>) : {},
      watchOpens: numOr(p.watchOpens, 0),
      terminalOpens: numOr(p.terminalOpens, 0),
      floorOpens: isPlainObject(p.floorOpens) ? (p.floorOpens as Record<string, number>) : {},
      morningActivity: numOr(p.morningActivity, 0),
      lastMorningDay: typeof p.lastMorningDay === "string" ? p.lastMorningDay : "",
      firstSeenTs: numOr(p.firstSeenTs, fresh.firstSeenTs),
      updatedAt: numOr(p.updatedAt, fresh.updatedAt),
    };
  } catch {
    return fresh;
  }
}

/** Persist the ledger. Swallows storage errors; trims if oversized. */
export function saveUsage(ledger: UsageLedger): void {
  try {
    const capped: UsageLedger = {
      ...ledger,
      commands: capCountMap(ledger.commands, MAX_COMMANDS),
      floorOpens: capCountMap(ledger.floorOpens, MAX_FLOOR_PRODUCTS),
    };
    let serialised = JSON.stringify(capped);
    if (serialised.length > MAX_BYTES) {
      // Shed the least-load-bearing detail first: decks, then commands.
      capped.decks = {};
      serialised = JSON.stringify(capped);
      if (serialised.length > MAX_BYTES) {
        capped.commands = {};
        serialised = JSON.stringify(capped);
      }
    }
    localStorage.setItem(STORE_KEY, serialised);
  } catch {
    // storage unavailable or quota exceeded — silent by design
  }
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ── The observer (thin wire) ─────────────────────────────────────────────────

/**
 * Subscribe to the existing event bus and fold usage into the persisted
 * ledger. Returns an unmount fn that removes every listener. Does NOT edit any
 * feature component — it only listens.
 */
export function mountObserver(): () => void {
  const fold = (event: UsageEvent) => {
    const now = Date.now();
    const next = foldUsage(loadUsage(), event, now);
    saveUsage(next);
  };

  const onDeck = (ev: Event) => {
    const deck = (ev as CustomEvent<{ deck?: string }>).detail?.deck;
    if (typeof deck === "string" && deck) fold({ type: "deck", deck });
  };

  const onUtterance = (ev: Event) => {
    const text = (ev as CustomEvent<{ text?: string }>).detail?.text;
    if (typeof text === "string" && text.trim()) fold({ type: "utterance", text });
  };

  const onSettings = (ev: Event) => {
    const detail = (ev as CustomEvent<{ key?: string; value?: string }>).detail;
    // Watch-open has no dedicated event; the WATCH toggle flips this setting.
    if (detail?.key === "cockpit.watchOpen" && detail.value === "on") {
      fold({ type: "watch-open" });
    }
  };

  const onFloorOpen = (ev: Event) => {
    // TerminalDeck's openFloor dispatches this when the crypto floor overlay
    // opens — the sole evidence source for the price-alert archetype.
    const product = (ev as CustomEvent<{ product?: string }>).detail?.product;
    if (typeof product === "string" && product) fold({ type: "floor-open", product });
  };

  window.addEventListener("loom-deck", onDeck);
  window.addEventListener("loom-utterance", onUtterance);
  window.addEventListener("loom-settings-changed", onSettings);
  window.addEventListener("loom-floor-open", onFloorOpen);

  return () => {
    window.removeEventListener("loom-deck", onDeck);
    window.removeEventListener("loom-utterance", onUtterance);
    window.removeEventListener("loom-settings-changed", onSettings);
    window.removeEventListener("loom-floor-open", onFloorOpen);
  };
}
