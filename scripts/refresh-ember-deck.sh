#!/usr/bin/env bash
# refresh-ember-deck.sh
# Syncs ~/Downloads/EMBER → public/decks/ember/
# Excludes dev-only dirs/files that must not ship in the LOOM bundle:
#   .git node_modules _forge_backups serve.command forge-selftest.mjs
#   sw.js — service worker inside the iframe would cache-fight the bundled
#            copy; EMBER runs fine when served without it
# No keys to copy (EMBER has no keys.local.empty.js)
# No LOOM-patched files to stash (EMBER needs no adapter)
# Simply rsync the allowed files to public/decks/ember/
# Idempotent — safe to run multiple times.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$HOME/Downloads/EMBER"
DEST="$REPO_ROOT/public/decks/ember"
mkdir -p "$DEST"

# -- Sync upstream EMBER (excluding dev-only dirs/files) ----------------------
rsync -av --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='_forge_backups' \
  --exclude='serve.command' \
  --exclude='forge-selftest.mjs' \
  --exclude='sw.js' \
  "$SRC/" "$DEST/"

echo "[refresh-ember-deck] Done. Bundle at $DEST"
