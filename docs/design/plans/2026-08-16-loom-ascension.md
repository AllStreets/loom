# LOOM Ascension Implementation Plan (Phase 8)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LOOM gets measurably smarter with every use (experience → exemplar injection into prompts), conversationally continuous (build/edit memory + anaphora), visibly alive (fleet HUD, stage choreography, no text ever off-screen), far more beautiful (orb unclipped + mood-reactive ambient + micro-interactions), and able to build genuinely rich organs (kit v3: charts, gauges, grids, tabs, icons).

**Architecture:** A new experience engine (`src/lib/loom/experience.ts`) records every build/edit outcome and retrieves keyword-scored exemplars that are injected into builder prompts — the "prompt-injection self-learning" loop; the store doubles as a JSONL fine-tuning corpus export for future model training. The companion pushes structured build outcomes into conversation history and forwards history into intent classification. The shell gains a persistent FleetHUD + phase stepper. The orb canvas is unclipped and the ambient layer becomes mood-reactive. UIKIT_SRC grows 10 chart/layout/input factories.

**Tech Stack:** React 18 + TS, Tauri v2 Rust core, Ollama fleet (builder qwen3-coder:30b / companion gpt-oss:20b / rewriter qwen3:1.7b), framer-motion, @react-three/postprocessing, vitest + cargo test + env-gated real-model selftest.

## Global Constraints

- Brand: navy `#060b18`, cyan `#22d3ee`, glass. NO yellow anywhere (`--warn` is currently `#fbbf24` = brand violation; remap to `#f97316` orange in T3 and nothing new may use yellow). NO emojis.
- UIKIT_SRC hard constraints: ONE plain ES2019 JS string, no backticks, no `${`, no `</script` substring, ASCII only, string concatenation only; evaluated via new Function in host AND raw-concatenated into sandbox srcdoc. KIT_TOKENS single-sourced (use the existing `rgba()` helper for accent-derived colors).
- Seed ORGAN_JS/TEST_JS strings: same srcdoc-safety constraints; kit-composed; data-action on every interactive element; per-test fresh storage.
- Tauri v2 IPC: JS args camelCase.
- Experience records live client-side in localStorage under `loom.exp.v1` (single JSON array, capped at 200 records, oldest evicted). No Rust changes required for the store.
- prompts.ts ctxFor sizes from actual string lengths — every prompt-size change must flow through it.
- Performance: no new per-frame allocations in ambient tick paths; ONE shared rAF (ambientLoop) — kit `spinner`/charts use CSS animation, not JS loops; mood-reactive color transitions precompute strings on mood-change events, not per frame.
- Gates per task: `npm run check` (vitest + cargo) green + `npm run build` green. T1 and T5 additionally run the REAL `npm run selftest` (Ollama fleet must be up) and report honest counts.
- Baseline for comparison (recorded 2026-08-16 pre-phase): selftest result noted in the SDD ledger.

---

### Task 1: The Loom Remembers — experience engine + accuracy quick-wins

**Files:**
- Create: `src/lib/loom/experience.ts`, `src/lib/loom/experience.test.ts`
- Modify: `src/lib/loom/build.ts`, `src/lib/loom/gateRepair.ts`, `src/lib/loom/prompts.ts`, `src/lib/loom/sandbox.ts` (renderedHtml cap), `src/lib/companion/editOrgan.ts` (record edits too)
- Modify: `src/selftest/loom.selftest.test.ts` (exemplar-injection proof task)
- Delete: `src/lib/loom/plan.ts` + its tests (confirmed dead code — newOrganPlan/parseSteps imported nowhere)

