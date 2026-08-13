# LOOM Vitality (Phase 6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make LOOM ship-ready as a public "beautiful black box": (1) the orb never leaves your sight and Settings is fully usable; (2) the builder masters simple organs (DOM-grounded tests — the movie tracker class must pass); (3) the void comes alive (threads of light, ambient depth, an ignition moment); (4) **LOOM is trained on the new beauty** — the kit, contract, and seeds grow in lockstep so organs inherit the revamp.

**Architecture:** T1 pins the experience: the layout becomes **viewport-stable** — the orb is a fixed presence (never scrolled away; conversation and desktop scroll inside their own regions), windows can't spawn under the dock, and organ windows get sane default sizes with internal scroll. T2 is the build-quality lever: the sandbox verdict now returns the organ's **rendered innerHTML** and structured per-test failures; `buildOrgan` becomes DOM-grounded — code is rendered in the sandbox FIRST (render-only probe), the REAL DOM goes into the tests-generation prompt, and repair prompts carry DOM + per-test detail; the contract gains canonical interaction patterns (multi-add, list indexing); repairs get a third round. T3 brings vitality: **threads of light weaving from the orb to open organ windows** (the loom made visible), an ambient particle field, aurora drift, and a first-boot ignition sequence. T4 trains LOOM: `loom.ui` v2 gains the revamp's primitives (hero stat, sparkline, keyval, divider, section, icon dots), the design language teaches them, and the seeds are upgraded to showcase — proven against the real builder. T5 ships it publicly.

**Tech Stack:** unchanged (canvas 2D for threads/particles — no new deps).

## Global Constraints

- The orb must be visible at ALL times in the main view — no interaction may scroll it away. Page-level scrolling of the whole shell is replaced by region scrolling (conversation, desktop, windows).
- Sandbox innerHTML capture is truncated to 3000 chars and sanitized into the verdict as `renderedHtml`; it exists for PROMPTS, and must never weaken the gate.
- Kit v2 must remain plain-ES2019 in UIKIT_SRC (same srcdoc-safety rules: no backticks, `${`, `</script`).
- All motion honors `prefers-reduced-motion`. Canvas layers: zero per-frame allocations, capped particle counts, pause when document.hidden.
- The movie-tracker acceptance case (T2) is run against the REAL builder and must pass end-to-end at least 2 of 3 reps before T2 closes; report honestly.
- DRY, YAGNI, TDD, frequent commits. No emojis. Navy/cyan.

---

### Task 1: Viewport stability + Settings usability (the pain fixes)

**Contract:**
- `Shell.tsx` layout rework: a fixed full-viewport shell (`height: 100vh; overflow: hidden`) with three zones: (a) top bar (fixed height); (b) the **orb hero — always visible** (fixed position/height band, never scrolls); (c) below it a **content region** that scrolls internally (`overflow-y: auto`) containing Companion + Desktop. The conversation's own log/message list keeps ITS internal scroll (Companion already auto-scrolls its log — verify it scrolls only its own box, never the page; fix any `scrollIntoView` that escapes to the page: use `scrollIntoView({ block: "nearest" })` or container-scoped scrolling).
- Desktop: plane gets a real height (fills remaining content region), windows clamp spawn positions so no window's title bar starts below `planeHeight - dockClearance` (dock clearance ~72px); dock zIndex above windows; default window size up from min — `w: 420, h: 360`; **Settings organ default `w: 560, h: 560`** (per-organ default override map in Desktop, keyed by id).
- OrganWindow: body `overflow: auto` (verify), so content is never clipped unreachably.
- Settings organ layout hardening (`seeds/settings.ts`): voice rows must not truncate — rows wrap (`flexWrap`), the Use/Audition buttons always visible; keep rows compact.
- Tests: shell regions (orb band present + content region has overflow-y auto); window spawn clamp (mock plane size, organ at index N never spawns under dock clearance); settings default size applied; Companion log auto-scroll does not call page-level scroll (assert `scrollIntoView` not used or called with nearest on the container).

Gate: `npm run check` + `npm run build` green. Commit: `fix(shell): the orb never leaves your sight — region scrolling, dock-safe windows, usable Settings`.

