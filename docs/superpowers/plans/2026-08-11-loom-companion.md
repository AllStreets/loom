# LOOM Companion (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn LOOM from a build console into a **presence you live with**: a Companion you talk to that converses, builds new organs, and — new capability — **edits existing organs by sentence**, all through a deterministic-dominant prompt compiler. Ship seed organs so LOOM is useful on day one.

**Architecture:** A **prompt compiler** (`src/lib/compiler/`) turns each utterance into a routed, structured intent: deterministic normalize → intent classification (transparent rules first, rewriter-model fallback ONLY on low confidence) → slot extraction → a compiled, inspectable prompt. The **Companion runtime** (`src/lib/companion/`) routes intents: `converse` → companion model with a warm, concise persona and conversation memory; `build_organ` → the existing Loom; `edit_organ` → NEW edit pipeline (read organ files → SEARCH/REPLACE edit-blocks via the builder → same gate + repair → git commit). The **Companion UI** replaces the bare console with a chat surface (messages + inline build/edit progress + the review flow). **Seed organs** (Notes, Timeline viewer) are hand-authored organ files installed on first run through the SAME store/approval path as built organs.

**Tech Stack:** unchanged (Tauri v2, React+TS, vitest, Ollama fleet).

## Global Constraints

- Fully offline; localhost Ollama only; no cloud/telemetry.
- The compiler is **deterministic-dominant**: rules decide when confident; the rewriter model (`role: "rewriter"`) is consulted only when rules are unsure. Every compiled result carries `{ intent, confidence, source: "rules" | "model" }` and is inspectable.
- Organ edits ride the SAME safety rails as builds: gate (manifest guard + sandbox + tests) → repair rounds → optional review → git commit. Nothing un-green ever touches disk.
- Persona: warm, concise, capable — never robotic filler ("As an AI..."), never emojis. It speaks as **LOOM**. One short paragraph max for chat replies unless asked for more.
- Brand: cyan accent (`var(--accent)` #22d3ee); navy base; no yellow in brand surfaces.
- Enter submits, Shift+Enter newlines, everywhere text is entered.
- Seed organs install through `organWrite` + normal permission approval (they are NOT pre-granted).
- DRY, YAGNI, TDD, frequent commits.

---

## File Structure

```
src/lib/compiler/
├─ normalize.ts        # CREATE: fold/trim/despace; pure
├─ intent.ts           # CREATE: rule classifier + rewriter fallback; pure core
├─ compile.ts          # CREATE: compile(utterance, deps) -> Compiled (intent+slots+prompt)
└─ *.test.ts
src/lib/companion/
├─ runtime.ts          # CREATE: handle(utterance, deps) -> CompanionTurn (routes intents)
├─ persona.ts          # CREATE: LOOM's voice — system prompt + memory windowing
├─ editOrgan.ts        # CREATE: sentence -> edit-blocks -> gate/repair -> commit
└─ *.test.ts
src/components/
├─ Companion.tsx       # CREATE: chat surface w/ inline build/edit progress + review flow
└─ (LoomConsole.tsx absorbed; file deleted after parity)
src/organs/seeds/
├─ notes.ts            # CREATE: seed organ files (manifest/organ/test as exported strings)
├─ timeline.ts         # CREATE: timeline-viewer seed organ files
└─ install.ts          # CREATE: installSeeds(deps) — writes missing seeds via organWrite
src/App.tsx            # MODIFY: mount Companion; run installSeeds on boot
src/selftest/loom.selftest.test.ts  # MODIFY: + intent-compile and edit-organ tasks
```

---

### Task 1: Compiler — normalize + rule-based intent classifier (+ rewriter fallback contract)

**Files:** Create `src/lib/compiler/normalize.ts`, `src/lib/compiler/intent.ts`, tests for both.

**Interfaces:**
- `normalize(s: string): string` — trim, collapse internal whitespace runs to one space, strip zero-width chars, NFC. Pure.
- `type Intent = "build_organ" | "edit_organ" | "act_on_organ" | "converse"`
- `type IntentResult = { intent: Intent; confidence: number; organId?: string; source: "rules" | "model" }`
- `classifyByRules(utterance: string, organIds: string[]): IntentResult | null` — pure, transparent rules:
  - mentions an existing organ id/name fragment + a change verb (`add|change|make|remove|fix|update|rename|set|edit`) → `edit_organ` (confidence 0.9, organId set; the id match is a normalized substring match on id with `-`→` `).
  - starts with/contains build verbs targeting new capability (`build|create|make me|new organ|i want a|i need a`) AND no existing-organ mention → `build_organ` (0.85).
  - mentions an organ without a change verb (`open|show|use` or bare mention) → `act_on_organ` (0.7).
  - greetings/questions/opinions (`^(hi|hey|hello|thanks)`, `\?$` without organ/build markers) → `converse` (0.8).
  - otherwise → `null` (rules unsure).
- `classifyIntent(utterance, organIds, askModel: (prompt: string) => Promise<string>): Promise<IntentResult>` — rules first; on `null`, asks the rewriter with a strict one-line-JSON prompt (`{"intent":"...","organId":null}`) parsed tolerantly; unparseable → `converse` at 0.3, `source: "model"`.

**Steps (TDD):** write tests covering each rule (incl. "add a delete button to the water tracker" → edit_organ w/ organId "water-tracker" given `["water-tracker"]`; "build me a habit tracker" → build_organ; "hello there" → converse; ambiguous "water" alone → act_on_organ; rules-unsure path calls the mock model; garbage model reply → converse 0.3) → RED → implement → GREEN → `npm test` → commit `feat(compiler): normalize + transparent intent rules with rewriter fallback`.

---

### Task 2: Compiler — compile() with slots + inspectable output

**Files:** Create `src/lib/compiler/compile.ts` + test.

**Interfaces:**
- `type Compiled = { intent: Intent; confidence: number; source: "rules" | "model"; organId?: string; request: string; utterance: string }` — `request` is the cleaned instruction handed to downstream (for build/edit: the normalized utterance; for converse: the normalized utterance verbatim).
- `compile(utterance: string, organIds: string[], askModel): Promise<Compiled>` — normalize → classifyIntent → assemble. No hidden mutation; fully inspectable object.

**Steps:** verbatim tests (happy paths per intent; organId propagation) → implement (thin composition) → commit `feat(compiler): compile() — one inspectable object per utterance`.

---

### Task 3: Companion persona + runtime routing

**Files:** Create `src/lib/companion/persona.ts`, `src/lib/companion/runtime.ts` + tests.

**Interfaces:**
- `persona.ts`: `COMPANION_SYSTEM: string` — LOOM's voice: "You are LOOM — a sovereign, offline companion the user owns... warm, precise, brief (a short paragraph unless asked). Never say 'As an AI'. Never use emojis. You can build new organs and edit existing ones when asked — mention that only when relevant." Plus `windowMessages(history: Msg[], max = 16): Msg[]` (keep system + last N).
- `runtime.ts`:
  - `type CompanionDeps = { chat: typeof fleetChat; build: (request: string) => Promise<BuildResult>; edit: (organId: string, request: string) => Promise<BuildResult>; organIds: () => Promise<string[]>; askModel: (p: string) => Promise<string> }`
  - `type CompanionTurn = { kind: "reply"; text: string } | { kind: "build"; result: BuildResult } | { kind: "edit"; organId: string; result: BuildResult } | { kind: "act"; organId: string }`
  - `handle(utterance: string, history: Msg[], deps: CompanionDeps): Promise<CompanionTurn>` — compile → route: `converse` → `deps.chat("companion", [system+windowed history+user])` → reply; `build_organ` → `deps.build(request)`; `edit_organ` (organId!) → `deps.edit(organId, request)`; `act_on_organ` → `{kind:"act", organId}`; edit intent with no resolvable organId → converse reply asking which organ (via template string, no model call).

**Steps:** mocked-deps tests (converse routes to companion chat with system prompt first; build routes to build with the request; edit routes with organId; act returns act; edit-without-id returns a clarifying reply and calls NO model) → implement → commit `feat(companion): persona + routing runtime`.

---

### Task 4: editOrgan — sentence-driven edits on the same rails

**Files:** Create `src/lib/companion/editOrgan.ts` + test.

**Interfaces:**
- `type EditDeps = { chat: typeof fleetChat; read: typeof organRead; write: typeof organWrite; gate: typeof gate; onEvent?: (e: BuildEvent) => void; review?: (files: OrganFile[]) => Promise<boolean> }`
- `editOrgan(organId: string, request: string, deps: EditDeps): Promise<BuildResult>`:
  1. read `manifest.json`, `organ.js`, `test.js`;
  2. builder chat with `organSystemPrompt("edit")` + user: current organ.js + request → SEARCH/REPLACE blocks → `applyEditBlocks(code, raw)`; blocks null → one full-rewrite fallback via `organSystemPrompt("code")` w/ request+existing code; SEARCH mismatch throws → caught, one retry with the error appended;
  3. if the request plausibly changes behavior (always, v1): regenerate test *only if* gate then fails at tests — reuse the SAME two-round repair strategy by delegating to a shared helper. To keep DRY, EXTRACT the gate+repair loop from `build.ts` into `src/lib/loom/gateRepair.ts` (`runGateWithRepair(filesIn, organId, chatDeps, emit) -> {ok, code, tests, stage?, errors?}`) and use it from BOTH `buildOrgan` and `editOrgan` (refactor build.ts to consume it; all existing build tests must stay green unmodified except import paths).
  4. green (+review if provided) → `organWrite(organId, files, "loom: edit <id> — <request 60>")`; single-flight shared with builds (export the same busy flag via a small `src/lib/loom/flight.ts`: `withFlight<T>(fn): Promise<T | {busy:true}>` used by both).
- Manifest is NOT editable by this path in v1 (permissions can't silently grow): if the model's edit touches manifest.json it is ignored; manifest stays as read.

**Steps:** tests (happy edit: blocks applied, gate ok, write called with commit msg containing "edit"; blocks-null → full-rewrite fallback used; gate fail at tests → repair path exercised via shared helper mock; concurrent edit while build running → busy error; manifest passed through untouched) → implement + refactor build.ts to gateRepair/flight (keep green) → commit `feat(companion): editOrgan on the same gate+repair rails (shared, DRY)`.

---

### Task 5: Companion UI — the chat surface

**Files:** Create `src/components/Companion.tsx`; modify `src/App.tsx` (replace LoomConsole with Companion); DELETE `src/components/LoomConsole.tsx` after parity; adapt its useful pieces. Test `src/components/Companion.test.tsx`.

**Interfaces / contract:**
- A single conversation column (max-width 720): message bubbles — user right-aligned subtle panel, LOOM left with a small cyan dot avatar; timestamps in mono t3.
- Input: textarea, placeholder "Talk to LOOM — ask, or ask it to build or change an organ"; Enter submits, Shift+Enter newline; disabled while a turn is running.
- The **review toggle** (persisted, same key `loom.reviewBeforeSave`) lives in the surface header; the review Apply/Discard panel and inline build/edit event log render as special message cards inside the conversation (reuse the visual language from LoomConsole: event log block, success card "Built water-tracker — approve it below", failure card with stage + Retry).
- Wire `handle()` with real deps: `build: (req) => buildOrgan(req, {chat: fleetChat, write: organWrite, gate, onEvent, review?})`, `edit: (id, req) => editOrgan(...)`, `organIds` from `organList()` (parse manifests), `askModel` → `fleetChat("rewriter", ...)`.
- On successful build/edit: dispatch `organs-changed`; `act_on_organ` → scroll to / flash the organ card (dispatch `organ-focus` CustomEvent with the id; OrganHost adds a brief cyan outline on receipt).
- RTL tests (mock invoke + runtime): renders input; Enter submits and shows the user bubble + reply bubble (mock handle → reply); Shift+Enter does not submit; busy state disables input.

**Steps:** tests → implement → visual parity checklist against LoomConsole (event log, success, failure+Retry, review panel all present) → delete LoomConsole + update App test → `npm run check` green → commit `feat(companion): the presence — chat surface absorbs the build console`.

---

### Task 6: Seed organs — Notes + Timeline viewer

**Files:** Create `src/organs/seeds/notes.ts`, `src/organs/seeds/timeline.ts`, `src/organs/seeds/install.ts` + test; modify `src/App.tsx` (call installSeeds on boot).

**Interfaces:**
- Each seed exports `const files: { name: "manifest.json" | "organ.js" | "test.js"; content: string }[]` — hand-authored, contract-compliant organs:
  - **notes** (`id: "notes"`, permissions `["storage"]`): quick capture — input + Enter adds a note, list newest-first, delete per note, count; all styled with `loom.ui.tokens`, cyan accents. 2 real tests (adds a note to storage; renders existing notes).
  - **timeline** (`id: "timeline"`, permissions `[]`): displays a static explainer of the Timeline (this seed proves a zero-permission organ) with LOOM's principles; 1 test (renders heading). (Live commit list needs a core API surface for organs — deferred, noted in FOLLOWUPS.)
- `installSeeds(deps: { list: typeof organList; write: typeof organWrite }): Promise<string[]>` — for each seed whose id is NOT in `list()`, `write(id, files, "loom: seed <id>")`; returns installed ids. Never overwrites an existing organ (user may have edited it — their copy wins forever).
- App boot: `installSeeds(...)` before first `organs-changed`; failures logged, non-fatal.

**Steps:** tests (installs only missing; skips existing; content passes `manifestGuard`; notes organ.js/test.js pass a syntax `new Function` after export-strip like the selftest does) → implement → commit `feat(organs): seed organs — notes + timeline, installed through the front door`.

---

### Task 7: Selftest extension + docs + wiring pass

**Files:** Modify `src/selftest/loom.selftest.test.ts` (+2 tasks), `docs/FOLLOWUPS.md`, README roadmap row.

- New selftest tasks (REPS=3): **intent-compile** — 6 canned utterances through `classifyByRules` (no model; assert exact intents) plus 1 rules-unsure utterance through the REAL rewriter model asserting parseable intent JSON; **edit-organ** — real builder edit-blocks on the notes seed organ.js ("change the heading to 'My Notes'") → applies + contains "My Notes".
- Run `npm run check` AND `npm run selftest` for real; record honest counts in the commit message.
- Update README roadmap (phase 3 shipped), FOLLOWUPS (timeline-organ live-data API; embedding classifier upgrade path; persona tuning at orb phase).
- Commit `feat(companion): selftest coverage for compile + edit; phase 3 docs`.

---

## Self-Review

**Spec coverage:** prompt compiler deterministic-dominant w/ inspectable output (Tasks 1–2 — heuristic rules now, embedding upgrade tracked); Companion presence + routing + persona (Task 3); organ editing on the same rails, DRY via extracted gateRepair/flight (Task 4); chat surface with Enter/Shift+Enter + review flow (Task 5, user decisions honored); seed organs through the front door, never overwriting user edits (Task 6); real-model proof + docs (Task 7). Voice + orb remain phases 4–5.

**Placeholder scan:** contracts carry exact names/signatures; test intents enumerated; no TBDs.

**Type consistency:** `IntentResult/Compiled` shared via compiler exports; `BuildResult` reused from build.ts; `gateRepair` consumed by both build+edit; `Msg/OrganFile` from core.ts throughout.