**Interfaces:**
- Produces: `experience.ts` exports:
  - `type BuildRecord = { ts: number; kind: "build" | "edit"; request: string; organId: string; ok: boolean; stage?: string; repairRounds: number; manifest?: string; code?: string; tests?: string; failedTests?: string[]; errors?: string[] }`
  - `recordExperience(r: BuildRecord): void` (localStorage `loom.exp.v1`, cap 200, evict oldest, swallow storage errors)
  - `retrieveExemplars(request: string, k: number): string` — scores stored SUCCESSFUL records by token-overlap (lowercase word bigram+unigram overlap against `record.request`), returns top-k formatted as `PAST SUCCESSFUL BUILD (request: "...", passed in N repair rounds):\n<manifest>\n<organ.js>` blocks; empty string when no records/matches (score threshold > 0).
  - `retrieveLessons(request: string, k: number): string` — from FAILED records: one-line anti-pattern lessons (`A similar past build ("...") failed at stage <stage> with: <first error line>. Avoid that failure mode.`).
  - `exportCorpus(): string` — all records as JSONL of `{prompt, completion, verdict}` triples (manifest/code/tests phases) for future fine-tuning; wire a dev-only export: `window.__loomExportCorpus` set in experience.ts module init.
- `prompts.ts`: `organSystemPrompt(kind, opts?: { exemplars?: string; lessons?: string })` — exemplar block inserted between contract and task instruction; ctxFor callers updated with real assembled lengths.
- `build.ts`: before code generation, `const exemplars = retrieveExemplars(request, 2)` + `retrieveLessons(request, 2)`; on completion (success AND failure paths) `recordExperience(...)` with repairRounds threaded out of runGateWithRepair. `editOrgan.ts`: record kind "edit" outcomes.

**Accuracy quick-wins (all in this task, each small):**
1. Manifest repair round: on manifestGuard failure, ONE repair chat (JSON is tiny) before hard-fail (build.ts).
2. Repair memory: gateRepair threads a `priorAttempts` summary into each repair prompt — for each earlier round: target file, first 2 error lines before, first 2 after (compact, not full transcripts).
3. Error-aware repair routing: before the fixed organ→test→organ sequence, if error text matches /import|cannot resolve|not a module/ → target test.js this round; if /querySelector.*null|not a function|undefined/ → organ.js. Fixed sequence remains the tiebreak.
4. Repair temperature 0.0 (generation stays 0.2).
5. renderedHtml cap 3000 → 9000 chars (sandbox.ts) — ctxFor absorbs it.
6. Tests prompt gains the ORIGINAL user request line (build.ts testsUser).
7. Deterministic selector grounding (baseline evidence: 2026-08-16 selftest run failed tests-grounded-in-dom — the model still sometimes invents `data-action` selectors even WITH the DOM in the prompt): after tests generation and before the gate, extract every `data-action="X"` referenced in test.js and every one present in renderedHtml; if test.js references unknown actions, ONE corrective re-ask listing the unknown selectors and the valid set ("Your test refers to data-action values that do not exist: [...]. Valid values: [...]. Rewrite test.js using only valid selectors."), then proceed (the gate remains the final arbiter). Pure string extraction — no model judgment in the check.
- Tests: experience store round-trip + cap eviction + scoring order + threshold-empty + corpus JSONL shape (mocked localStorage); prompts exemplar insertion; build.ts mocked-flow: records written on success AND failure, exemplars retrieved before code call, manifest repair path; gateRepair routing overrides + priorAttempts presence; temperature assertions.
- Selftest (REPS honest): new task `exemplars-injected` — seed the store with a crafted successful counter-organ record, run a same-class build request, assert the code-phase prompt (capture via deps.chat spy in the selftest harness — it uses real chat; instead assert via a prompt-assembly unit path with the real store) AND that the real build still passes the gate. Keep the real-model portion: one full build of a "counter" class organ with the seeded store; assert gate pass + record count grew.

- [ ] Steps: failing tests → experience.ts → prompt/injection plumbing → quick-wins 1-6 → all green → real selftest → commit `feat(loom): the loom remembers — experience engine, exemplar injection, repair memory`.

---

### Task 2: The Companion Remembers — conversational continuity + intent upgrades

**Files:**
- Modify: `src/lib/compiler/intent.ts`, `src/lib/compiler/compile.ts`, `src/lib/companion/runtime.ts`, `src/lib/companion/persona.ts`, `src/components/Companion.tsx`
- Tests: existing compiler/runtime/Companion test files