---

### Task 2: Builder mastery — DOM-grounded tests (the movie tracker must pass)

**Contract:**
- `sandbox.ts`: harness gains a render-only mode flag embedded per-run: `buildHarnessSrc(files, nonce, opts?: { probeOnly?: boolean })`. In BOTH modes, after the initial render, capture `el.innerHTML.slice(0, 3000)` as `renderedHtml` in the postMessage payload. probeOnly skips tests entirely (report `{ok: true, stage: "probe", renderedHtml, ...}` if render succeeded). `SandboxVerdict` gains `renderedHtml?: string`; `sandboxRun(files, timeoutMs?, opts?)` threads it through. `gate()` unchanged for full runs; add `renderProbe(files) -> {ok, renderedHtml?, errors}` helper in validate.ts (manifestGuard + probeOnly sandbox).
- `buildOrgan` flow upgrade (build.ts): manifest → code → **renderProbe** (fail → repair code round with render errors, re-probe once) → **tests generated WITH the real DOM**: the tests-gen user prompt now includes `The organ's ACTUAL rendered HTML (ground truth — target THESE elements):\n<renderedHtml>` → full gate → repairs (now THREE rounds max) where every repair prompt includes `renderedHtml` + structured per-test failures (name + error each on its own line).
- `prompts.ts` contract upgrades:
  - tests section gains CANONICAL PATTERNS: multi-add ("to add N items: set input.value, click add, then set value AGAIN before each further click — inputs clear after add"), list interaction ("re-query rows after every mutation; use querySelectorAll('[data-action=remove]')[i] freshly each time"), and "assert counts via loom.storage length, not DOM text".
  - organ.js section: after any mutation the organ re-renders its list; inputs clear after successful add (this makes the canonical pattern true).
