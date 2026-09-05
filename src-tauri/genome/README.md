# genome

Build output. `scripts/genome-bundle.mjs` (the first step of `beforeBuildCommand`)
writes `genome.bundle` and `genome.json` here so the packaged LOOM carries the
full git history it was woven from. Both files are gitignored; this README keeps
the directory present because Tauri's build script verifies every bundle
resource path at compile time.
