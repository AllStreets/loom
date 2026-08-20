# EMBER Deck — LOOM Bundle Notes

## Source
~/Downloads/EMBER

## Refresh
```
bash scripts/refresh-ember-deck.sh
```

## Provenance
Snapshot taken 2026-08-18

## What was modified
Nothing. EMBER ships as-is; no adapter needed.

## Notes

### No command bridge
EMBER has no LOOM adapter — voice only switches to it (YAGNI).

### Ollama CORS
EMBER's Advisor and Forge call Ollama localhost:11434 from the iframe. Under
the deck:// origin (prod), Ollama's default CORS policy may reject these
requests. EMBER already degrades gracefully (LLM chip shows "offline").

FOLLOWUP: `OLLAMA_ORIGINS=deck://localhost` enables the Advisor in packaged
builds.

### Forge (File System Access API) — verified 2026-08-19
Forge's boot guard is `'showDirectoryPicker' in window` (js/forge.js). LOOM's
WebView is WKWebView (Tauri v2 on macOS), which does not implement the File
System Access API — so inside the deck iframe (dev AND packaged deck://
origin) the guard fails and Forge renders EMBER's own unsupported callout
("FORGE needs the File System Access API… use Chrome, Edge, or Brave").
Nothing breaks; the rest of EMBER is unaffected.

**Bottom line: Forge (self-editing) requires the standalone EMBER app in a
Chromium browser; the deck is read/advise mode.** A secondary guard in
`connect()` (blocks `file:` / non-secure contexts) is never reached here.

Edge case: if LOOM's Vite dev URL is opened directly in Chrome, the API
exists and Forge could technically connect — but it would edit LOOM's
bundled snapshot (this directory), which `refresh-ember-deck.sh` overwrites.
Not a supported flow. Forge-through-LOOM (a Tauri file bridge) is stage-7
backlog, see docs/FOLLOWUPS.md.

### sw.js excluded deliberately
A service worker inside the deck iframe would cache-fight the bundled copy;
EMBER runs fine without it when served.
