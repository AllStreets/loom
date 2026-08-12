<div align="center">

<img src=".github/assets/hero.png" alt="LOOM" width="100%"/>

### a sovereign, self-evolving computer

<em>offline &nbsp;·&nbsp; local models &nbsp;·&nbsp; it rewrites itself &nbsp;·&nbsp; yours</em>

&nbsp;

<img alt="vessel" src="https://img.shields.io/badge/vessel-Tauri_v2-22D3EE?style=for-the-badge&labelColor=060b18"/>
<img alt="runs" src="https://img.shields.io/badge/runs-100%25_offline-22D3EE?style=for-the-badge&labelColor=060b18"/>
<img alt="self-building" src="https://img.shields.io/badge/it-builds_itself-7DD3FC?style=for-the-badge&labelColor=060b18"/>
<img alt="selftest" src="https://img.shields.io/badge/real--model_selftest-12%2F12_reps-4ADE80?style=for-the-badge&labelColor=060b18"/>
<a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-Apache--2.0-4ADE80?style=for-the-badge&labelColor=060b18"/></a>

<br/>

<img alt="core" src="https://img.shields.io/badge/core-Rust_%C2%B7_git2-6b7382?style=flat-square&labelColor=060b18"/>
<img alt="ui" src="https://img.shields.io/badge/kernel-React_%C2%B7_Vite_%C2%B7_TS-6b7382?style=flat-square&labelColor=060b18"/>
<img alt="fleet" src="https://img.shields.io/badge/fleet-qwen3--coder_%C2%B7_gpt--oss_%C2%B7_qwen3-6b7382?style=flat-square&labelColor=060b18"/>
<img alt="sandbox" src="https://img.shields.io/badge/validation-sandboxed_%2B_self--repairing-6b7382?style=flat-square&labelColor=060b18"/>
<img alt="history" src="https://img.shields.io/badge/history-git_Timeline-6b7382?style=flat-square&labelColor=060b18"/>

&nbsp;

<a href="#what-this-is"><kbd> &nbsp; <b>What this is</b> &nbsp; </kbd></a> &nbsp;
<a href="#how-it-weaves"><kbd> &nbsp; <b>How it weaves</b> &nbsp; </kbd></a> &nbsp;
<a href="#anatomy"><kbd> &nbsp; <b>Anatomy</b> &nbsp; </kbd></a> &nbsp;
<a href="#the-fleet"><kbd> &nbsp; <b>The fleet</b> &nbsp; </kbd></a> &nbsp;
<a href="#quickstart"><kbd> &nbsp; <b>Quickstart</b> &nbsp; </kbd></a> &nbsp;
<a href="#roadmap"><kbd> &nbsp; <b>Roadmap</b> &nbsp; </kbd></a>

</div>

---

## What this is

A *loom* weaves loose thread into cloth. To *loom* is also to rise into view — a presence gathering on the horizon. **LOOM is both: a computer that weaves itself into being, and grows into a presence you live beside.**

You describe a capability in one sentence and press Enter. LOOM's local model plans it, writes the code **and its tests**, proves the whole thing inside a sandbox, repairs its own failures, commits the result to a git timeline, and asks your permission before the new organ runs — **fully offline, no cloud, no subscription, versioned so nothing is ever lost.** The grid goes down and it still evolves. You own it, and it becomes whatever you need. Forever.

> *You shouldn't rent your tools from the cloud. You should own one thing that becomes whatever you need.*

This is a proven idea, generalized. Its predecessor — the Forge engine inside **EMBER**, an offline survival console — first demonstrated that a local model can build and maintain real software offline and verify its own work. LOOM makes that engine the heart, hardened at every layer that ever failed.

---

## How it weaves

<img src=".github/assets/weave.svg" alt="How LOOM weaves an organ: your sentence, the builder writes three files, the gate validates in a sandbox with a repair loop, the timeline commits, you approve and it lives" width="100%"/>

The load-bearing idea: **the model's output stays tiny** (one file at a time, or a single edit region), and three independent walls stand between model output and your machine — the validation gate, the git timeline, and your permission. When a build fails, the errors go **back to the builder**, which fixes its own code — tests are treated as the spec, so "should not add an empty item" gets fixed in the code, not deleted from the tests.

An optional **Review code before saving** toggle adds a fourth wall: you read the three files and choose Apply or Discard before anything touches disk.

---

## Anatomy

