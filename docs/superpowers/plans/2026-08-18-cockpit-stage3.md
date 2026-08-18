# Cockpit Stage 3 Implementation Plan (Phase 11) — Craft

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise the bar. Redesign the Stage-2 chrome to bespoke quality (user verdict: "AI slop aside from the orb"), harden the backend so no raw error ever reaches the user, and ship the Terminal deck (Bloomberg-style markets surface). Every UI task in this phase carries a SCREENSHOT GATE.

**Architecture:** A written micro design language (this plan, below) governs all UI work. The WatchPanel/Constellation/chrome get redesigned against it. A hardening pass wraps every user-visible failure in intentional copy (no raw TypeErrors), adds an error boundary, and cleans console noise. The Terminal deck is a KERNEL deck (not an organ): a data-dense markets surface fed by Yahoo Finance quotes (the same keyless endpoint AUSPEX uses — read `public/decks/auspex/js/sectors.js` / finance code for the exact URL pattern) + AUSPEX finance-category stories via the existing watch sensor, rendered with LOOM's kit-v3 charts scaled up.

**Tech Stack:** existing stack only. No new deps.

## Global Constraints

- **THE SCREENSHOT GATE (mandatory, every UI task):** the implementer MUST run `npm run dev`, exercise the built UI in a real browser (playwright CLI `npx playwright screenshot` or macOS `screencapture` after opening the URL — any honest means), capture before/after screenshots to `/tmp/loom-t<N>-*.png`, LOOK at them, iterate until the result honors the design language, and state in the report exactly what was captured and what was corrected as a result. A task claiming visual quality without screenshot evidence is INCOMPLETE. The controller re-verifies independently.
- **Micro design language (binding for all new/edited UI):**
  - Spacing: 4px base grid. Component padding steps: 8/12/16/20. Section gaps: 12 or 16. Never odd one-off values.
  - Type hierarchy (mono = data, sans = prose): H-panel `11px mono, letterSpacing .12em, uppercase, color --t2`; data-primary `13px mono, --t1`; data-secondary `10px mono, --t3, letterSpacing .06em`; numbers ALWAYS mono with `fontVariantNumeric: tabular-nums`.
  - Surfaces: panels use `--glass-raised` + `--shadow-2` + 1px `--glass-border`; NEVER flat `--panel` for floating chrome. Radius: 10 for panels, 6 for rows/controls, 999 for pills. Hairline row dividers `--line`.
  - Interactive affordances: every button has hover (background step-up) AND active states via the shared `--dur-fast`/`--ease-out` tokens; icon buttons are 22x22 minimum hit area; kit `icon()` glyphs over ASCII letters wherever an icon exists (X → icon("x"), +W → icon("plus") + "watch").
  - Accent discipline: cyan is for LIVE/selected/primary only; #4ade80 only for confirmations/positive deltas; --danger for negative deltas/errors. Everything else neutral t1/t2/t3.
  - Motion: entrance = opacity+4px translate, `--dur-fast`; nothing animates without reduced-motion guard.
- Layout safety (new, from the clipping incident): global border-box + `overflow-x: clip` are LAW (already landed b999978); no element sets `width: 100%` alongside horizontal padding on the same box; fixed-position chrome must not sit inside any transformed ancestor (grep transform before adding fixed elements).
- Brand: navy #060b18, cyan #22d3ee, NO yellow, NO emojis anywhere.
- Failure copy: user-visible errors are written sentences in LOOM's voice ("The fleet is unreachable — is Ollama running?"), never raw exception text. Raw details go to console.debug only.
- Gates per task: `npm run check` + `npm run build` green; the screenshot gate for UI tasks; controller verifies counts and visuals independently.

---

### Task 1: De-slop — the Stage-2 chrome redesigned to the design language

**Files:**
- Modify: `src/components/WatchPanel.tsx`, `src/components/Constellation.tsx`, `src/components/FleetHUD.tsx`, `src/components/Shell.tsx` (top-bar composition), tests updated honestly.

**Requirements (against the micro design language, all screenshot-gated):**
1. **WatchPanel redesign:** panel surface `--glass-raised` + `--shadow-2`, radius 10, width 360, right 16 / top 72 / bottom 16 (breathing room from edges — NOT flush); header row: "THE WATCH" H-panel style + live dot (pulses on fresh salience, reduced-motion static) + icon close button; watchlist section: labeled "WATCHLIST" data-secondary, chips with kind-glyphs and hover-reveal remove; feed rows on the 4px grid: title data-primary (2-line clamp, not 1-line ellipsis — titles matter), meta row (source badge chip + age + category tint dot), score as a 2px accent bar with tabular-nums percentage at right, reasons expand with a rotating chevron (kit icon), row hover = background step-up; actions become icon buttons with title tooltips (open/watch/dismiss), revealed on row hover (always visible on touch/reduced-motion); empty state: centered, dim, "THE WATCH IS QUIET" + one-line explainer. Scrollbar styled thin (webkit).
2. **Constellation refinement:** node chips use the panel surface treatment (glass-raised, hairline border, 4px grid padding); labels 9px mono .1em; wires get a subtle gradient stroke (brighter near orb); packets slightly larger with a fading trail (SMIL, still no rAF); sensor pulse = ring expansion not opacity blink. Nodes reposition on an ellipse with MORE vertical spread so they don't collide with the orb glow at default size (verify in screenshot, idle + building moods, both decks).
3. **Top bar composition:** one consistent control row — deck controls and WATCH become ONE segmented glass pill group (VOID | GLOBE | INTERACT ⋮ WATCH n) with proper selected-state (accent underline or filled), spacing on the grid; FleetHUD chips aligned to the same height; wordmark + subtitle baseline-aligned. Everything visibly aligned in the screenshot at 1200 and 1600 widths.
4. Regression: void deck default look still calm; orb untouched; all existing behavior tests pass (update style assertions honestly).