**Interfaces:**
- `compile(utterance, organIds, history?: Array<{role: string; content: string}>)` — history (last 3 turns, content truncated to 160 chars each) forwarded to `classifyIntent`.
- `classifyIntent`: (a) fix the "make me something like notes" misfire — build-phrase check (`make me a/an/something`) takes precedence over edit-verb+organ-substring when the utterance matches BUILD_PHRASE_RE, even if an organ id appears; (b) model fallback prompt gains a system message with 6 few-shot classification examples (2 per intent class incl. anaphora cases) + the history block; (c) anaphora: when utterance contains /\b(it|that|this one|the last one)\b/ and history names an organId, resolve target from history before falling back to the model.
- Build/edit outcomes enter history: after a successful build, Companion pushes assistant message `Built <organId>: <manifest description>. Passed in <n> repair round(s).`; after failure: `Build of <organId?> failed at <stage>.`; after edit: `Edited <organId>: <request summary>.` — into the SAME history buffer used by converse (windowMessages already caps at 16).
- persona.ts `COMPANION_SYSTEM` gains one line: it may reference organs it built earlier in the session.
- Tests: intent misfire regression case; anaphora resolution from history ("make it blue" after "Built water-tracker..." → edit_organ target water-tracker); history threading through compile; Companion pushes outcome messages (mocked runtime); model-fallback prompt contains few-shots + history (mocked askModel capture).

- [ ] Steps: failing tests → intent/compile changes → runtime/Companion history wiring → green → commit `feat(companion): conversational memory — builds enter history, anaphora resolves, intent few-shots`.

---

### Task 3: Fleet HUD + stage choreography + nothing-off-screen sweep

**Files:**
- Create: `src/components/FleetHUD.tsx` (+ test)
- Modify: `src/components/Shell.tsx` (replace dot-row with FleetHUD), `src/components/Companion.tsx` (EventLog → phase stepper + overflow fixes), `src/styles/tokens.css` (`--warn` remap + token expansion), `src/lib/loom/build.ts` (events carry `role` field)
- Tests: FleetHUD.test.tsx, Companion tests, existing Shell tests

**Interfaces:**
- `BuildEvent` gains `role?: "builder" | "companion" | "rewriter"` — build.ts sets role on every emitted event (all build phases = builder). Companion dispatches a `loom-fleet-activity` CustomEvent `{ role, phase } | { role: null }` at build start/phase-change/end and on converse (companion role) / rewriter fallback classify.
- `FleetHUD`: persistent strip in the top bar — for each role: name, model tag (from fleetStatus incl. overrides) truncated `max-width + ellipsis` with full tag in title, presence dot, and an ACTIVE state (cyan pulse ring, framer-motion) driven by `loom-fleet-activity`; offline fleet → muted "fleet offline" text. Mood-agnostic (role colors: builder `#7dd3fc`, companion `#22d3ee`, rewriter `#a78bfa`).
- EventLog becomes a phase stepper: ordered phases `manifest → code → probe → tests → gate → review → write` rendered as connected steps; current step pulses, done steps solid, error step in `--danger`; per-event detail lines below keep the mono log but colored by phase and with `wordBreak: "break-word"`.
- Overflow sweep (EVERY item, from the audit): Companion AssistantBubble (`minWidth: 0` + `overflowWrap: "break-word"`), UserBubble (same), EventLog detail spans, SuccessCard sha + organId (break/ellipsis), Timeline commit message in Shell (`ellipsis + title`), permission modal description (`maxHeight + overflowY auto`) and permissions list, FailureCard stage. FleetHUD model tags per above.
- tokens.css: `--warn: #f97316` (kill yellow); add `--shadow-1/-2/-3`, `--ease-out: cubic-bezier(.22,1,.36,1)`, `--dur-fast: .15s`, `--dur-slow: .4s`, `--glass-raised`; delete dead `--state-listen/think/speak` vars (grep confirms unused). Migrate the hand-written box-shadows in Shell/OrganWindow/Companion to the tokens (values may keep current appearance).
- Tests: FleetHUD renders roles + reacts to activity events + truncation style present; stepper phase states; overflow style assertions on the risky nodes (style property checks); tokens: no `#fbbf24` remains anywhere in src/ (grep-style test or verified by review).

