# Cockpit Stage 4a Implementation Plan (Phase 12) — Ownership

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended). Steps use checkbox (`- [ ]`) syntax.

**Goal:** The cockpit obeys its owner: the globe is interactive by default, the constellation can be turned off (and defaults off), organs can be deleted (with their trails), trails vanish when organs minimize, everything persists across app restarts, and Settings gains a reset-to-defaults. Plus: pay the Phase-11 review debts.

**Architecture:** All user-reported issues from 2026-08-18 screenshot session. Root-cause notes: gray right-band = pre-border-box horizontal overflow exposing Chrome's canvas (fixed at root in b999978; belt = navy html background). Threads persist for minimized organs because OrganWindow uses mount-once + display:none and windowRegistry keeps the entry.

**Tech Stack:** existing only.

## Global Constraints
- Micro design language + SCREENSHOT GATE from `docs/superpowers/plans/2026-08-18-cockpit-stage3.md` Global Constraints apply to ALL UI work in this phase (read them).
- Brand: navy #060b18, cyan #22d3ee, NO yellow, NO emojis. Layout law: border-box, no width+padding overflow, no fixed chrome under transformed ancestors.
- Settings whitelist pattern in `src/lib/voice/settings.ts`; seed organ srcdoc-safety (ASCII, no backticks/`${`/`</script`, data-actions, kit-composed).
- Destructive actions (organ delete, reset-to-defaults) require an in-UI confirm step; deletions must clean ALL organ residue: git-side files (organDelete command exists in core.ts), `loom.win.<id>`, organ storage keys (`organ.<id>.*` — check api.ts key() namespacing for the exact prefix), windowRegistry entry, open-window state, dock entry (organs-changed event refresh).
- Gates: `npm run check` + `npm run build` green per task; controller verifies + visually spot-checks.

---

### Task 1: Shell obedience — interact-by-default, constellation off-switch, trail hygiene, gray-band belt

**Files:** `src/styles/tokens.css` (html background belt), `src/components/Shell.tsx`, `src/components/decks/GlobeDeck.tsx` + `DeckLayer.tsx`, `src/components/Constellation.tsx`, `src/lib/voice/settings.ts` (+`cockpit.constellation`: "on"|"off" DEFAULT "off"; `cockpit.interact`: "on"|"off" DEFAULT "on"), `src/components/desktop/OrganWindow.tsx` (registry delete on minimize/collapse), `src/components/ambient/Threads.tsx` (only if needed), tests.

**Requirements:**
1. tokens.css: `html{background:var(--bg)}` — any future overflow reveals navy, never browser-canvas gray.
2. **Interact by default:** deck iframes get `pointerEvents: auto` whenever a deck is active and `cockpit.interact` is "on" (default). The INTERACT segment becomes a LOCK toggle (selected = interacting; clicking turns pointer-passthrough off for orb-hold-heavy sessions) and persists via the setting. Verify (tests + screenshot-gate note): orb hold/click still works (orb band z10 above deck), chat input works, WatchPanel works, dock works — the iframe only receives clicks on areas no LOOM chrome covers. Space-PTT-while-iframe-focused limitation: after any iframe interaction, clicking any LOOM surface must restore Space PTT (no code change needed if focus returns naturally — verify and document; if broken, add a shell click-catcher that refocuses window).
3. **Constellation:** render ONLY when `cockpit.constellation` === "on"; DEFAULT OFF (user verdict: clunky/in the way). Listens for `loom-settings-changed` (dispatch from settings seed via existing set path — check how settings changes propagate to kernel today; if no event exists, add one in the kernel settings.setSetting) so the toggle applies live without restart.
4. **Trail hygiene:** minimized organs must drop their thread — OrganWindow: on minimize (display:none path in Desktop) call `windowRegistry.delete(id)`, on restore re-`set(...)`. Find where minimize state lives (Desktop.tsx minimized set + display:none) and hook BOTH transitions. Organ delete (T2) already removes registry via unmount — verify. Tests: minimize → registry entry gone; restore → back; Threads renders no path for missing entries (existing behavior).
5. Settings seed Appearance page: "Constellation" on/off buttons (data-action constellation-on/off → sets `cockpit.constellation`) + "Globe interaction" on/off (sets `cockpit.interact`). Sandbox mock whitelists the new keys.

