# LOOM v1 — Design Spec

**Date:** 2026-08-11
**Status:** Approved design (brainstorm complete). Next: implementation plan.
**One-liner:** A sovereign, self-evolving personal computer — a place you live in that grows around one person, fully offline, that rewrites itself on command.

---

## 1. Purpose & scope

LOOM is a **personal daily driver** you talk to and shape. You describe a capability in plain language; LOOM plans, writes, validates, self-tests, and grows a new **organ** for itself — offline, no cloud, no subscription, versioned so nothing is ever lost. It is a **companion + workspace**: a persistent presence (text **and** voice) you can address, plus a growing desktop of organs you use directly. The presence recedes when you work and returns when you call it.

The thesis: *you shouldn't rent your tools from the cloud; you should own one thing that becomes whatever you need — forever, even off-grid.* EMBER's Forge already proved a local model can build and maintain real software offline and verify its own work (self-test 21/21). LOOM generalizes that engine from a hidden feature into the heart of the system.

### v1 success criteria
1. Runs fully offline as a real macOS app (Tauri) — dock icon, own window, background-capable.
2. You can say/type a request and LOOM builds a **working, validated organ** live, and it appears in your workspace.
3. Voice works **elegantly and reliably** (never half-working) alongside text.
4. Self-modification is **safe**: every change is git-versioned, organs are sandbox-validated before going live, and LOOM can never permanently brick itself (safe-boot recovery).
5. It looks and feels **alive** — a breathing, luminous, "oracle-light" orb and a living UI that produces genuine wow.

### Non-goals for v1 (YAGNI)
- No multi-user, no cloud sync, no accounts, no marketplace.
- No full self-modification of the kernel (gated in v1; architected as a later permission flip).
- No OS-like multi-window desktop yet (architected toward it; v1 is a single adaptive surface).
- No frontier/cloud models (local-only).

---

## 2. Locked decisions

| Decision | Choice |
|---|---|
| Identity | Personal sovereign daily driver ("your computer that grew around you") |
| Vessel | **Tauri** desktop app (thin Rust core + web UI); architected toward an OS-like future |
| Interaction | **Companion + workspace** (presence you talk to + growing desktop of organs) |
| Self-mod depth (v1) | **Tiered**: organs freely; kernel behind a gate + safe-boot. Full self-mod = later permission flip |
| Kernel UI stack | **React + Vite + Tauri** (needed for the r3f orb + motion). Organs stay **no-build** |
| Voice | **Text AND voice in v1**, first-class and robust (local STT/TTS). Must never half-work |
| Versioning | **git** is the Timeline (branches, diffs, one-click rollback) |
| Models | **3-model resident fleet** via Ollama (see §4) |

---

## 3. Architecture overview

LOOM is a small **protected kernel** hosting a **growing body of organs**, with a **Companion** you talk to, a **Loom** that weaves organs, a **Prompt Compiler** in front of every model call, and a **Timeline** recording everything.

```
┌──────────────────────────── LOOM (Tauri app) ────────────────────────────┐
│  KERNEL  (React+Vite, built, PROTECTED, gorgeous)                         │
│  ├─ Orb + living UI (react-three-fiber, framer-motion, glass)             │
│  ├─ Companion      (presence: routes utterances → act / build / converse) │
│  ├─ Prompt Compiler (utterance → perfect model-specific prompt)           │
│  ├─ The Loom        (self-building engine: plan→edit→validate→self-test)  │
│  ├─ Organ Host      (registry, router, per-organ error boundary)          │
│  ├─ Timeline        (git-backed history, diff, rollback)                   │
│  └─ Safe-boot       (recovery shell if the kernel fails to load)          │
│                                                                           │
│  ORGANS  (no-build JS modules, FREELY self-editable, hot-loaded)          │
│  └─ {manifest, code, data, tests}  ·  render via LOOM UI kit + tokens     │
│                                                                           │
│  RUST CORE (Tauri)                                                         │
│  ├─ Native filesystem (organ + kernel source, git ops)                    │
│  ├─ whisper.cpp  (offline STT)      ├─ piper (offline TTS)                 │
│  ├─ Ollama bridge (fleet mgmt, keep_alive)                                │
│  └─ Worker/sandbox host for smoke-tests                                    │
└───────────────────────────────────────────────────────────────────────────┘
                         Ollama (local) ── 3-model fleet
```

**The kernel/organ split is load-bearing** and resolves the build-step tension: the kernel is a *built* React app (gorgeous, protected, gated self-mod because it has a build step); organs are *no-build* JS modules the Loom writes and hot-loads at runtime (trivially self-editable, validated, isolated). "Full self-mod later" = teaching the Loom to also edit + rebuild the kernel.

