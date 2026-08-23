# Phase 20 Implementation Plan — Initiative

> **For agentic workers:** checkbox steps. Spec: `docs/superpowers/specs/2026-08-23-initiative-design.md` (authoritative). Seam map: engagement signals in `src/lib/watch/store.ts` (`getSignals`, `EngagementSignal {eventKey, action: open|dismiss|act, ts, category?, source?, titleTokens?}`), weights via `computeWeights`/`topWeights` (`src/lib/watch/learned.ts`), build entry `buildOrgan(request, deps)` (`src/lib/loom/build.ts`) reached from Companion's `loom-utterance` handler, permission card in `src/components/desktop/Desktop.tsx`, tombstone pattern `addOrganTombstone` + `loom.organs.deleted`, settings whitelist/RETIRED_KEYS/`migrateSettings` in `src/lib/voice/settings.ts`, experience `BuildRecord` in `src/lib/loom/experience.ts`.

**Goal:** LOOM proposes organs unprompted — a passive usage observer, a deterministic rules engine that only fires on earned evidence, a calm consensual proposal card whose "weave it" flows into the normal build pipeline, all rate-limited/silenceable/tombstoned.

**Tech stack:** existing only. No model call for detection. No new deps.

## Global constraints
- Sovereign: usage ledger local-only, capped, no telemetry. Detection is pure/deterministic/tested.
- Consent: rate-limit ≥24h, `cockpit.initiative` off-switch, per-archetype never-list. A proposal must ALWAYS show its real evidence; a rule that can't quote concrete observed counts must not fire.
- Proposals map only to archetypes the Phase-19 builder handles (pulse+market/watch/voice/notify).
- Tokens only; BRAND voice (calm, lowercase, honest). Gates: `npm run check` green per task.

---

### Task 1: The observer + the rules engine + governance (pure core)

**Files:**
- `src/lib/initiative/observe.ts` (+ tests): `UsageLedger` type + pure `foldUsage(ledger, event) → ledger` (deck visit, utterance intent, watch-open, terminal-open, floor-open per product, morning-session detection from a passed `now`); load/save to `loom.usage.v1` (capped: commands map ≤ 40 keys, bounded bytes like the watch store); a `mountObserver()` that subscribes to existing events (`loom-deck`, `loom-utterance`, `loom-salience` for watch activity, plus a `loom-deck` terminal/`loom-proposal`-independent path) and folds — thin wire over the pure reducer, returns an unmount fn. Do NOT edit feature components; subscribe to the existing bus. (Grep the exact event detail shapes first — `loom-deck {deck}`, `loom-utterance {text, spoken}`; for watch-open, find the event WatchPanel emits or listen to `cockpit.watchOpen` setting change / a watch event.)
- `src/lib/initiative/propose.ts` (+ tests — EXHAUSTIVE, this is load-bearing): `Proposal` type + pure `proposeFromObservation(inputs) → Proposal | null` per the spec's archetype table. Each archetype = evidence gate → grounded proposal with STABLE `id`, plain-voice `rationale` quoting real counts, synthetic `request` sentence (phrased to trigger the builder's `requestImpliesPowers` + match a known archetype), and declared `powers`. Selection: firing rules minus never-listed minus already-existing-organ (match archetype/title against `organs`), highest-evidence wins; return null on rate-limit (`now - lastProposalTs < 24h`), setting-off (pass the setting in), or nothing earned. Test every gate boundary + all null paths.
- `src/lib/initiative/store.ts` (+ tests): `loom.initiative.v1 = {lastProposalTs, neverList[]}`; `getInitiativeState()`, `markProposed(now)`, `addNever(id)`; round-trip + corruption-tolerant like existing stores.
- `src/lib/voice/settings.ts`: add `cockpit.initiative` (on/off, default "on") to whitelist/defaults/ALLOWED.
- `src/lib/loom/experience.ts`: extend `BuildRecord` with `proposalSource?: "initiative"` (optional, back-compatible; test it threads through `recordExperience`).

- [ ] observe tests → observe → propose tests (exhaustive) → propose → store tests → store → settings key → experience field → green → commit `feat(initiative): the observer and the rules — LOOM earns its ideas`.

---

### Task 2: The proposal surface + the loop closed

**Files:**
- `src/components/chrome/Proposal.tsx` (+ tests): glass card with the woven glyph (reuse `LoomGlyph`), docked lower-center (z between notices and permission modal — grep the z-map), gently animated in (framer-motion AnimatePresence like the permission card; reduced-motion static). Renders `title`, `rationale`, a plain-language powers line ("it will ask to: run on a schedule · read your watch · speak aloud" — reuse `POWER_LABELS`), and three buttons: **weave it** / **not now** / **never**. First-ever proposal (governance store's neverList empty AND lastProposalTs 0) shows one extra calm intro line + how to silence (Settings). Listens on `loom-proposal`; only one card at a time.
  - **weave it** → dispatch `loom-utterance {text: proposal.request, spoken: false}` (the exact seam a typed build uses — verify Companion consumes it and runs `buildOrgan`) → `markProposed(now)` → close. The organ then goes through the normal gate + permission card unchanged.
  - **not now** → `markProposed(now)` (24h quiet) → close.
  - **never** → `addNever(proposal.id)` → `markProposed(now)` → close.
- Wire the emit: in `mountObserver` (or a small `src/lib/initiative/runtime.ts`), after a fold (debounced) AND on Shell mount, call `proposeFromObservation(...)` with current inputs; if non-null and `cockpit.initiative === "on"`, dispatch `loom-proposal {proposal}`. Guard: at most one live proposal; don't re-emit the same id while a card is open. Keep it event-driven (no polling loop) — evaluate on the activity events the observer already hears, debounced.
- Mount `Proposal` + `mountObserver`/runtime in `Shell.tsx` chrome (respect the migration-before-useState ordering; observer unmount on Shell unmount).
- Settings organ (`src/organs/seeds/settings.ts`): add the INITIATIVE on/off toggle in the cockpit section.
- Build records: when a build originates from a proposal, set `proposalSource: "initiative"` (thread a flag from the utterance detail through Companion → buildOrgan deps → recordExperience; add `initiative?: true` to the `loom-utterance` detail and honor it).

- [ ] Proposal tests → Proposal card → runtime emit wiring → Shell mount → settings toggle → experience threading → screenshots (proposal card w/ rationale+powers, first-proposal intro variant) → green → commit `feat(initiative): the loom has an idea — proposals, consented`.

---

### Task 3: Ship

README Phase 20 section + roadmap row (BRAND voice); FOLLOWUPS backlog (model-phrased rationale later, more archetypes, proposal analytics — all deliberate non-goals now) + resolved; final whole-branch review (attention: rules engine can NEVER fire without real evidence or past rate-limit/never-list/off; the weave-it utterance path is byte-identical to a typed build; observer has no event-listener leaks; ledger/store corruption tolerance; no proposal spam / double-emit; first-proposal intro logic; prompt-injection via rationale rendered as text). Fixes → merge → push.

- [ ] docs → review → fixes → merge → push → commit `feat(initiative): phase 20 ships — initiative`.

## Self-review notes
- The load-bearing risk is a rule firing on thin/no evidence (Clippy). Every archetype gate has a hard minimum count; `proposeFromObservation` tests must include the "just-below-threshold → null" case for each.
- The weave-it path must reuse the typed-build seam exactly — no parallel build entry. Verify by test that clicking weave-it produces the same `loom-utterance` a user typing the sentence would.
- Default-on is a deliberate brand statement, but the off-switch and never-list must be trivially reachable; the first proposal must teach both.
