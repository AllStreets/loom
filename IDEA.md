# LOOM — a sovereign, self-evolving computer

**Status:** ACTIVE — chosen as the flagship to build first (2026-08-11). Brainstorm → spec in progress.
**One-liner:** A personal computer that is also its own developer. Describe a capability in a sentence; it plans, writes, validates, and grows a new organ for itself — fully offline, no cloud, no subscription, yours forever.

## Thesis
You shouldn't rent your tools from the cloud. You should own one thing that becomes whatever you need — forever, even off-grid. Local coding models (qwen2.5-coder) crossed the reliability threshold in 2026, and EMBER's Forge already proved a local model can build and maintain real software offline **and verify its own work** (self-test: 21/21 replicable).

## The novel technical core
The app's own source is a first-class, versioned, self-testing artifact the local model edits under a proven reliability harness:
- plan → append-mode / SEARCH-REPLACE edit-blocks / step-decomposition (keeps model output small = no truncation)
- validate: syntax + runtime smoke-test (render module in a detached node) + shell-guard (can't drop core scripts)
- per-file apply with backups; per-file select + redo
- the model also authors TESTS for new capabilities; rollback/branching of its own "genome"

## Building blocks Connor already has
- EMBER Forge (self-editing engine, proven replicable) — the actual breakthrough, currently buried in a survival app
- Local LLM plumbing (Ollama, qwen2.5-coder), offline-first PWA + service worker
- Module registry pattern; agent orchestration (AgentZeus); ledger/undo + audit (AgentZeus/SMADP)

## The wow demo
Unplug the internet. Say one sentence. Watch LOOM plan, write, validate, self-test, and light up a working new tool in its own sidebar — offline, in front of you.

## Why now
Local coding models are finally good enough; Connor has the empirical reliability harness to prove trust. "Software that builds itself offline" makes people lean forward.

See sibling seeds: ../KEEL, ../PRISM, ../SIGNET.