### Component contracts (what / interface / depends on)

- **Kernel** — hosts everything; owns layout, routing, state, safe-boot. *Protected*: LOOM proposes kernel edits only behind an explicit gate. Depends on: Rust core, Ollama.
- **Organ Host** — registry (`LOOM_MODULES` pattern from EMBER) + router + **per-organ error boundary** (a crashing organ shows an error card, never takes down the kernel). Interface: `register({id,label,icon,render,manifest})`, `mount(id, container)`. Depends on: nothing else.
- **The Loom** — turns a request into validated file changes to organs (v1) or gated kernel changes. Interface: `build(request) → Plan`, `run(Plan) → Result[]` (per-file: base/text/validation/steps). Depends on: Prompt Compiler, Ollama, Timeline, sandbox.
- **Prompt Compiler** — utterance → `CompiledPrompt`. Interface: `compile(utterance, targetModel) → CompiledPrompt` (viewable/editable). Depends on: classifier + rewriter model + template registry.
- **Companion** — persistent presence; routes utterances to act / build / converse; owns voice + text I/O and the orb's state. Interface: `submit(utterance)`, emits state events (idle/listening/thinking/speaking). Depends on: Prompt Compiler, Loom, Organ Host, Rust voice.
- **Timeline** — git wrapper. Interface: `snapshot()`, `commit(msg)`, `branch()`, `diff()`, `rollback(ref)`, `lastGood()`. Depends on: Rust core (git).
- **Safe-boot** — minimal recovery shell loaded if the kernel throws on boot; can `rollback(lastGood)`. Depends on: Timeline.

---

## 4. Model fleet (local, via Ollama)

Three models resident on 64GB, no swapping (~34GB, pinned `keep_alive: -1`):

| Role | Model | Ollama tag | RAM | Notes |
|---|---|---|---|---|
| **Builder** (the Loom) | Qwen3-Coder-30B-A3B | `qwen3-coder:30b-a3b-q4_K_M` | ~19GB | MoE, 3B active → fast; 256K ctx |
| **Companion** | gpt-oss-20b | `gpt-oss:20b` | ~14GB | Fast; adjustable reasoning depth |
| **Rewriter** | Qwen3-1.7B | `qwen3:1.7b` (`/no_think`) | ~1.4GB | Prompt-compiler slot-fill/fallback |

- **Max-quality builder** (on demand): `qwen3-coder-next:q4_K_M` (80B-A3B, ~52GB) — requires swapping the companion out + raising the wired-memory limit. Reserved for hard builds.
- **Fleet manager** (Rust core): pull-if-missing, pin resident, health-check, timeouts + retry + fallback chain (builder → smaller coder; companion → rewriter) so a slow/absent model degrades gracefully instead of hanging.
- Frontier open models (DeepSeek-V4 etc.) are 300B–2.8T and cloud-only — out of scope; the Qwen 30B/80B line is the local ceiling.

---

## 5. The Loom (self-building engine)

Generalized + hardened EMBER Forge. **Keep verbatim (proven):** append-mode (splice new array entries), SEARCH/REPLACE edit-blocks (small regional output), step decomposition (ordered per-file steps, each validated), context-window sizing (`ctxFor`), per-file review + select + redo, and the **standalone self-test harness** (adapted `forge-selftest.mjs`) run in CI from day one.

**Validation gate (every change, before it goes live):**
1. Syntax (parse).
2. **Runtime smoke-test in a sandboxed Worker** — *changed from EMBER, which eval'd model output on the main thread.* Organs are loaded + rendered into a detached, isolated context; crashes/timeouts are caught, never touch the kernel.
3. Shell/manifest guard — an organ must register correctly; kernel edits must not drop core scripts/entry points.
4. **The model also writes the organ's tests**; they must pass.

**Timeline integration (changed from EMBER):** every applied change is a **git commit** (not a timestamped backup folder). Organs build on a branch, merge to `main` only when green. One-click rollback/time-travel of any organ or the whole system. This is what makes self-mod safe and enables safe-boot.

**Reliability hardening (EMBER lessons):** one-build-at-a-time queue; per-call timeout + retry + model fallback; structured in-app logging (model, tokens, latency, edit, validation result); explicit confirmation before any **kernel** edit; shared utilities (single source for `ctxFor`, system-prompt/ARCH, model selection — EMBER had 3 copies).

---

## 6. Prompt Compiler (the "semantic layer")

