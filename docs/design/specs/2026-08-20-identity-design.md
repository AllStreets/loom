# LOOM Phase 16 — Identity (design)

**Date:** 2026-08-20 · **Status:** approved for planning

## Problem

LOOM's soul is unique — a computer that builds itself — but its surface reads borrowed. The brand is a letterspaced `<b>` tag and a leftover `vite.svg` favicon. The constellation (already off by default; owner verdict: clunky) decorates instead of meaning. The decks are other apps behind trigger phrases. Nothing on screen says *this machine weaves itself* except the README.

Phase 16 makes the identity load-bearing: one brand system on every surface, one signature feature only LOOM can have, one command grammar for the whole instrument.

## 1 · Brand system

**The glyph.** A woven monogram: vertical warp threads with one luminous weft thread weaving over-under through them, reading as both cloth and a rising waveform — *weave* and *loom into view*, the two meanings of the name. Accent cyan (`#22d3ee`) thread on navy (`#060b18`). Pure SVG, no raster.

**Surfaces unified (no exceptions):**
- `public/brand/loom-glyph.svg` — canonical mark; `public/favicon.svg` replaces `vite.svg` in `index.html` (plus `theme-color` + description meta). `vite.svg`/`tauri.svg` leftovers deleted.
- Top bar: glyph sits with the wordmark; same mood-glow treatment the wordmark already has.
- Ignition/boot: the glyph's weft thread draws itself across the warp during boot (reduced-motion: static glyph).
- Settings gains an ABOUT strip: glyph, name, one-line story, version.
- `docs/BRAND.md`: the identity codified — the name's double meaning, the voice (calm, sovereign, honest; failure copy discipline that already exists in code becomes written law), the token palette as the only allowed colors, glyph usage rules.
- README hero already matches the palette; keep, link BRAND.md.
- Tauri app icon regeneration from the glyph is a follow-up (needs raster pipeline), tracked in FOLLOWUPS.

## 2 · The Tapestry (replaces the constellation)

The constellation is removed — component, setting, tests. Its replacement is not decoration: **the Tapestry is LOOM's autobiography, woven**. Every LOOM weaves a different cloth because every LOOM lives a different life.

- **Data → threads (pure module `src/lib/tapestry/weave.ts`):**
  - warp (vertical, structural): timeline commits — the machine's own git history, one thread per recent commit, older = dimmer.
  - weft (horizontal, colored): organs (alive = accent-bright, deleted = faint scar), decks used, build experiences (successful weave = clean pass, repaired build = visible knot — honesty in cloth).
  - learned weights tint the weave: what the watch has learned about the owner shifts hue intensity per region.
- **Render:** a horizontal woven band (SVG) low behind the orb, `z` below chrome; hover names the thread ("organ · water-tracker · woven 3 days ago"; "commit a0cee82 · stage 6 ships"); click opens the organ or the timeline panel. Reduced-motion: static; otherwise a slow shimmer only (no packets, no orbits — the constellation's mistakes are not inherited).
- **Setting:** `cockpit.tapestry` on/off, default **on** (it is the brand). `cockpit.constellation` removed from settings and migrated: any stored value deleted on boot.
- **Empty state:** faint warp only + one line: "your tapestry begins when LOOM weaves its first organ."

## 3 · The Shuttle (one grammar, Cmd+K)

The shuttle is the part of a loom that carries the weft through the warp — here, the piece that carries *your intent* through the machine.

- **Command catalog (single source of truth):** `src/lib/shuttle/catalog.ts` exports every command LOOM understands — canonical phrase, aliases, description, group (DECKS / WATCH / BUILD / ORGANS / SYSTEM) — derived from the existing deck command rules and companion intents, plus organ open/build verbs. The catalog is data; voice rules and the palette both consume it, so they cannot drift.
- **Palette:** Cmd+K (or Ctrl+K) opens a glass overlay: input + grouped, fuzzy-filtered command list. Enter executes through the **same runtime path as voice** (`handleUtterance`-equivalent), so anything sayable is typeable and vice versa. Esc closes. Free text matching nothing falls through to the companion exactly like chat. Executing closes the palette; the orb pulses as it does for voice.
- **Voice gains discoverability:** "what can you do" / "help" speaks the group names and a few examples, generated from the catalog.

## Non-goals

New decks, new sensors, kernel self-modification, app-icon raster pipeline, any cloud anything.

## Testing

Pure modules (weave mapping, catalog derivation, fuzzy filter) unit-tested; Shuttle keyboard flows and Tapestry interaction via component tests; screenshot gate for every visual surface per the stage-3 design-language discipline; `npm run check` green per task.
