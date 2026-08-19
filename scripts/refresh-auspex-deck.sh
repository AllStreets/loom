#!/usr/bin/env bash
# refresh-auspex-deck.sh
# Syncs ~/Downloads/AUSPEX → public/decks/auspex/
# Excludes dev-only dirs/files that must not ship in the LOOM bundle:
#   .git .claude scripts supabase src package.json package-lock.json vercel.json
#   node_modules api/ worker/ tests/ sql/ docs/ keys.local.js
# Copies keys.local.empty.js as keys.local.js (keyless boot)
# LOOM-patched files (loom-adapter.js, LOOM-DECK-README.md, index.html) are
#   preserved from git after the sync so upstream changes don't clobber them.
# Idempotent — safe to run multiple times.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$HOME/Downloads/AUSPEX"
DEST="$REPO_ROOT/public/decks/auspex"
mkdir -p "$DEST"

# -- 1. Stash LOOM-patched files so rsync --delete doesn't lose them ----------
TMPDIR_LOOM="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_LOOM"' EXIT
for f in loom-adapter.js LOOM-DECK-README.md index.html; do
  [ -f "$DEST/$f" ] && cp "$DEST/$f" "$TMPDIR_LOOM/$f" || true
done

# -- 2. Sync upstream AUSPEX (excluding dev-only dirs/files) ------------------
rsync -av --delete \
  --exclude='.git' \
  --exclude='.claude' \
  --exclude='node_modules' \
  --exclude='api' \
  --exclude='worker' \
  --exclude='tests' \
  --exclude='sql' \
  --exclude='docs' \
  --exclude='scripts' \
  --exclude='supabase' \
  --exclude='src' \
  --exclude='package.json' \
  --exclude='package-lock.json' \
  --exclude='vercel.json' \
  --exclude='keys.local.js' \
  --exclude='vitest.config.js' \
  --exclude='.gitignore' \
  "$SRC/" "$DEST/"

# -- 3. Restore LOOM-patched files (never clobber with upstream versions) ------
for f in loom-adapter.js LOOM-DECK-README.md index.html; do
  [ -f "$TMPDIR_LOOM/$f" ] && cp "$TMPDIR_LOOM/$f" "$DEST/$f" || true
done

# -- 4. Copy keyless fallback as keys.local.js so the app boots without real keys
cp "$DEST/js/keys.local.empty.js" "$DEST/js/keys.local.js"

echo "[refresh-auspex-deck] Done. Bundle at $DEST"

# Re-apply the LOOM fly_to handle to the freshly-synced globe.js: the adapter's
# fly_to verb reads window._auspexGlobe, and upstream globe.js keeps G module-
# scoped. Anchored on the globe-wrap mount call inside initGlobe().
GLOBE_JS="$DEST/js/globe.js"
if ! grep -q "_auspexGlobe" "$GLOBE_JS"; then
  python3 - "$GLOBE_JS" <<'PYEOF'
import sys
p = sys.argv[1]
s = open(p).read()
anchor = "(document.getElementById('globe-wrap'));"
if anchor not in s:
    sys.exit("LOOM patch anchor not found in globe.js — upstream changed; re-anchor the fly_to handle manually")
s = s.replace(anchor, anchor + "\n\n  window._auspexGlobe = G; // <!-- LOOM --> fly_to access", 1)
open(p, "w").write(s)
print("LOOM fly_to handle re-applied to globe.js")
PYEOF
fi

echo 'refresh complete'
