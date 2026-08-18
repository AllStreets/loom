# AUSPEX Globe Deck — Bundled Snapshot

This directory is a committed snapshot of the AUSPEX static globe app,
bundled into LOOM as the first Sovereign Cockpit deck.

**Source:** ~/Downloads/AUSPEX (private upstream)
**Refresh:** `bash scripts/refresh-auspex-deck.sh` from the repo root
**Provenance:** Snapshot taken 2026-08-17; refresh after any upstream AUSPEX changes.

## What was modified
- `js/keys.local.js` — replaced with the empty keyless fallback (keys.local.empty.js)
- `index.html` — `<script src="loom-adapter.js"></script><!-- LOOM adapter -->` appended before </body>
- `loom-adapter.js` — added (LOOM-only bridge adapter; not present in upstream AUSPEX)

## Notes
- The AgentZeus bridge poller (localhost:3000) is NOT enabled by this bundle.
  It polls a remote HTTPS endpoint which silently fails when offline — acceptable.
- Keyed data feeds (AISSTREAM vessels, etc.) silently degrade when keys are absent.
  Public Supabase anon reads and USGS feeds work without keys.
- Space PTT: while the globe iframe has pointer focus (interact mode), the Space
  key is captured by the iframe — this is a documented stage-1 limitation.
