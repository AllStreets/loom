# LOOM — session handoff (updated 2026-08-26)

*Started by Claude Fable 5, continued by Claude Opus 4.8, for the next model taking over. Read this, then `README.md` (roadmap table), `docs/BRAND.md`, and `docs/FOLLOWUPS.md`. Repo: `~/Downloads/LOOM`, remote `github.com/AllStreets/loom`, everything below is merged to `main` and pushed.*

> **Update 2026-08-26:** Phase 20 (Initiative) is SHIPPED (was "next up" below). The remaining unbuilt horizon is **Phase 21 — Selfhood** (kernel self-modification). See "Where we're going" — Phase 21 is unchanged and is now the immediate next phase.

## The vision

LOOM is Connor's flagship: **a sovereign computer that is its own developer.** You describe a capability in a sentence; a local model plans it, writes the code *and its tests*, proves it in a sandbox, repairs its own failures, commits to a git timeline, and asks permission before the new "organ" runs — fully offline, no cloud, no keys, yours forever. Tauri v2 (Rust core) + React/TS/Vite shell + Ollama model fleet. The kernel/organ split is load-bearing: the kernel is protected; organs are model-written modules behind permission grants.

Connor's standing verdict (be governed by this): **no decorative widgets, no copied wrappers, no fake-working surfaces.** Before adding anything ask "could any Electron wrapper ship this?" — if yes, root it in what only LOOM has: its own git history, self-built organs, learned salience weights, one voice/⌘K grammar. Honesty is brand law (`docs/BRAND.md`): calm lowercase copy, panels state *why* they're empty, budgets/limits visible, never overclaim.

## Where we are (phases 15–19 shipped this run)

- **15 · Command** — (AGORA launch control; later removed, see 18) + learned-weights inspection in the WatchPanel, whisper log silence.
- **16 · Identity** — the brand system: woven-monogram glyph everywhere (`public/brand/`), BRAND.md; **the Tapestry** (constellation deleted; LOOM's git/organ/build history rendered as interlaced woven cloth behind the orb — `src/lib/tapestry/`, geometry matters: curves, never straight grid lines, Connor rejected the first grid render); **the Shuttle** (⌘K palette + voice share ONE command catalog derived from the real rule tables, drift is test-enforced — `src/lib/shuttle/`).
- **17 · Depth** — the Terminal was empty because the Rust proxy sent no User-Agent (Yahoo 429s without one — fixed, live-verified). Typed keyless market engine `src-tauri/src/market.rs`: Yahoo charts, Coinbase Exchange (ticker/book/trades), Frankfurter FX; hardcoded hosts, validated symbols. Terminal: editable watchlist, symbol detail charts, crypto/FX strips, per-source health chips.
- **18 · Excision** — **AGORA removed entirely by owner verdict. Never reintroduce it.** The Coinbase order-book floor survived and lives in the Terminal (click a crypto-strip symbol → `src/components/terminal/Floor.tsx` overlay). Four decks: void · globe · terminal · ember.
- **19 · Vigor** — organs got six real powers behind the `need()` grant seam: `market · watch · timeline · voice · notify · pulse` (`src/lib/organs/api.ts`, budgets in `budgets.ts`, toasts in `chrome/Notices.tsx`). Manifest declares `powers`, permission card lists them plainly, revocable live from the organ title bar, token-bucket budgets with a THROTTLED chip, deterministic sandbox mocks so generated tests are grounded (`loom.notify.sent`, `loom.voice.said`, `loom.pulse.registered`). Builder prompts teach the APIs conditionally (`requestImpliesPowers`) with a BTC-5%-drop few-shot. "Alert me when BTC drops 5%" now builds a real, running tool.

Gate state at handoff: `npm run check` fully green — **1332 vitest + 112 cargo** (1 ignored live test). Working tree clean on `main`.

## Why: Connor said "this still just isn't that impressive"

Diagnosis he agreed with: the surfaces got polished but the revolutionary loop had a toy ceiling and zero initiative. He chose the maximal path — **all three** of powers, initiative, and kernel self-modification. Phase 19 (powers) is done. Two remain:

## Where we're going

**Phase 20 — Initiative (SHIPPED 2026-08-26).** LOOM observes usage and proposes organs unprompted. `src/lib/initiative/`: `observe.ts` (passive usage ledger `loom.usage.v1`, subscribes to existing events, no polling), `propose.ts` (pure deterministic rules engine — three earned archetypes morning-brief/price-alert/topic-digest, hard evidence gates, returns null as the common case), `store.ts` (`loom.initiative.v1` rate-limit + never-list), `runtime.ts` (debounced event-driven emit). `src/components/chrome/Proposal.tsx` = the calm card (weave it / not now / never); "weave it" dispatches the SAME `loom-utterance {..., initiative:true}` a typed build uses → normal pipeline + permission card. Setting `cockpit.initiative` (default on). Design principle enforced throughout: **earned, not guessed** — every proposal quotes real observed counts; a rule that can't must not fire (the review caught and we fixed a morning-brief path that would've fired on an empty watchlist). If extending: add archetypes as rules with hard evidence gates, keep detection model-free.