- `gateRepair.ts`: 3 rounds; round targeting: tests-stage → round1 organ.js, round2 test.js, round3 organ.js again; every repair prompt includes renderedHtml when available (thread it via the files/verdict — re-probe after each code rewrite to refresh renderedHtml cheaply, or reuse the gate verdict's).
- Tests (mocked): verdict carries renderedHtml; buildOrgan sequence now includes the probe phase (chat/gate call-shape assertions updated); tests-gen prompt contains the probed HTML; 3-round repair behavior; probeOnly harness src contains the flag.
- **ACCEPTANCE (real model, this is the point):** extend the selftest with `build-movie-tracker` (1 rep is fine in the suite) AND run a 3-rep acceptance script of the FULL buildOrgan flow headlessly? Full flow needs the sandbox (browser) — so acceptance = extend `npm run selftest` with the pieces it CAN do (tests-gen WITH a real DOM snippet included → assert the generated tests only reference selectors present in that DOM) + a manual/real-app check: run the movie-tracker prompt in the app. Report honestly what was verified where.

Gate: `npm run check` green; real selftest green incl. new task. Commit: `feat(loom): DOM-grounded test generation + three-round repairs — the builder sees what it built`.

---

### Task 3: Vitality — life in the void

**Contract:**
- `src/components/ambient/Threads.tsx` — **the loom made visible**: a full-content-region canvas drawing 1-3 slow luminous bezier threads from the orb's position to each OPEN organ window's title bar (positions via refs/rects registered by Desktop), gently undulating (time-based sine offsets), cyan at ~12% opacity, brightening briefly (~40%) when that organ's window is focused or an organ-focus flash fires. Threads redraw on rAF; skip entirely under reduced motion (static faint lines) or when hidden.
- `src/components/ambient/Field.tsx` — ambient depth: a fixed background canvas with ~90 slow drifting particles (1-2px, cyan/white at 4-8% opacity, subtle parallax by depth), plus 2 large aurora radial gradients that drift over minutes (CSS keyframes, not canvas). Density halves under reduced motion (static render).
- **Ignition** (first-boot moment): on app start, a 1.8s sequence — black void → the orb fades/blooms in (scale 0.6→1 with glow surge) → top bar and panels spring in staggered. Runs when `localStorage["loom.ignited"]` unset OR always-on-launch but shortened (0.9s) — implement full on first run, subtle (0.6s fade) on later launches. Reduced motion: simple fade.
- Shell composition: Field behind everything, Threads inside the content region above the desktop plane but below windows' pointer targets (`pointer-events: none`).
- Perf: both canvases share one rAF budget (single loop in a small `ambientLoop.ts` with subscriber pattern), pause on `visibilitychange`.
- Tests: ambientLoop subscribe/pause logic (pure); Threads geometry helper (`threadPath(from, to, t)` pure — returns control points, undulation bounded); ignition flag logic; reduced-motion renders static (component test with mocked matchMedia).

Gate: `npm run check` + `npm run build` green. Commit: `feat(vitality): threads of light, ambient field, ignition — the void breathes`.

---

### Task 4: Train LOOM on the new beauty — kit v2 + contract v2 + seed showcase

**Contract:**
- `uikitSrc.ts` v2 (same plain-JS constraints) — new factories mirroring the revamp's language:
  - `ui.hero(value, label)` — big luminous stat (28px, accent glow text-shadow) for an organ's ONE hero number.
  - `ui.spark(values, opts?)` — tiny inline SVG sparkline (60x18, accent stroke, no deps; values array normalized; `.update(values)` method).
  - `ui.keyval(pairs)` — aligned key/value rows (mono keys t3, values t1).
  - `ui.section(title)` — spaced section divider with mono uppercase label + hairline.
  - `ui.dot(tone)` — 8px status dot (tones like badge).
  - `ui.toolbar(...children)` — right-aligned action row for card headers.
- `uikit.ts` types + tests for each (incl. spark normalization + update; ES2019 guards still pass).
- `prompts.ts` DESIGN LANGUAGE v2: teach the hero pattern ("every data organ earns ONE hero moment: ui.hero or ui.progress — never more"), spark usage for trends, section rhythm, and compose-don't-invent reaffirmed. Contract factory list updated.
- Seeds upgraded as the showcase: **notes** (hero count + spark of last-7-days activity), **settings** (sections + dots for statuses), **timeline** (keyval + section) — each remains gate-valid.
- **Real-model proof:** selftest build-organ-code asserts the model uses at least one v2-or-v1 kit factory (existing assertion covers) + add a `build-dashboardy-organ` selftest rep (prompt: "build an organ showing my daily step count with a goal") asserting `ui.hero` OR `ui.progress` OR `ui.stat` appears — the model reaches for the hero pattern. Run the real selftest; report counts.

Gate: `npm run check` green + real selftest green. Commit: `feat(atelier): kit v2 — LOOM learns the new beauty (hero, spark, sections)`.

---

### Task 5: Public black-box polish + ship

- First-run experience: seeds install quietly; ignition plays; Companion greets once ("Hold the orb and ask me to build something.") via a static first message (no model call) when no history.
- README: refresh hero section wording for public arrival; add a "First five minutes" section (install → pull fleet → voice setup → hold the orb); roadmap adds `6 · Vitality — shipped`; screenshots note (placeholder paths ok, user captures real ones).
- Repo hygiene: `.github/assets` sizes sane; no stray files; FOLLOWUPS updated (self-recursive kernel editing as the flagged next horizon).
- Final whole-branch review (most capable model) → fix wave → merge → push.

---

## Self-Review

**Spec coverage:** orb-always-visible + no view drift + Settings usable (T1 — the user's immediate pains); builder handles simple organs via DOM-grounded tests + canonical patterns + 3 rounds, acceptance on the real failing case (T2); life in the void with the loom-thread metaphor + ignition (T3); LOOM trained on the new beauty — kit/contract/seeds in lockstep, proven on the real model (T4); public black-box readiness (T5). Full self-recursion is explicitly the next horizon (FOLLOWUPS), not this phase.

**Placeholder scan:** factory signatures, canvas budgets, verdict field, prompt-flow restructure, and acceptance criteria specified; the genuinely-uncertain acceptance (full flow needs a browser) states exactly what is verified where.

**Type consistency:** `SandboxVerdict.renderedHtml` threaded gate→buildOrgan→gateRepair; kit v2 types extend LoomUiKit; Desktop default-size map keyed by organ id; threadPath/ambientLoop pure and typed.
