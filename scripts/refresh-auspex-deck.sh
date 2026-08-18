#!/usr/bin/env bash
# refresh-auspex-deck.sh
# Syncs ~/Downloads/AUSPEX → public/decks/auspex/
# Excludes: node_modules api/ worker/ tests/ sql/ docs/ keys.local.js
# Copies keys.local.empty.js as keys.local.js (keyless boot)
# Idempotent — safe to run multiple times.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$HOME/Downloads/AUSPEX"
DEST="$REPO_ROOT/public/decks/auspex"
mkdir -p "$DEST"
rsync -av --delete \
  --exclude='node_modules' \
  --exclude='api' \
  --exclude='worker' \
  --exclude='tests' \
  --exclude='sql' \
  --exclude='docs' \
  --exclude='keys.local.js' \
  "$SRC/" "$DEST/"
# Copy keyless fallback as keys.local.js so the app boots without real keys
cp "$DEST/js/keys.local.empty.js" "$DEST/js/keys.local.js"
echo "[refresh-auspex-deck] Done. Bundle at $DEST"