- [ ] Steps: failing tests → build.ts role events → FleetHUD → stepper → overflow sweep → tokens → green → commit `feat(shell): fleet HUD, build stage choreography, nothing off-screen`.

---

### Task 4: The Shell Ascends — orb unclipped + mood-reactive ambient + micro-interactions

**Files:**
- Modify: `src/components/orb/OrbGL.tsx`, `src/components/orb/Orb.tsx` (canvas sizing), `src/components/orb/Orb2D.tsx`, `src/components/ambient/Field.tsx`, `src/components/ambient/Threads.tsx`, `src/components/Shell.tsx`, `src/components/desktop/{Dock,OrganWindow,Desktop}.tsx`, `src/components/Companion.tsx` (bubble entrances)
- Tests: existing component tests extended

**Requirements:**
1. **Orb unclipped (visually verified defect):** the WebGL canvas renders as a visible lighter rectangle and the bloom clips at its edges. Fix: canvas container grows to at least 2.4x the orb sphere's screen diameter (bloom headroom), Canvas `gl={{ alpha: true }}` + `style={{ background: "transparent" }}` and scene has NO background color so only the orb + glow render (verify no post-processing pass writes an opaque clear color — if EffectComposer forces opaque clear, set `renderer.setClearAlpha(0)`). Acceptance: screenshot-level — no straight edge of the canvas is distinguishable from `--bg` (a unit test can assert style props; the implementer must ALSO verify in the browser via `npm run dev` + screenshot and state so in the report).
2. Orb presence: sphere scale up ~1.35x within the band; Bloom `luminanceThreshold 0.85`, `intensity 1.8`; add `ChromaticAberration` (offset ~[0.0009, 0.0006]) and `Vignette` ONLY if it doesn't tint the transparent canvas rectangle (verify visually; if it does, skip vignette and say so).
3. Mood-reactive ambient: Field aurora gradients + Threads stroke/shadow color interpolate to `MOOD_TARGETS[mood].color` on `loom-mood` events (precompute color strings at mood-change, zero per-frame allocation — pattern: module-level current-color strings swapped on event). Aurora opacities 0.07/0.05 → 0.12/0.08. Threads idle alpha pulses 0.10–0.18 (sine, existing tick), focused thread width 1.5 → 2.5 and shadowBlur 8 → 14.
4. Micro-interactions (framer-motion where components already can, CSS otherwise): Companion bubbles entrance (`opacity 0→1, y 8→0`, spring, ONLY on newly-appended items — no re-animation of the whole log); Dock tiles `whileHover scale 1.18 / whileTap 0.92` + unapproved-dot CSS pulse; OrganWindow `transition: box-shadow var(--dur-fast)` + visible resize grip (three dots); permission modal entrance (scale 0.96→1 + fade); textarea focus ring (`box-shadow 0 0 0 1.5px var(--accent)` on focus state); LOOM wordmark `textShadow 0 0 12px` accent + header underline that transitions with moodColor; ambient mood glow alpha `12` → `1e` idle / `2a` during building-thinking-speaking; cursor spotlight alpha to 8%; Timeline `details` chevron rotation + commit rows fade-in.
5. Reduced-motion: every new animation honors prefers-reduced-motion (existing patterns).
- Tests: style/prop assertions for each mechanical change (bloom props, canvas alpha/style, aurora opacity values, thread constants, dock motion props presence, textarea focus handler, tokens used); mood-reactive color swap unit test on the event handler. Visual verification of #1/#2 is REQUIRED and reported (dev server + screenshot).

