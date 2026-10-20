# LOOM Atelier (Phase 4.5: beautiful organs + the OS desktop) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give LOOM the power to **create beautiful UI itself from language** — a curated `loom.ui` design kit the builder model composes (organs are gorgeous by construction, not by luck) — and turn the organ area into an **OS-like desktop**: draggable glass windows, focus glow, a dock, persisted layout.

**Architecture:** The design kit is authored ONCE as a self-contained plain-JS source string (`uikitSrc.ts`, the shaders.ts pattern) so the SAME implementation runs in the host (`makeLoomApi` evaluates it) and inside the sandbox harness (embedded in the srcdoc) — organs see an identical `loom.ui` everywhere. The kit exposes DOM-factory primitives (card, heading, button, input, row, stat, progress, list, badge, empty) pre-styled in the navy/cyan glass language with hover/focus states and `data-action` support; it injects one `.lui-*` stylesheet per document. The ORGAN_CONTRACT is rewritten to teach composition ("build from loom.ui; ad-hoc styles only for layout") with a concrete beautiful example, and the notes seed becomes the exemplar. The **Desktop** replaces the organ list: each approved organ renders in a glass window (drag by title bar, z-order focus, minimize; position/size persisted per organ) over a desktop plane, with a bottom **dock** (one tile per organ, click to open/focus, badge for pending permission approvals as centered modals).

**Tech Stack:** unchanged (no new deps; drag via pointer events, springs via existing framer-motion).

## Global Constraints

- Fully offline; no new network/CDN/fonts. No emojis. Navy `#060b18` + cyan `#22d3ee`; NO yellow.
- The kit source must be **plain ES2019-compatible JS in a string** (no TS syntax, no imports) — it executes via `new Function` in the host and inside the sandbox iframe. Single source of truth: `UIKIT_SRC`.
- `loom.ui` keeps `tokens` (backward compatible — existing organs that only use tokens keep working) and gains the factories. The kit is permission-free (always available).
- Every interactive factory accepts `action` and sets `dataset.action` (the phase-4.5 selector contract continues).
- Windows: drag clamped to the desktop plane; z-order = last-focused on top; minimize → dock; positions persisted `localStorage["loom.win.<id>"]` as `{x,y,w,h,min}`; double-click title = collapse/restore. Reduced motion: no open/close springs.
- The sandbox harness embeds the SAME `UIKIT_SRC` — gate-time rendering must equal host-time rendering.
- DRY, YAGNI, TDD, frequent commits.

---

## File Structure

```
src/lib/organs/uikitSrc.ts   # CREATE: UIKIT_SRC string (plain JS: makeUi(tokens) factory) — single source
src/lib/organs/uikit.ts      # CREATE: host-side evaluate + typed wrapper: buildUiKit(tokens) -> LoomUiKit
src/lib/organs/api.ts        # MODIFY: inject ui = buildUiKit(TOKENS) (tokens preserved on ui.tokens)
src/lib/loom/sandbox.ts      # MODIFY: embed UIKIT_SRC in harness; freshLoom().ui = makeUi(tokens)
src/lib/loom/prompts.ts      # MODIFY: ORGAN_CONTRACT design-language rewrite + kit API docs + example
src/organs/seeds/notes.ts    # MODIFY: rebuild organ.js on the kit (exemplar); tests updated
src/components/desktop/
├─ OrganWindow.tsx           # CREATE: glass window — title bar, drag, focus, minimize, persist
├─ Dock.tsx                  # CREATE: bottom dock — organ tiles, focus/restore, permission badges
└─ Desktop.tsx               # CREATE: the plane — windows + dock + permission modals (replaces OrganHost list UI; reuses host loading/approval logic)
src/lib/organs/host.tsx      # MODIFY: extract reusable organ-loading hook (useOrgans) from OrganHost; keep exports
src/components/Shell.tsx     # MODIFY: organs area → <Desktop/>
src/selftest/…               # MODIFY: build-organ-code additionally asserts `loom.ui.` composition
```

---

### Task 1: The design kit (`uikitSrc.ts` + host wrapper)