Turns a casual utterance into a perfectly-structured, model-specific prompt. **Deterministic-dominant hybrid** (research-backed; a black-box LLM rewriter is explicitly rejected as non-deterministic, slow, un-debuggable):

```
utterance
  → 1. NORMALIZE            [code]  fold/trim/NFKC, spell-fix, cache key
  → 2. CLASSIFY INTENT      [embed classifier; tiny-LLM only if low-confidence]
       {build_organ | edit_organ | act_on_organ | converse | meta}
  → 3. EXTRACT SLOTS        [regex/NER for well-formed; rewriter-LLM for fuzzy → flat schema]
  → 4. SELECT TEMPLATE      [code]  versioned registry keyed by (intent × model) + 0–2 kNN exemplars
  → 5. FILL TEMPLATE        [code]  interpolate slots; render in the model's EXACT chat format; keep it SHORT
  → 6. ATTACH CONTRACT      [code]  free-reasoning phase (NO grammar) → constrain ONLY the final extraction slice
  → CompiledPrompt { system, messages, format?, options, trace_id, template@version, exemplars, intent, confidence, editable }
```

**Principles (research):** constraining output too early measurably dumbs down small models → reason free-form first, constrain only the final slice; over-prompting collapses small models → few exemplars, short prompts; **chat-template fidelity is the single biggest cheap win** → the compiler owns it so organs/kernel never hand-roll it.

**Honesty & evolvability:** the `CompiledPrompt` is a first-class, **viewable and editable** artifact (with a "raw mode" escape hatch); templates are **versioned data**, and LOOM self-improves them via **shadow-tested candidates gated on a golden regression set** (never auto-promoted blind) — self-modification that only tightens quality.

---

## 7. Organs

The self-built body. Each organ = `{ manifest, code, data, tests }`.
- **No-build JS modules** using the EMBER registry pattern (`LOOM_MODULES.push({...})`), hot-loaded at runtime — trivially self-editable and reloadable without a rebuild.
- Render through a **LOOM UI kit + design tokens**, so everything the Loom builds is automatically beautiful and consistent with the kernel.
- **Isolated**: per-organ error boundary; validated in a sandboxed Worker before going live.
- **Data**: each organ owns local storage (namespaced; SQLite via Rust for structured/growing data, or namespaced key-value for simple state). Export built in (EMBER lacked this).
- Seed organs shipped so LOOM is useful on day one (small set: Home, a Notes/Journal organ, the Timeline viewer, the Loom console). The rest, you grow.

---

## 8. Companion — text **and** voice (must be genuinely right)

The persistent presence. Text and voice are equal first-class inputs in v1. **Voice reliability is a hard requirement** — the AgentZeus mic saga is the anti-pattern; no ambiguous half-working states.

- **STT (offline):** whisper.cpp in the Rust core. **Primary activation = push-to-talk** (hold a key / press-and-hold the orb) — the robust, unambiguous path. Always-listening/wake-word is explicitly **deferred** (that's where AgentZeus's clap detector went wrong); v1 favors reliability over hands-free.
- **TTS (offline):** piper in the Rust core (fast, natural, local).
- **Crisp state machine:** `idle → listening → thinking → speaking`, each with unmistakable orb + UI feedback; every transition lerped, never snapped. No silent failures — mic/model errors surface clearly.
- **First-run voice self-check:** a quick mic + STT + TTS test on setup so voice is proven working before the user relies on it (never "half works").
- **Routing:** utterance → Prompt Compiler → intent → act on an organ / ask the Loom to build/modify / converse. Presence recedes when you work; returns when addressed.
- Reuse AgentZeus's `audioLevel` shared-ref envelope (fast-attack/slow-decay) to drive the orb.

---

## 9. The orb & living UI (the wow)

North star: **emergent-from-dark oracle light** (HAL / *Her* / *Dune* holograms) — light that *emits*, not a lit disc.

