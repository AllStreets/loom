# Phase 23a — Rebirth: the second excision

**Verdict (owner, 2026-09-02):** the Cockpit is gone. LOOM returns to its thesis — a sovereign
computer that is its own developer. Every surface that any Electron wrapper could ship is cut.
What survives is the engine, the kernel, the fleet, the voice, the timeline, and the brand.

Precedent: Phase 18 (Excision) removed AGORA the same way. Same rules: migration-clean,
tests green at every commit, nothing reintroduced later.

## Cut (delete outright)

- `src/components/decks/**`, `src/components/terminal/**`, `src/components/WatchPanel*`
- `src/lib/decks/**`, `src/lib/market/**`, `src/lib/terminal/**`, `src/lib/watch/**`
- `src-tauri/src/market.rs`, `src-tauri/src/deckserve.rs`, `src-tauri/src/cloud.rs`
  (the cloud-override builder contradicts "no cloud"; Phase 23 rebuilds offline)
- `public/decks/**`, `scripts/refresh-auspex-deck.sh`, `scripts/refresh-ember-deck.sh`
- the `greet` scaffold command in `lib.rs`; the `deck://` protocol registration; bundle
  `resources` for decks in `tauri.conf.json`

## Prune (edit kept files)

- **Organ powers** (`src/lib/organs/api.ts`, `budgets.ts`, `sandbox.ts` mocks, `prompts.ts`,
  `uikitSrc.ts` if referenced): drop `market` and `watch`. Keep `timeline · voice · notify · pulse`.
  Replace the BTC-5%-drop few-shot with a power few-shot that needs no market data
  (e.g. an hourly stand-up reminder using `pulse` + `notify`).
- **Initiative** (`src/lib/initiative/**`): remove watch/salience-derived evidence and archetypes.
  Keep the usage observer and every rule that is earned from organ/build/voice evidence alone.
  A rule that can no longer quote real observed counts is deleted, not stubbed.
- **Companion / intent / compile** (`src/lib/companion/runtime.ts`, `src/lib/compiler/intent.ts`,
  `compile.ts`): remove deck commands, briefings, globe/terminal/market intents.
- **Shuttle** (`src/lib/shuttle/catalog.ts`): the catalog is derived from the rule tables; once
  the rules are gone the drift test must still pass.
- **Shell / Companion components**: remove the deck layer, VOID/GLOBE/TERMINAL toggles, WATCH
  button, deck-aware layout branches, brain badges on build cards.
- **Tapestry**: remove salience/watch strands; it weaves git, organs, builds, self-edits.
- **core.ts / experience.ts**: remove market and cloud wrappers; remove the `Brain` concept
  (there is one brain: local).
- **Settings** (`src/lib/voice/settings.ts`, `src/organs/seeds/settings.ts`): every `cockpit.*`
  and `cloud.*` key goes into `RETIRED_KEYS`; remove the Cloud builder and deck sections.
- **Selftest**: remove the cloud selftest block.
- **docs**: README — collapse the Cockpit phase sections into one paragraph of history under
  Roadmap, add the row `23a · Rebirth (excision)`; FOLLOWUPS — delete Cockpit backlogs.
- `src/lib/util/usePoll.ts` and any other helper with no remaining importer: delete.

## Rules

1. `npm run check` green after every commit (vitest + cargo test). tsc clean.
2. One commit per bullet group above; message prefix `excise(rebirth):`.
3. No raw hex; brand voice per `docs/BRAND.md`.
4. Do not touch `kernel.rs`, `exec.rs`, `timeline.rs`, `error.rs`, `main.rs` beyond removing
   references. `lib.rs` changes are limited to mod/handler/protocol removal.
5. Do not add features. This phase only removes.
