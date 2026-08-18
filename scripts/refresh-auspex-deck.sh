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
  "$SRC/" "$DEST/"

# -- 3. Restore LOOM-patched files (never clobber with upstream versions) ------
for f in loom-adapter.js LOOM-DECK-README.md index.html; do
  [ -f "$TMPDIR_LOOM/$f" ] && cp "$TMPDIR_LOOM/$f" "$DEST/$f" || true
done

# -- 4. Copy keyless fallback as keys.local.js so the app boots without real keys
cp "$DEST/js/keys.local.empty.js" "$DEST/js/keys.local.js"

echo "[refresh-auspex-deck] Done. Bundle at $DEST"