**Orb (react-three-fiber + GLSL):**
- **Displaced icosphere** — vertices displaced along normals by **fBm/simplex noise**; a low-freq layer = slow **breathing** swells, a high-freq layer = fine plasma shimmer. Recompute normals for correct lighting.
- **Idle breathing**: even at rest, a slow sine drives amplitude — never fully static.
- **Fresnel rim glow** (`pow(1 - dot(n, view), ~3)`) = the oracular edge; **iridescence** (MeshPhysicalMaterial via CustomShaderMaterial) for the oil-on-water divine sheen; deep navy (#060b18) interior so light emerges from dark.
- **Postprocessing**: HDR-thresholded **bloom** (rim pushed >1.0 so only hot edges bloom = "emitting light"), subtle **chromatic aberration**; optional god-rays reserved for peak "speaking" moments.
- **Audio + state reactive**: drive amplitude with the `audioLevel` envelope (mic when listening, TTS analyser when speaking); per-state color + speed identity; **lerp uniforms** (0.05–0.15) on state changes so it shifts mood like a living thing.

**Living dashboard:** perlin/simplex sub-pixel DOM drift (nothing perfectly still); spring physics (framer-motion) for all motion; glassmorphism-2.0 depth (layered backdrop-filter, masks); cursor-reactive spotlight over the glass; an ambient particle nebula tinted to the orb's current mood; unified design tokens (state colors flow to orb + glow + particles + accents in unison); tasteful film grain to kill banding; honor `prefers-reduced-motion` / reduce-transparency.

**Performance/fallback (Tauri webview):** WebGL2 in WKWebView can be software-backed — detect and tier. Desktop = full stack (detail-20 icosphere + bloom + CA + GPU particles); low-tier = detail-8 + bloom only; **tier-0 fallback = the existing 2D SVG/canvas orb**. Budget: <100 draw calls, no per-frame allocs, dispose geometries/materials. Consider `WebGPURenderer` (auto WebGL2 fallback) to future-proof.

---

## 10. Safety, self-mod tiering, safe-boot

- **Tiered self-mod (v1):** organs are freely built/edited; **kernel** edits require an explicit gate + confirmation. Architected so removing the guardrail later (full self-mod) is a permission flip, not a rearchitecture.
- **Everything git-versioned** (Timeline): branch → validate → self-test → merge; one-click rollback of any organ or the whole system.
- **Safe-boot:** if the kernel fails to load, LOOM starts a minimal recovery shell that rolls back to the last-good commit — the "can never strand you" guarantee.
- **Sandboxed evaluation:** organ smoke-tests run in an isolated Worker, not the main thread (EMBER's gap).
- **Local-only, offline:** models via localhost Ollama; no cloud, no telemetry. Organ data export for resilience; storage-quota warnings.

---

## 11. Testing

- **Self-test harness from day one** (adapted `forge-selftest.mjs`) — replicates the Loom's real pipeline (append / edit-blocks / build organ) against the real fleet, N reps, validating outputs. Runs in CI as a gate (EMBER ran it manually only).
- Unit tests for the kernel primitives (Timeline/git ops, Prompt Compiler stages, Organ Host isolation, fleet fallback).
- A "chaos" test: feed a deliberately-broken model output and assert the validation gate + safe-boot prevent any live breakage.

---

## 12. Build sequence (for the implementation plan)

Rough order (the implementation plan will detail each):
1. **Skeleton**: Tauri + React+Vite shell; Rust core with Ollama bridge + fleet manager; git-backed Timeline; Organ Host + registry + error boundary; safe-boot stub.
2. **The Loom**: port + harden Forge (append/edit-blocks/steps/validate), Worker-sandboxed smoke-test, git commits, self-test in CI.
3. **Prompt Compiler**: normalize → classify → slots → template registry → chat-format render → scoped contract; CompiledPrompt viewer/editor.
4. **Companion (text)** + routing; seed organs (Home, Notes, Timeline viewer, Loom console) via the UI kit + tokens.
5. **The orb & living UI**: r3f displaced-icosphere/fresnel/iridescence/bloom, tiering + 2D fallback, motion system, design tokens.
6. **Voice**: whisper.cpp STT + piper TTS in Rust core, push-to-talk, crisp state machine, first-run self-check.
7. **Polish + hardening**: logging, timeouts/retry/fallback, export, quota warnings, rollback-all.

---

## 13. Risks & open questions

- **Tauri webview WebGL performance** — mitigated by tiering + 2D fallback; validate early on the real machine.
- **Voice quality bar** — whisper.cpp/piper model sizes vs latency vs accuracy need tuning; first-run self-check is the safety valve. Push-to-talk chosen specifically to avoid AgentZeus's half-working activation.
- **Self-modifying a built kernel** — deliberately gated in v1; the org-vs-kernel boundary must be crisp so the future "full self-mod" flip is clean.
- **Fleet memory pressure** — default fleet is ~34GB (safe); the 80B max-quality builder forces swap + wired-limit changes (documented, opt-in).
- **Organ data growth** — SQLite-per-organ vs shared store; start simple, index only if a corpus grows (EMBER's naive search wouldn't scale).

---

*Sibling parked seeds (in ~/Downloads): KEEL (Flexport control tower), PRISM (truth engine), SIGNET (provenance). LOOM is the active flagship.*