- [ ] Steps: failing tests → orb fixes (verify visually) → ambient mood-reactivity → micro-interactions → green + build → commit `feat(shell): the shell ascends — orb unclipped, mood-reactive void, micro-interactions`.

---

### Task 5: Kit v3 — rich instruments + DESIGN LANGUAGE v3 + showcase + proof

**Files:**
- Modify: `src/lib/organs/uikitSrc.ts` (+10 factories), `src/lib/organs/uikit.ts` (types), `src/lib/organs/uikit.test.ts`, `src/lib/loom/prompts.ts` (DESIGN LANGUAGE v3), `src/organs/seeds/{notes,timeline}.ts` (showcase upgrades), `src/selftest/loom.selftest.test.ts` (kit-v3 proof task)

**New factories (all srcdoc-safe, string-concatenated, SVG via createElementNS, CSS keyframes injected once like existing button styles):**
1. `tabs(labels, opts)` → `{ root, panels, onChange }` — pill tab row + panel container, closure state.
2. `barChart(data, opts)` — `[{label, value}]` SVG bars + value labels, accent fill, optional `color`.
3. `lineChart(series, opts)` — full-size multi-point polyline with area fill (gradient via SVG defs), min/max labels; single series is enough (YAGNI multi-series legend).
4. `gauge(value, max, opts)` — SVG arc (strokeDasharray) + centered stat, accent stroke.
5. `heatmap(values, opts)` — 7xN cell grid, alpha-scaled accent cells (habit/streak organs).
6. `dataGrid(columns, rows)` — div-based table, sticky-styled header row, hover highlight, column count driven by columns array.
7. `toggle(label, checked, onChange)` — styled track+thumb switch (transition transform).
8. `select(options, opts)` — styled native select matching kit theme.
9. `spinner(size?)` — CSS-animated ring (keyframes injected once).
10. `icon(name)` — 12-glyph inline-SVG set: check, x, plus, arrow, gear, clock, star, warn, info, copy, trash, refresh (path data as concatenated strings).
- KIT_TOKENS additions single-sourced; `LoomUiKit` type updated; uikit.test.ts covers each factory's DOM shape + one behavior each (tab switch, toggle flip, gauge arc length changes with value, dataGrid row count, icon returns svg).
- DESIGN LANGUAGE v3 in prompts.ts (keep tight, <1800 added chars): when to reach for charts (numbers over time → lineChart/spark; categories → barChart; progress-to-goal → gauge; daily habit → heatmap; tabular → dataGrid; multi-page → tabs), one-hero rule restated, icons for actions not decoration.
- Seeds showcase: notes hero + weekly heatmap of note activity; timeline uses dataGrid for commits. Settings untouched (just rebuilt in Phase 7).
- Selftest: `build-chart-organ` (REPS 3) — request a "weekly water intake dashboard with a chart and a goal gauge"; assert generated code references at least 2 of barChart/lineChart/gauge/heatmap/spark and passes the gate. Run the REAL selftest, report honest counts.

- [ ] Steps: failing kit tests → factories (byte-scan the string after EVERY factory: backtick/`${`/`</script`/non-ASCII) → types + docs → seeds → prompts → green + build → real selftest → commit `feat(atelier): kit v3 — charts, gauges, grids, tabs, icons; LOOM builds instruments`.

---

## Self-Review Notes
- T1's selftest task must not depend on prior local store state — it seeds its own records and cleans up.
- T3's `loom-fleet-activity` events and T1's experience recording both hook build completion — they touch different files (Companion vs build.ts) but T3 rebases on T1's build.ts changes; sequence is fixed T1→T3 so briefs carry the updated build.ts shape.
- T4's orb work requires VISUAL verification — mandated in the task text, cannot be signed off from jsdom alone.
- Kit v3 keeps chart factories dependency-free (SVG/DOM only); no canvas rAF hooks in v3 (YAGNI — CSS/SVG covers the wishlist's top uses without threatening the one-rAF rule).
- Fine-tuning itself (LoRA on local models) is explicitly OUT of this phase; the corpus export is the bridge. Noted for the roadmap.