- [ ] Steps: read design language → before-screenshots → failing/updated tests → redesign → after-screenshots at 1200+1600, iterate → green → commit `feat(craft): the watch chrome, redesigned — no more slop`.

---

### Task 2: Hardening — no raw errors, ever

**Files:**
- Create: `src/components/ErrorBoundary.tsx` (+ test) — glass card fallback ("Something broke in the shell — details in the console."), wraps Shell's zones (one boundary per zone so one crash doesn't take the app).
- Modify: `src/components/Companion.tsx` — turn-level catch maps known failure shapes to LOOM-voice copy: fleet unreachable ("The fleet is unreachable — is Ollama running?"), Tauri-less/browser ("This surface needs the desktop shell."), cloud-unavailable already handled; unknown → "The turn failed — details in the console." + console.debug(raw). The FailureCard NEVER renders a raw `TypeError:` string (regex-test in unit tests).
- Modify: `src/lib/core.ts` — invoke wrapper: when `window.__TAURI__` absent, reject with a typed `ShellUnavailableError` (message in LOOM voice) instead of `Cannot read properties of undefined (reading 'invoke')`.
- Console hygiene: boot the app (dev) and eliminate every console.error LOOM's own code emits in browser AND note the remaining third-party/AUSPEX ones in the report; downgrade LOOM's own expected-degradation logs to console.debug.
- Tests: boundary catches a thrown child; failure-copy mapping matrix; core invoke wrapper browser-mode rejection message.

- [ ] Steps: failing tests → ErrorBoundary → copy mapping → invoke wrapper → console sweep (screenshot/console-log evidence in report) → green → commit `fix(shell): hardened — every failure speaks LOOM's language`.

---

### Task 3: The Terminal deck — markets, Bloomberg-grade density

**Files:**
- Create: `src/lib/terminal/quotes.ts` (+ test) — Yahoo Finance quote fetcher (keyless endpoint; read AUSPEX's finance/ticker code in the bundle `public/decks/auspex/js/` for the exact URL + response shape; symbols: SPY QQQ DIA IWM + AAPL MSFT NVDA GOOGL AMZN META TSLA + ^VIX ^TNX GC=F CL=F BTC-USD; normalize `{symbol, price, chg, chgPct, spark?: number[]}`; 60s poll, hidden-pause, AbortSignal, error → keep-last + stale flag).
- Create: `src/components/decks/TerminalDeck.tsx` (+ test) — a KERNEL deck (`cockpit.deck` gains "terminal"): full-bleed dark surface UNDER the orb band (like GlobeDeck), composed as a dense grid (CSS grid, 4px gutters): (a) top ticker tape strip (marquee of quotes, chg-colored tabular-nums, CSS animation, reduced-motion static); (b) index cards row (kit-v3 style hero numbers + spark lines from intraday points if the endpoint provides, else drop sparks honestly); (c) movers table (dataGrid-style: symbol/last/chg/chgPct sorted by |chgPct|, positive #4ade80 negative --danger, tabular-nums everywhere); (d) macro strip (VIX/10Y/Gold/Oil/BTC as keyval chips); (e) FINANCE WIRE column: finance+geo-finance stories from the existing watch runtime (`getSalient` filtered category finance) with salience bars. All per the design language. Stale state: dim + "STALE" chip, never blank.
- Modify: deck plumbing — `cockpit.deck` union gains "terminal"; DeckLayer renders it; top-bar segmented control gains TERMINAL; deck_command rules: "show the terminal|markets|the tape" → terminal, existing globe/void rules untouched (tests).
- The quotes poller starts ONLY while the terminal deck is active (start/stop on deck events) — no background burn.

**Requirements:** screenshot gate at 1200+1600 (density without clutter — every number tabular, every alignment on the grid); works keyless/offline (stale-flag path screenshot too if feasible via devtools offline, else stated); no new intervals while deck inactive (test).

- [ ] Steps: failing tests → quotes lib → TerminalDeck → deck plumbing + intents → screenshots, iterate → green → commit `feat(cockpit): the terminal deck — the tape, live`.

---

### Task 4: Ship — docs, final review, merge, push

- README Stage 3 section (craft pass, hardening, terminal deck — honest); FOLLOWUPS prune + stage-4 backlog (EMBER deck, AGORA deck, globe fly-to, learned salience, watch-organ fetch permission, intraday sparks if endpoint permits).
- Full regression sweep; final whole-branch review (opus, with screenshots referenced); merge to main; push.

- [ ] Steps: docs → final review → merge → push → commit `feat(cockpit): stage 3 ships — craft`.

## Self-Review Notes
- T1 is a REDESIGN not a rewrite — behavior/tests preserved, presentation rebuilt. The screenshot gate is the enforcement mechanism for "not slop"; the design language section is the standard reviewers hold it to.
- T3 reads Yahoo endpoint details from AUSPEX's shipped code rather than guessing; if the endpoint shape differs from expectation the implementer adapts and documents.
- T2's invoke wrapper fixes the exact raw error the user saw in browser mode ("Cannot read properties of undefined (reading 'invoke')").
