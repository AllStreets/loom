# LOOM Phase 20 — Initiative (design)

**Date:** 2026-08-23 · **Status:** approved direction (handoff), spec for planning

## Problem

LOOM never acts first. It builds what you ask, learns your weights, then waits. The revolutionary claim — *a computer that builds itself for you* — is only half true while every organ still starts with your sentence. Phase 20 closes the loop: **LOOM observes how you actually use it and proposes organs unprompted, each one earned by real evidence and governed by your consent.**

The failure to avoid is Clippy: a machine guessing, interrupting, being wrong. The defenses are non-negotiable and are the whole design:
- **Earned, not guessed.** No proposal without concrete observed behavior above a threshold. LOOM shows its evidence in plain language every time. If it can't justify the idea from what you did, it stays silent.
- **Consent-governed.** Rate-limited to at most one idea per day, silenceable entirely in one setting, and every rejected idea is remembered forever ("never" = a tombstone per archetype).
- **Buildable and worth having.** Proposals map only to organ archetypes the Phase-19 builder is proven to build well (pulse + market/watch/voice/notify). LOOM never proposes what it can't deliver.
- **No model call to detect.** The observer is a deterministic, testable rules engine. Only the build (which may use the cloud) runs inference — exactly as a typed request would.

## Architecture

### 1. The observer — usage ledger (sovereign, local, passive)

`src/lib/initiative/observe.ts`: a single self-contained subscriber mounted once in Shell. It listens to **existing** events (`loom-deck`, `loom-utterance`, `loom-salience`, watch-open) — no component edits, no new polling — and folds them into a capped local ledger `loom.usage.v1`:

```
UsageLedger = {
  decks:    Record<DeckId, { count: number; lastTs: number }>;
  commands: Record<string, number>;      // utterance intent kinds
  watchOpens: number;
  terminalOpens: number;
  floorOpens: Record<string, number>;    // per crypto product
  morningActivity: number;               // sessions active 5am–11am local
  firstSeenTs: number;
  updatedAt: number;
}
```

Pure reducer `foldUsage(ledger, event) → ledger` (tested); the subscriber is a thin wire. Sovereign: local only, no telemetry, bounded size.

### 2. The rules engine (pure, deterministic, the heart)

`src/lib/initiative/propose.ts`: `proposeFromObservation(inputs) → Proposal | null`, pure and exhaustively tested.

```
inputs = { ledger, signals, weights, organs, neverList, lastProposalTs, now }
Proposal = {
  id: string;              // STABLE per archetype (+params) — the never-list key
  archetype: string;       // "morning-brief" | "price-alert" | "topic-digest"
  title: string;           // "a morning brief"
  rationale: string;       // evidence in plain LOOM voice, quoting real counts
  request: string;         // the synthetic build sentence → the normal pipeline
  powers: string[];        // what the built organ will ask for (shown up front)
}
```

Each archetype is a rule: **minimum evidence threshold → archetype → grounded proposal.** v1 archetypes (all within the builder's proven competence):

| archetype | evidence gate (all local) | builds (powers) | request sentence |
|---|---|---|---|
| `morning-brief` | ≥5 watch opens AND ≥3 "brief me"/watch signals, OR ≥3 morning sessions with a non-empty watchlist | pulse + watch + voice | "Build a morning-brief organ that each morning reads my top three watch items aloud." |
| `price-alert` | ≥4 floor opens on one product | pulse + market + notify | "Build a price-alert organ that notifies me when <PRODUCT> moves more than 3% in an hour." |
| `topic-digest` | ≥3 positive learned weight on one category AND ≥4 "act" signals there | pulse + watch + notify | "Build a digest organ that notifies me when a top <CATEGORY> story crosses the watch." |

Selection: gather all firing rules, drop any whose `id` is on the never-list or whose target organ already exists (title/archetype match against installed organs), return the single highest-evidence one. Returns `null` when nothing is earned, when `now - lastProposalTs < 24h`, or when the setting is off. **Null is the common case and that is correct** — silence is the default.

### 3. The proposal surface (calm, non-blocking, consensual)

`src/components/chrome/Proposal.tsx`: NOT a screen-blocking modal (that is the permission card's job, later in the flow). A single glass card carrying the woven glyph, docked lower-center, gently animated in (reduced-motion: static). It states the idea and its rationale, lists the powers the organ will request, and offers three choices in LOOM's voice:

- **weave it** → dispatches the proposal's `request` through the *same* `loom-utterance` seam a typed request uses → normal plan/build/gate/**permission card** flow, unchanged. LOOM proposed; you still approve powers before anything runs.
- **not now** → dismiss; resets `lastProposalTs` so it won't nag (24h quiet), but the archetype may return later.
- **never** → tombstone this archetype's `id` permanently.

The **first-ever** proposal carries one extra calm line introducing what this is and how to silence it (Settings). Surfaced via a new `loom-proposal` CustomEvent; the observer emits it after a fold when a proposal is earned and the rate-limit permits.

### 4. Governance stores

- Setting `cockpit.initiative` ("on"|"off", default **on** — initiative is the vision; the toggle honors the house rule that any active surface must be silenceable). Live via `loom-settings-changed`; Settings-organ toggle.
- `loom.initiative.v1`: `{ lastProposalTs: number; neverList: string[]; }` — mirrors the tombstone pattern (`addNever(id)`, `getInitiativeState`). Rate-limit and never-list read by the rules engine.
- Approved builds record `proposalSource: "initiative"` on the experience `BuildRecord` (extend the type) so the post-mortem can see which organs LOOM grew on its own.

## Non-goals

Model-driven detection, background proposals while LOOM is closed, more than one proposal at a time, proposal "learning" beyond the never-list, editing existing organs by initiative, kernel self-modification (Phase 21).

## Testing

`foldUsage` reducer + ledger caps (unit); `proposeFromObservation` — every archetype's gate boundary, never-list exclusion, existing-organ exclusion, rate-limit, setting-off, null-is-common (unit, exhaustive — this is the load-bearing module); governance store round-trips + migration (unit); Proposal card render + three actions + first-proposal intro + reduced-motion (component); "weave it" dispatches the correct utterance (component); screenshot gate: proposal card (with rationale + powers), first-proposal variant. `npm run check` green per task.
