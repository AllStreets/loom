/**
 * store.ts — loom.initiative.v1 governance store
 *
 * The consent memory of the initiative system:
 *   - lastProposalTs: when LOOM last floated an idea (the 24h rate-limit clock).
 *   - neverList: the archetype ids the owner tombstoned forever ("never").
 *
 * Mirrors the tombstone discipline of the organ/settings stores: local-only,
 * corruption-tolerant, storage errors swallowed.
 */

const STORE_KEY = "loom.initiative.v1";

export interface InitiativeState {
  lastProposalTs: number;
  neverList: string[];
}

function load(): InitiativeState {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { lastProposalTs: 0, neverList: [] };
    const p = JSON.parse(raw) as Partial<InitiativeState>;
    return {
      lastProposalTs:
        typeof p.lastProposalTs === "number" && Number.isFinite(p.lastProposalTs)
          ? p.lastProposalTs
          : 0,
      neverList: Array.isArray(p.neverList)
        ? p.neverList.filter((x): x is string => typeof x === "string")
        : [],
    };
  } catch {
    return { lastProposalTs: 0, neverList: [] };
  }
}

function save(state: InitiativeState): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    // storage unavailable — silent by design
  }
}

/** Read the current governance state (fresh defaults if never written). */
export function getInitiativeState(): InitiativeState {
  return load();
}

/** Record that a proposal was just floated — starts the 24h quiet window. */
export function markProposed(now: number): void {
  const s = load();
  s.lastProposalTs = now;
  save(s);
}

/** Tombstone an archetype id forever. Dedupes. */
export function addNever(id: string): void {
  const s = load();
  if (!s.neverList.includes(id)) s.neverList.push(id);
  save(s);
}