**Interfaces:**
- `uikitSrc.ts`: `export const UIKIT_SRC: string` — defines `function makeUi(tokens) { ... return api; }` in plain JS. The api:
  - `ui.tokens` — the tokens object passed in.
  - `ui.heading(text, sub?)` → header block (17px 650 t1 + optional 12.5px t2 sub).
  - `ui.card(opts?)` → `{ root, body }` — glass panel (`rgba(13,20,36,.55)`, 1px `rgba(255,255,255,.08)` border, radius 12, padding 14; optional `opts.title` renders a mono uppercase 11px accent eyebrow).
  - `ui.button(label, opts?)` — variants `primary` (accent bg, `#04222b` text, hover brightness 1.1), `ghost` (transparent, 1px border, t1), `danger` (transparent, danger text); radius 8, padding 7x14, 600 weight, `transition .15s`, `opts.action` → dataset.action, `opts.onClick`.
  - `ui.input(opts?)` — dark field (`rgba(255,255,255,.05)` bg, focus border-color accent via injected `:focus` rule), radius 8, `opts.placeholder/action/onEnter` (Enter keydown → onEnter).
  - `ui.row(...children)` — flex gap 8 align-center; `ui.stack(...children)` — column gap 8.
  - `ui.stat(label, value)` — big mono value (20px accent) over 11px uppercase t3 label; `ui.setStat(el, value)` updater.
  - `ui.progress(pct)` → element with `.set(pct)` method — 6px track, cyan→ice gradient fill, width transition .4s, clamped 0..100.
  - `ui.list()` → `{ root, add(el), clear() }` — column gap 6.
  - `ui.listRow(text, opts?)` — panel row (padding 8x12, radius 8, hover bg lift) with text span; `opts.onRemove` adds a ghost danger "x" button `data-action="remove"` (or `opts.removeAction` name).
  - `ui.badge(text, tone?)` — pill (mono 10.5px uppercase; tones: accent/go/warn/danger/muted).
  - `ui.empty(text)` — centered t3 italic-free empty state.
  - One `<style id="lui-style">` injected per document (guard by id) containing the `.lui-*` classes incl. hover/focus rules (inline styles can't do those).
- `uikit.ts`: `export type LoomUiKit = { tokens: Record<string,string>; heading: ...; ... }` (typed surface) and `export function buildUiKit(tokens: Record<string, string>): LoomUiKit` — `new Function("tokens", UIKIT_SRC + "\nreturn makeUi(tokens);")(tokens)`.

**Tests (`uikit.test.ts`, jsdom):** buildUiKit returns all factories; button variants set dataset.action + correct class; input onEnter fires on Enter only; progress clamps + `.set` updates width; listRow onRemove wires `data-action="remove"` click; style tag injected exactly once across two builds; card title eyebrow renders; UIKIT_SRC contains no `import`/`export`/TS syntax (regex guards) and is ES2019-parseable (`new Function(UIKIT_SRC)` doesn't throw).

Gate: `npx vitest run src/lib/organs` green + `npm test` green. Commit: `feat(atelier): the loom.ui design kit — one source, host and sandbox`.

---

### Task 2: Kit everywhere — api, sandbox, contract, seed exemplar

**Contract:**
- `api.ts`: `ui: buildUiKit(TOKENS)` (replaces `ui: { tokens: TOKENS }`; `ui.tokens` still === TOKENS so old organs keep working).
- `sandbox.ts`: embed `UIKIT_SRC` into the harness (before `freshLoom`), `ui: makeUi(tokens)` inside `freshLoom()` (build the tokens object first, pass to makeUi; keep the same tokens literal). Harness stays one self-contained srcdoc.
- `prompts.ts` ORGAN_CONTRACT section 2 rewrite: document EVERY kit factory with one-line signatures; add a DESIGN LANGUAGE block: "Compose loom.ui primitives — never hand-roll styled divs. Ad-hoc style ONLY for layout spacing (margin/flex). One accent moment per organ (a stat, a progress, or a primary button — not all). Generous whitespace; small text is t2/t3; hierarchy = heading → content → actions. Empty states use ui.empty." Replace the code example with a compact beautiful organ using card/heading/input/button/list/listRow/stat. Code-kind system prompt gains: "Build the UI ONLY from loom.ui factories."
- `notes.ts` seed organ.js rebuilt on the kit (card + heading + input(action new-note, onEnter) + primary Add + list/listRow(remove) + count badge or stat); tests updated to the same assertions via data-action (should barely change).
- Selftest `build-organ-code`: add assertion `code.includes("loom.ui.")` (the model composes the kit) — run the REAL selftest to prove the 30B follows the new contract; report honest counts.

Gate: `npm run check` green; `npm run selftest` real run green (report counts). Commit: `feat(atelier): organs are beautiful by construction — kit in api, sandbox, contract, seed`.

---

### Task 3: The Desktop — windows + dock

**Contract:**
- Extract from `host.tsx` a hook `useOrgans()` returning `{ organs: OrganState[], approve(id), reload() }` plus the blob-import `mountOrgan(el, state)` helper (error-contained). OrganHost can remain as a thin legacy list (unused after Shell swap) or be deleted once Desktop is in — prefer DELETE (tests move to Desktop).
- `OrganWindow.tsx`: props `{ state, focused, onFocus, onMinimize, initial: {x,y,w,h} }`. Glass window (border-radius 14, `.glass`, focus ring `0 0 0 1px rgba(34,211,238,.35)` + soft shadow when focused); title bar (28px: organ name 13px 600, minimize ghost button `data-action="win-min"`); body hosts the organ mount div (overflow auto). Drag: pointerdown on title bar → setPointerCapture, move updates x/y clamped ≥0 and within parent bounds; persist on pointerup to `localStorage["loom.win.<id>"]`. Resize: a 14px bottom-right handle, same pattern, min 260x180. Double-click title → toggle collapse (body hidden, height auto) persisted as part of state.
- `Dock.tsx`: fixed bottom-center glass pill; one tile per organ (28px rounded square with the organ's initials, accent-tinted when open/focused, muted when minimized); click → restore/focus (or open modal if unapproved — badge dot `var(--warn)`→ actually use accent for pending); tooltip via `title=`.
- `Desktop.tsx`: relative plane (min-height ~60vh) hosting windows for approved+unminimized organs (default cascade positions 40+i*36), permission MODALS (centered glass card, same approve flow) for unapproved organs when their dock tile is clicked (and auto-open the first pending one on load), and the Dock. Listens `organs-changed` + `organ-focus` (focus/restore + flash). Windows mount organs via `mountOrgan` once per organ id (keep mounted while minimized — display:none — so organ state survives).
- `Shell.tsx`: replace the organs section with `<Desktop/>` (same width column can widen: desktop takes the full remaining width, maxWidth ~1100 centered).
- Reduced motion: no spring on window open; dock static.

**Tests (`desktop.test.tsx`, jsdom, mock invoke):** approved organ renders a window with its name + a dock tile; unapproved organ shows dock badge and clicking opens the permission modal, approve calls organ_grant; minimize hides the window (display none) but keeps it mounted (element still in DOM) and dock click restores; drag persistence: simulate pointerdown/move/up on title bar → localStorage `loom.win.<id>` written with new x/y (jsdom pointer capture: guard `setPointerCapture?.()`); `organ-focus` event focuses/restores the target window. Update Shell/App tests for the Desktop swap.

Gate: `npx vitest run src/components` + `npm run check` + `npm run build` green. Commit: `feat(desktop): organs live in draggable glass windows with a dock`.

---

### Task 4: Docs + final review + ship

- README: roadmap gains `4.5 · The Atelier | loom.ui design kit — organs beautiful by construction · OS desktop: windows + dock | **shipped**`; "How it weaves" section: one line about the design kit ("the builder composes a curated design kit — organs are born beautiful"). FOLLOWUPS: window snap/tiling, dock reordering, per-organ icons (model-chosen glyph), kit charts primitive, theme variables per organ.
- `npm run check` + `npm run build`; final whole-branch review (most capable model) → fix wave → merge to main → push.

---

## Self-Review

**Spec coverage:** "language → beautiful design" = kit + contract + prompts + seed exemplar + selftest proof (T1/T2); "OS-like environment" = windows/dock/persistence/modals (T3); UI update = desktop integration + polish (T3); ship (T4). Voice remains phase 5.

**Placeholder scan:** factory signatures, styling values, persistence keys, test cases specified. UIKIT_SRC plain-JS constraint stated with regex-guard tests.

**Type consistency:** `LoomUiKit` typed once in uikit.ts; `ui.tokens` backward-compat guaranteed; OrganState/useOrgans reuse host.tsx shapes; window persist shape `{x,y,w,h,min}` used by OrganWindow+Desktop.