<img src=".github/assets/anatomy.svg" alt="LOOM anatomy: a protected kernel hosting the orb, companion, loom, organ host, timeline and safe-boot, over a native Rust core with the model fleet, git timeline, organ store and offline voice" width="100%"/>

The kernel/organ split is load-bearing: the **kernel** is built, protected, and (in v1) only edited behind a gate; **organs** are no-build modules the Loom writes and rewrites freely, each isolated behind its own error wall and permission grant. Full self-modification — LOOM editing its own kernel — is a deliberate later flip of that guardrail, not a rebuild.

---

## The fleet

Three local specialists, resident together on 64GB — no swapping, no cloud, pinned in memory. A slow or absent model times out, retries once, then falls back — it never hangs the UI.

| role | model | Ollama tag | ~RAM | why |
|---|---|---|---|---|
| **Builder** — writes LOOM's own code | Qwen3-Coder-30B-A3B | `qwen3-coder:30b-a3b-q4_K_M` | 19 GB | MoE, 3B active → fast; 256K context |
| **Companion** — the always-on presence | gpt-oss-20b | `gpt-oss:20b` | 14 GB | quick, adjustable reasoning depth |
| **Rewriter** — the prompt compiler | Qwen3-1.7B | `qwen3:1.7b` | 1.4 GB | sub-second; restructures your words for the model |

If the configured builder is missing, LOOM automatically falls back to the **best installed coder model** before anything else — it degrades, it does not stop.

---

## Quickstart

> **Prerequisites:** [Node](https://nodejs.org) 20+, the [Rust toolchain](https://rustup.rs), and [Ollama](https://ollama.com). Everything runs on your machine — no keys, no accounts, no network.

```bash
git clone https://github.com/AllStreets/loom.git
cd loom && npm install

# pull the local fleet (once, ~35GB — the app runs without it; the fleet just shows offline)
ollama pull qwen3-coder:30b-a3b-q4_K_M   # builder
ollama pull gpt-oss:20b                  # companion
ollama pull qwen3:1.7b                   # rewriter

npm run check      # gate: vitest + cargo test
npm run selftest   # the whole pipeline vs the REAL local model (~2 min)
npm run tauri dev  # open LOOM
```

Type a sentence into The Loom — *"Build an organ that tracks my daily water intake with a goal and a progress bar."* — and press **Enter**. Watch it write, validate, repair if needed, and commit; approve the permission card and your new organ is alive.

---

## Roadmap

Built in phases, each a working, tested, reviewed milestone.

| phase | what | status |
|---|---|---|
| **1 · Foundation** | Tauri shell · Rust core · resident model fleet · git Timeline · CI | shipped |
| **2 · The Loom** | self-building engine: sandboxed validation · self-repair loop · permission-gated organs · review toggle · real-model selftest | **shipped** |
| **3 · Companion** | prompt compiler · the presence (text) · organ editing by sentence · seed organs | **shipped** |
| **4 · The orb + living UI** | react-three-fiber oracle-light orb · breathing motion · the living dashboard | next |
| **5 · Voice** | offline whisper.cpp + piper · push-to-talk · a voice loop that never half-works | next |
| **later** | the OS-like windowed desktop · full self-modification, kernel included | vision |

Design record: [`docs/superpowers/specs`](docs/superpowers/specs) · plans: [`docs/superpowers/plans`](docs/superpowers/plans) · tracked follow-ups: [`docs/FOLLOWUPS.md`](docs/FOLLOWUPS.md)

---

## Principles

- **Sovereign.** It runs on your machine, off the grid, forever. No cloud, no subscription, no telemetry, no wall.
- **Self-verifying before impressive.** Nothing goes live until it passes the manifest guard, a sandboxed render, and its own tests. A bad build is caught — then repaired — never shipped.
- **It can't strand you.** Every change is a git commit; a broken kernel boots into recovery and rolls back. You can always get home.
- **Alive, calm, yours.** A breathing, luminous presence — light that emerges from dark. It becomes what *you* need, not what an algorithm wants.

---

<div align="center">

The active flagship of four. **LOOM** builds itself · **KEEL** predicts the supply chain · **PRISM** shows where narratives diverge · **SIGNET** proves what's real.

<sub>Lineage: EMBER's Forge, generalized and hardened · design in <a href="docs/superpowers/specs">docs/superpowers/specs</a></sub>

</div>
