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

### Forge (File System Access API)
The File System Access API may be unavailable inside an iframe; EMBER degrades
per its own design.

### sw.js excluded deliberately
A service worker inside the deck iframe would cache-fight the bundled copy;
EMBER runs fine without it when served.