- [ ] failing tests → implement → screenshot-verify interact + constellation-off states → green → commit `feat(cockpit): the shell obeys — interact by default, constellation off-switch, honest trails`.

---

### Task 2: Organ lifecycle — delete with residue cleanup + reset-to-defaults + persistence audit

**Files:** `src/components/desktop/{Dock,Desktop,OrganWindow}.tsx`, `src/lib/organs/api.ts` + `src/lib/voice/settings.ts` (reset support), `src/organs/seeds/settings.ts` (System section), `src/lib/core.ts` (organDelete wrapper exists — verify), sandbox mock, tests.

**Requirements:**
1. **Delete UI:** OrganWindow title bar gains a small ✕-style delete affordance behind a hover-reveal (icon from chrome/icons.tsx pattern; NOT the minimize button) → inline confirm strip in the window ("Delete <name>? This removes its code and data." / DELETE / KEEP per design language) → on confirm: `organDelete(id)` → purge `loom.win.<id>` → purge organ storage keys (enumerate localStorage keys with the organ's storage prefix from api.ts `key()` — implement `purgeOrganStorage(id)` in api.ts or a lib helper) → windowRegistry.delete → close window state → dispatch organs-changed (dock refreshes). Seeds: deleting a seed organ is allowed (install.ts won't reinstall because installSeeds only runs on boot when the id is absent — VERIFY: if it re-seeds on next boot, record the deletion in a `loom.organs.deleted` tombstone list that installSeeds consults; implement whichever is needed for deletion to STICK).
2. **Reset to defaults:** Settings seed gains a "System" page/section: "Reset LOOM to defaults" button → confirm step → `loom.settings.resetAll()` (new settings-gated api): kernel clears ALL `loom.*` keys + settings keys + `auspex.tour.seen.v1` (so the deck tour returns) BUT NOT organ git files; then `location.reload()`. Tombstone list also cleared (deleted seeds return on reset — document this in the confirm copy: "Organs' code is kept; deleted seed organs will return."). Tests: resetAll clears the enumerated keys (mock localStorage), gated by settings permission, sandbox mock.
3. **Persistence audit (report section, fix gaps):** enumerate what survives an app restart TODAY (deck choice ✓, window positions ✓, watchlist ✓, experience ✓, ignition ✓, settings ✓) and what doesn't: `interactMode` (now persisted via T1 setting), WatchPanel open state (persist as `cockpit.watchOpen`? — YES, persist it), minimized-organ set (persist `loom.minimized` so restored sessions match). Implement the two new persists + tests.
4. Settings updated overall: Appearance (constellation/interact from T1), System (reset). Screenshot the new Settings pages.

- [ ] failing tests → delete flow → reset → persistence → screenshots → green → commit `feat(cockpit): organs are mortal, state is durable — delete, reset, persist`.

---

### Task 3: Phase-11 debts + ship

**Requirements:**
1. Add the two owed regression tests: `commands.test.ts` verbatim "show financial markets" → set_cat finance (not terminal); `quotes.test.ts` hidden-pause (document.hidden + visibilitychange → no fetch while hidden, resume on visible).
2. Final whole-branch review (opus) covering BOTH the Phase-11 merge range AND this phase's diff (state both ranges in the dispatch; the P11 review was deferred at merge — the reviewer is told this explicitly and reviews cumulative main..HEAD of this branch plus P11's key files list from its ledger entry).
3. README/FOLLOWUPS touch-ups for this phase's features (delete/reset/persistence/constellation-off default noted honestly).
4. Fix wave if findings → merge → push.

- [ ] tests → docs → final review → fixes → merge → push → commit `feat(cockpit): stage 4a ships — ownership`.

## Self-Review Notes
- Interact-by-default inverts a Stage-1 decision deliberately (user: "can't do anything on AUSPEX other than look at it"); the z-order already protects LOOM chrome, and the lock toggle preserves the old behavior.
- Constellation default-off responds to explicit user feedback; the feature stays one toggle away.
- Seed-deletion tombstones only exist if re-seeding actually occurs — the implementer verifies before building them.
