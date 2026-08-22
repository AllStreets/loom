# LOOM — the brand

One mark, one palette, one voice — on every surface. This document is law for
anything that renders or speaks as LOOM.

## The name

A *loom* weaves loose thread into cloth. To *loom* is also to rise into view — a
presence gathering on the horizon. LOOM is both: **a computer that weaves itself
into being, and grows into a presence you live beside.** Every brand decision
carries that double meaning.

## The glyph

A woven monogram: three dim vertical **warp** threads, one luminous cyan
**weft** thread weaving over-under-over through them and rising toward the
top-right — weave, and rise into view.

| File | Use |
| --- | --- |
| `public/brand/loom-glyph.svg` | canonical mark, transparent background — chrome, docs |
| `public/favicon.svg` | same art on a navy rounded square (`rx=7`, `#060b18`), weft thickened to 2.6 so it reads at 16px |
| `src/components/chrome/LoomGlyph.tsx` | the mark as a React component for kernel chrome — same geometry, colors mapped to tokens (warp `--t3`, weft `--accent`) so it can inherit mood glow |

**Usage rules**

- Clear space: keep at least half the glyph's width empty on every side.
- Never recolored off-palette. The two SVG files above are the only place raw
  hex is allowed — they *are* the brand definition (`#22d3ee` weft, `#3b4a66`
  warp, `#060b18` ground). Everywhere else the mark renders through tokens.
- Favicon variant (navy square) is for icon contexts — favicons, app icons,
  avatars. Chrome and documents use the transparent variant.
- The weft may draw itself once at boot (~1.2s ease-out, stroke-dash). Under
  `prefers-reduced-motion` the glyph is static. No other animation — the mark
  never spins, pulses, or orbits.
- The Tauri app icon rasters are regenerated from the glyph (tracked in
  `docs/FOLLOWUPS.md` — needs a PNG pipeline).

## The palette

The tokens in `src/styles/tokens.css` are the **only** allowed colors, in
product and in brand material alike.

| Token | Value | Role |
| --- | --- | --- |
| `--bg` | `#060b18` | the void — ground of every surface |
| `--panel` | `#0d1424` | raised panel |
| `--panel-2` | `#111a2e` | second panel step |
| `--line` | `rgba(255,255,255,.06)` | hairline rules |
| `--t1` | `#e8edf7` | primary text |
| `--t2` | `#9fb0cc` | secondary text |
| `--t3` | `#5f6f8c` | tertiary text · the warp in chrome |
| `--accent` | `#22d3ee` | the weft — LOOM's one luminous color |
| `--accent-soft` | `rgba(34,211,238,.12)` | accent wash |
| `--go` | `#4ade80` | healthy / present |
| `--warn` | `#f97316` | degraded / attention |
| `--danger` | `#f87171` | failed / destructive |
| `--glass` | `rgba(13,20,36,.55)` | glass surfaces |
| `--glass-raised` | `rgba(16,24,43,.85)` | raised glass |
| `--glass-border` | `rgba(255,255,255,.08)` | glass edge |

No new colors. No gradients outside mood glow. Accent is spent sparingly —
it means *alive*, not *decorated*.

## The voice

Calm, sovereign, honest. LOOM never markets to its owner.

**The copy law**

- Calm statements, lowercase-leaning. Chrome labels are uppercase mono
  (`VOID`, `WATCH`, `STILL DARK`); sentences are quiet and plain.
- No exclamation marks. Ever.
- Honesty over reassurance: name what happened, say what to do next, stop.
- Failure is stated in LOOM's voice — an em-dash hinge from fact to remedy.

**Real failure copy (already shipped, now law):**

> The fleet is unreachable — is Ollama running?
> — `src/components/Companion.tsx`

> Voice isn't set up — open Settings
> — `src/lib/voice/useVoice.ts`

> Something broke in the shell — details in the console.
> — `src/components/ErrorBoundary.tsx`

> THE CRYPTO FEED IS DARK — the source did not answer.
> — `src/components/decks/TerminalDeck.tsx`

That shape — fact, hinge, remedy — is the template for every error LOOM will
ever show.

**One-line story** (Settings ABOUT, docs): *a computer that weaves itself*.

**Meta description** (`index.html`): *A sovereign computer that weaves itself —
offline, local, yours.*
