# Cockpit Stage 4b Implementation Plan (Phase 13) — More Decks

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps.

**Goal:** Two more portfolio surfaces dock into the cockpit: EMBER (the offline survival console — the failsafe deck) and AGORA (the conviction-market engine — the exchange deck).

**Architecture:** EMBER is fully static/offline → bundled snapshot exactly like the AUSPEX pattern (`public/decks/ember/` + refresh script + iframe + deck:// resources in prod). AGORA is a locally-run Next.js app (web :3000 + engine ws :8080 + Postgres) → its deck is a DOCK: an iframe pointing at a configurable local URL with an honest, designed offline state when unreachable (start instructions in LOOM voice). Deck plumbing extends to five decks.

**Tech Stack:** existing only.

## Global Constraints
- Micro design language + SCREENSHOT GATE (`2026-08-18-cockpit-stage3.md` Global Constraints) bind all UI.
- Deck patterns from GlobeDeck are the reference: bundled-static pattern (refresh script excludes junk; LOOM-DECK-README; adapter only if needed; keyless boot), origin isolation via deck:// resources in prod, iframe pointerEvents follow `cockpit.interact`, mount/load-gated messaging if commanding is added (EMBER/AGORA get NO command bridge v1 — YAGNI).
- PAINT DISCIPLINE (from the flicker saga, binding): nothing LOOM-owned may paint per-frame above a deck; new decks inherit the quiesced shell automatically — do not add per-frame painters.
- Deck plumbing checklist per new deck: DeckId union, `cockpit.deck` ALLOWED, DeckLayer branch, Shell SegBtn, commands.ts show/hide rules (CAT_RE precedence preserved — regression tests), deck_command few-shot (+1 each max), README.
- Brand/no-emoji; gates `npm run check` + build green; controller verifies + screenshots.

---

### Task 1: EMBER deck — the failsafe

**Files:** `scripts/refresh-ember-deck.sh` (from ~/Downloads/EMBER: index.html css/ data/ js/ icon.svg manifest.webmanifest; EXCLUDE _forge_backups node_modules sw.js serve.command forge-selftest.mjs .git — NOTE sw.js excluded deliberately: a service worker inside the deck iframe would cache-fight the bundled copy; EMBER runs fine without it when served); `public/decks/ember/**` committed snapshot + LOOM-DECK-README.md; `src/components/decks/EmberDeck.tsx` (+ test) — iframe like GlobeDeck minus command queue (no bridge), sandbox="allow-scripts allow-same-origin" (its Ollama fetch + localStorage need it; document); deck plumbing per checklist ("show ember|survival|the failsafe" → ember); tauri.conf resources entry for `decks/ember`; deckserve already serves the whole decks dir? — VERIFY deckserve maps `deck://localhost/<path>` from resource `decks/auspex` specifically; generalize to serve `decks/<deckname>/...` with the deck name as first path segment (auspex URLs keep working — update GlobeDeck DECK_URL accordingly if the path shape changes; keep backward-compat simplest: serve from `decks/` root and prefix paths `auspex/...` / `ember/...`).
**EMBER-specific:** its Advisor/Forge call Ollama localhost:11434 from the iframe — under deck:// origin Ollama's CORS may reject (OLLAMA_ORIGINS default). Do NOT hack around; EMBER already degrades (LLM chip offline). Document in LOOM-DECK-README + FOLLOWUPS ("OLLAMA_ORIGINS=deck://localhost enables the advisor in prod"). Forge (File System Access API) inside iframe: may be unavailable — EMBER hides/degrades per its own design; verify it doesn't hard-crash (screenshot).
Screenshot gate: ember deck at 1200+1600 (its amber firelight theme inside LOOM's navy chrome — verify legibility of LOOM top bar over it; the deck-active top-bar ground from Phase 12 should handle it).

- [ ] tests → refresh script + snapshot → EmberDeck + plumbing + deckserve generalization → screenshots → green → commit `feat(cockpit): the failsafe deck — EMBER docks`.

---

### Task 2: AGORA deck — the exchange dock

**Files:** `src/components/decks/AgoraDeck.tsx` (+ test); settings key `deck.agora.url` (free-text URL, default `http://localhost:3000`, validated http(s)://localhost or 127.0.0.1 ONLY — remote URLs rejected v1, sovereignty + iframe safety); deck plumbing per checklist ("show agora|the exchange|markets floor" → agora — CAREFUL: "markets" already routes terminal; use distinct phrases + precedence tests); Settings seed gains the URL field in a small "Decks" section (System page or new; write-only style not needed — plain input + save).
**Behavior:** on activation, probe the URL (fetch HEAD/GET with 2s timeout, no-cors mode caveats — a no-cors opaque response still proves reachability); reachable → iframe (pointerEvents per cockpit.interact; sandbox allow-scripts allow-same-origin allow-forms); unreachable → designed offline card (glass, design language): "AGORA is not running. Start it: cd ~/Downloads/AGORA && npm run dev — engine + web + Postgres required." + RETRY button. Re-probe on RETRY and on deck re-activation. No polling loop while unreachable (probe on demand only).
Screenshot gate: offline card state (always reproducible) + live state if AGORA happens to be running (do NOT start Postgres/engine yourself — offline card is the acceptance state; note if live was captured).

- [ ] tests (probe logic mocked, URL validation matrix, offline card, plumbing regressions) → implement → screenshots → green → commit `feat(cockpit): the exchange dock — AGORA berths`.

---

### Task 3: Ship

README (two decks, honest about AGORA-requires-local-run + EMBER advisor CORS note), FOLLOWUPS (prune; keep stage-5: LOOM-owned quote proxy, globe fly-to, learned salience, AGORA engine health strip, EMBER Forge-in-deck story), final whole-branch review (opus), fixes, merge, push.

- [ ] docs → final review → fixes → merge → push → commit `feat(cockpit): stage 4b ships — five decks`.

## Self-Review Notes
- deckserve generalization is the only risky refactor — auspex path compat is test-guarded.
- AGORA localhost-only URL validation prevents the deck becoming an arbitrary-site iframe.
- Neither new deck gets a command bridge; voice only switches to them (YAGNI until use proves need).