**Phase 21 — Selfhood (NEXT, not started).** The guardrail flip: LOOM edits its own kernel source behind the walls that already exist (gate → git timeline → recovery boot). Sketch discussed: builder edits real kernel files; validation = tsc + targeted vitest via a Rust command; commit to timeline first; in dev, vite HMR shows the change live; packaged builds need a rebuild path (design carefully — the spawn machinery was deliberately deleted in 18, so any new spawn must be as hardened as `agora.rs` was: fixed argv, canonicalized paths, process-group kill). This is the headline claim of the whole project ("full self-modification" in the README roadmap's vision row). Treat it as the crown jewel: spec it tightly, review it adversarially.

## How this codebase is worked (the house rhythm — keep it)

1. Spec → `docs/superpowers/specs/YYYY-MM-DD-<name>-design.md`; plan with checkbox tasks → `docs/superpowers/plans/`. Commit docs first on a fresh branch named for the phase.
2. One subagent per task, one commit per task, `npm run check` fully green per commit. Tests first. Tokens only (no raw hex outside `public/brand/`). Screenshot-gate UI work headlessly (vite + Playwright, mocked Tauri/routes) — **and eyeball the screenshots yourself; agents have claimed "woven cloth" while shipping graph paper.**
3. Final whole-branch review by a code-reviewer agent with phase-specific attack surface listed. Every review this run found real bugs (symlink escapes, poll leaks, permission bypasses). Fix all before merge.
4. Ship: README phase section + roadmap row (voice per BRAND.md), FOLLOWUPS prune/backlog, merge to `main`, push branch + main.
5. Memory dir (`~/.claude/projects/-Users-connorevans-Downloads-LOOM/memory/`) holds project state — update it when phases land.

## Sharp edges to remember

- Yahoo needs a browser UA or it 429s; Coinbase + Frankfurter are keyless and CORS-open; Stooq is dead; Binance.com is geo-blocked (451).
- Organs share the shell's JS realm: powers are honesty-enforcement + owner consent, NOT a security sandbox (comment in `api.ts`; FOLLOWUPS notes the real-isolation backlog item). Don't claim otherwise in docs.
- Settings migrations: retired keys go in `RETIRED_KEYS` (`src/lib/voice/settings.ts`); `migrateSettings()` runs synchronously at the top of Shell's body BEFORE the useState initializers — keep that ordering.
- Seeds install only when missing — existing installs don't get seed updates without a reset (known, in FOLLOWUPS).
- `docs/superpowers/plans/2026-08-22-vigor.md` Task 3's checkbox and the spec/plan checkboxes generally aren't ticked retroactively — the README roadmap table is the source of truth for what shipped.
