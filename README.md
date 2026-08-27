<div align="center">

<img src=".github/assets/hero.png" alt="LOOM" width="100%"/>

### the sovereign cockpit

<em>offline &nbsp;·&nbsp; local models &nbsp;·&nbsp; voice command of the world &nbsp;·&nbsp; it builds itself &nbsp;·&nbsp; yours</em>

&nbsp;

<img alt="vessel" src="https://img.shields.io/badge/vessel-Tauri_v2-22D3EE?style=for-the-badge&labelColor=060b18"/>
<img alt="runs" src="https://img.shields.io/badge/runs-100%25_offline-22D3EE?style=for-the-badge&labelColor=060b18"/>
<img alt="self-building" src="https://img.shields.io/badge/it-builds_itself-7DD3FC?style=for-the-badge&labelColor=060b18"/>
<img alt="selftest" src="https://img.shields.io/badge/real--model_selftest-10%2F10-4ADE80?style=for-the-badge&labelColor=060b18"/>
<a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-Apache--2.0-4ADE80?style=for-the-badge&labelColor=060b18"/></a>

<br/>

<img alt="core" src="https://img.shields.io/badge/core-Rust_%C2%B7_git2-6b7382?style=flat-square&labelColor=060b18"/>
<img alt="ui" src="https://img.shields.io/badge/kernel-React_%C2%B7_Vite_%C2%B7_TS-6b7382?style=flat-square&labelColor=060b18"/>
<img alt="fleet" src="https://img.shields.io/badge/fleet-qwen3--coder_%C2%B7_gpt--oss_%C2%B7_qwen3-6b7382?style=flat-square&labelColor=060b18"/>
<img alt="sandbox" src="https://img.shields.io/badge/validation-sandboxed_%2B_self--repairing-6b7382?style=flat-square&labelColor=060b18"/>
<img alt="history" src="https://img.shields.io/badge/history-git_Timeline-6b7382?style=flat-square&labelColor=060b18"/>

&nbsp;

<a href="#what-this-is"><kbd> &nbsp; <b>What this is</b> &nbsp; </kbd></a> &nbsp;
<a href="#the-cockpit"><kbd> &nbsp; <b>The Cockpit</b> &nbsp; </kbd></a> &nbsp;
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

## The Cockpit

**Phase 9 — Stage 1 — shipped.**

LOOM is now the Sovereign Cockpit: the orb commands a living world. The ambient void is still the default — quiet, offline, yours. Switch on the globe and the AUSPEX globe deck rises behind the orb: live vessels at sea, geolocated news stories, earthquake events, all the feeds AUSPEX carries, running in a sandboxed iframe with no changes to the upstream AUSPEX repo.

**What shipped in Stage 1:**

- **Living globe deck.** A bundled snapshot of the AUSPEX globe app renders as a full-bleed deck behind the orb band. Toggle VOID / GLOBE from the top bar. Live feeds work as-is (AUSPEX's public Supabase reads, USGS, AIS vessels via your AISSTREAM key). Keyed feeds degrade silently when keys are absent — AUSPEX already handles that.

- **Voice command of the world.** Say the phrase and it happens — no wake word, no lag. The companion rules engine resolves globe commands without a model call:
  - "show the globe" / "show the world" — switches to globe deck
  - "hide the globe" / "back to the void" — returns to void
  - "show military" / "show climate" / "show finance" — filters news by category
  - "show vessels" / "show ships" — toggles the live AIS vessel overlay
  - "stop spinning" / "start spinning" — controls globe rotation
  - "reset the view" — resets globe position
  - The companion speaks a one-line confirmation; the orb pulses on each command.

- **Cloud-override builder (opt-in).** Settings > Models > Cloud builder: toggle it on, paste your Anthropic API key (write-only — it is stored in a Tauri-side file at OS file permissions, never in the webview, never returned after save). When enabled, the builder routes to `claude-opus-4-8` via the Anthropic Messages API. Local Ollama fleet remains the default and the fallback on any cloud error. Each build card shows which brain built it. The companion and rewriter roles always stay local — only the builder gets the cloud option.

**The orb never moves.** Decks change the world behind it.

---

## Stage 2 — The Cockpit Watches

**Phase 10 — Stage 2 — shipped.**

The cockpit now watches the world for you. A salience engine runs in the kernel, ranking live events from two free sensors against your personal watchlist. A living constellation of LOOM's agents rings the orb. Say "brief me" and the cockpit speaks the top of the watch, offline, no model call.

**What shipped in Stage 2:**

- **Salience engine.** A pure scoring function — source trust, category weight, recency decay, watchlist match, engagement signals — ranks every incoming event and emits only when the top-10 ordering changes. Ported and adapted from AgentZeus's factor model; every factor produces a human-readable reason string.

- **Live world sensors.** Two free sensors, no keys required: AUSPEX's public Supabase stories feed (the same anon REST endpoint the globe deck reads), and the USGS all-day earthquake GeoJSON. Both poll on a 120-second interval with AbortSignal timeout and graceful offline degradation.

- **Watch panel.** A collapsible glass panel (WATCH in the top bar) shows the salience-ranked feed: title, source, age, score bar, expandable reasons. Row actions: open (copies URL to clipboard and records engagement), dismiss (hides the row, records engagement), watch+ (adds the matched entity or topic to your watchlist). Watchlist chips at the panel top for add/remove.

- **Living constellation.** An SVG ring of LOOM's agents — builder, companion, rewriter, and the two watch sensors — around the orb. Synaptic bezier wires node-to-orb. `loom-fleet-activity` events light the matching role node and animate a packet along the wire; `loom-salience` pulses the sensor nodes. Reduced-motion: static, no packets.

- **Voice briefings.** Say "brief me", "what matters", "morning brief", "what's happening", or "since I've been gone". The cockpit assembles a spoken briefing from the top 3 salient items — title and first reason — with zero model calls. Empty watch: "The watch is quiet. Nothing crosses your thresholds." Spoken per the existing speakReplies setting.

- **Deck origin isolation (production).** In production builds, the AUSPEX globe iframe is served via a custom `deck://localhost` Tauri protocol (custom `deck` URI scheme), giving it a distinct origin from the LOOM shell. The deck's own localStorage and Supabase fetches continue to work (CORS: anon REST allows any origin). In dev, vite serves as before (shared origin, documented).

---

## Stage 3 — Craft

**Phase 11 — Stage 3 — shipped.**

The cockpit grew a written design language and a live market surface.

**Chrome redesigned.**

Every surface was audited against a formal token set: `--t1/t2/t3` text hierarchy, `--line/glass-border` separators, `--accent` reserved for live/selected state only, `--danger/warn` for deltas and alerts. No raw hex values remain in shell chrome. A screenshot gate enforced every step: no phase advanced until the rendered result matched the spec. The orb band, top bar, dock, watch panel, and deck layer all speak the same language.

**Hardening.**

Raw error strings no longer reach the user. Every async boundary has an error handler. LOOM's voice is consistent whether something succeeds or fails — build failures, model timeouts, and network errors all produce calm, human copy. Error boundaries wrap the watch panel, organ windows, and deck layer so a crash in one surface cannot bring down the cockpit.

**Terminal deck — the tape is live.**

A Bloomberg-grade market surface mounts behind the orb when you say "show the terminal", "show markets", or "show the tape". It drives its own quotes poller by lifecycle: `startQuotes()` on mount, `stopQuotes()` on unmount — no background burn while another deck is active.

Panels:
- Ticker tape — all symbols scrolling at the top, looped seamlessly, paused when the document is hidden.
- Index hero cards — SPY, QQQ, DIA, IWM with price, delta, sparkline.
- Movers table — all tracked equities sorted by |delta%| descending.
- Macro strip — VIX, 10Y yield, gold, crude oil, bitcoin.
- Finance wire — salience-ranked finance/geo stories from the watch runtime.

Quote source: Yahoo Finance `/v8/chart` endpoint (`interval=15m&range=1d`). In the Tauri desktop app, requests hit Yahoo directly — no proxy, no key. In plain browser dev mode, requests transit `corsproxy.io` carrying only ticker symbols (no credentials, no personal data). The desktop app never uses the proxy.

---

## Stage 4a — Ownership

**Phase 12 — Stage 4a — shipped.**

The cockpit now belongs to you. Organs are mortal, the globe is interactive out of the box, the constellation is off by default, and the state you build is durable across restarts.

**What shipped:**

- **Organ deletion with full residue cleanup.** Every organ window's title bar gains a hover-reveal delete affordance. Confirming removes the organ's git files, all `loom.win.<id>` and `organ.<id>.*` storage keys, the windowRegistry entry, the open-window state, and the dock entry. Seeds deleted this way stay deleted — a tombstone list (`loom.organs.deleted`) prevents `installSeeds` from reinstating them on next boot.

- **Reset to defaults.** Settings > System: "Reset LOOM to defaults" clears all `loom.*` keys (positions, settings, watchlist, experience), then reloads. Tombstones are cleared on reset so deleted seed organs return — the confirm copy is honest about this. Organ git files are never touched by reset.

- **Constellation defaults off.** User verdict: clunky and in the way. `cockpit.constellation` now defaults to "off"; the ambient SVG ring renders only when the setting is "on". Toggle is live — no restart required. One setting away; the feature is intact.

- **Interact-by-default.** Deck iframes receive pointer events as soon as a deck is active. The INTERACT segment becomes a LOCK toggle: selected = interacting; clicking it turns pointer-passthrough off for sessions where you want orb-hold priority. Persists across restarts via `cockpit.interact` (default "on"). LOOM chrome (orb band, top bar, dock, chat input, watch panel) sits above the deck in z-order and is never captured by the iframe.

- **Trail hygiene for minimized organs.** Minimizing an organ now removes its windowRegistry entry so the ambient Threads component draws no wire to it. Restoring the window re-registers it. The wire reappears only when the organ is live on screen.

- **Persistence completeness.** WatchPanel open/closed state persists as `cockpit.watchOpen`. Minimized-organ set persists as `loom.minimized` so restored sessions match what you left.

- **Deck-mode legibility.** The `html` background is now explicitly `var(--bg)` (navy #060b18) so any future layout overflow reveals navy, never the browser canvas grey.

- **Orb transparent-mode over decks.** The orb compositor blends the orb into the scene when a deck is active — the glass sphere sits over the AUSPEX globe or the Terminal tape without a hard chrome box. The one visual quirk to know: a brief flicker can appear on first deck mount while the compositor repaints; this is a browser compositing artifact, not a bug, and disappears after the first paint settles.

---

## Stage 4b — More Decks

**Phase 13 — Stage 4b — shipped.**

The cockpit now carries five decks: void, globe, terminal, ember, and agora. The deck infrastructure was generalized so all future decks use the same `deck://localhost/<deckname>/` origin pattern and the same lifecycle plumbing.

**EMBER — the failsafe deck.**

Say "show ember", "show survival", or "show the failsafe" and the cockpit mounts EMBER: a bundled, fully offline survival console. EMBER is a static snapshot committed to `public/decks/ember/` from `~/Downloads/EMBER` — the same source project whose Forge engine inspired LOOM's builder. It runs entirely from local files with no network required.

EMBER's Advisor and Forge features call Ollama at `localhost:11434`. Under the `deck://` protocol origin used in packaged builds, Ollama's default CORS policy will reject these requests — EMBER degrades silently (the LLM chip goes offline; the rest of the console remains fully functional). To enable the Advisor in a packaged build, set `OLLAMA_ORIGINS=deck://localhost` in your Ollama environment before launching. EMBER's File System Access API (Forge file editing) may be unavailable inside a sandboxed iframe; EMBER hides or degrades those controls per its own design — it does not crash.

**AGORA — the exchange dock.**

Say "show agora", "show the exchange", or "open the floor" and the cockpit mounts the AGORA deck. AGORA is a dock: the deck iframe points at a configurable local URL (default `http://localhost:3000`). AGORA is a locally-run Next.js app (web + engine WebSocket + Postgres) that you start separately. The deck URL is set in Settings.

When AGORA is reachable the iframe mounts live; pointer events follow the interact toggle exactly as other decks. When AGORA is not running the deck shows an honest offline card: instructions to start the local app, a RETRY button that re-probes on demand, and no polling loop while dark. There is no remote-URL option — the Settings field accepts only `http(s)://localhost` or `http(s)://127.0.0.1` addresses; sovereignty and iframe safety require the app to run on your machine.

*(AGORA removed in Phase 18; the floor lives in the Terminal.)*

---

## Stage 6 — Command

**Phase 15 — Stage 6 — shipped.**

The cockpit commands its fleet. AGORA is no longer a dock you have to feed — LOOM starts and stops the exchange itself. The watch's mind is open for inspection. The noisy edges went quiet.

**LOOM starts AGORA.**

Say "show agora" and, if the exchange is dark, the offline card now carries a START control. Press it and LOOM spawns AGORA's dev server as a managed child process — fixed argv (`npm run dev`, no shell, no user-supplied arguments), working directory from Settings > Decks > AGORA path, validated Rust-side before anything spawns: the path must exist, sit under your home directory, and contain a `package.json` with a real `dev` script. One child max. The card shows "IGNITING THE EXCHANGE" with the last lines of live process output while LOOM auto-probes the web URL (every 2s, bounded at 45s); when AGORA answers, the iframe mounts and a STOP chip joins the health strip. The child is killed on STOP and on LOOM exit — no orphaned processes.

**Honest boundary:** LOOM manages the AGORA web process only. Postgres is a system service and stays yours to run — the card says so ("Postgres must be running").

*(AGORA removed in Phase 18; the floor lives in the Terminal.)*

**The owner can read the watch's mind.**

The watch panel gains a LEARNED section: the top positive and negative weights the salience engine has learned from your behavior, as tinted chips with kind glyphs (`#` category, `/` source, `~` word) — `#finance +0.18`, `/dailymail -0.12`. Nothing hidden, nothing cloud: these are the actual weights, recomputed from your local engagement signals. CLEAR LEARNING (with a confirm strip) wipes the signals and the watch forgets everything it inferred about you. Sovereignty includes your own model of yourself.

**Hygiene.** Whisper's C-level token spew is silenced at the log-hook level — voice transcription no longer floods the console. LOOM's own Rust code builds warning-free.

**Verified honestly:** EMBER's Forge cannot run inside the deck — WKWebView has no File System Access API, so EMBER shows its own unsupported callout and everything else works. Forge requires the standalone EMBER app in a Chromium browser; the deck is read/advise mode. Documented, not papered over.

---

## Phase 16 — Identity

**Phase 16 — shipped.**

LOOM stopped wearing borrowed clothes. One mark, one grammar, one signature surface no other computer can have.

**The mark.**

A woven monogram — three warp threads, one luminous weft weaving over-under through them and rising toward the top right. The two meanings of the name in one figure: to *weave*, and to *loom* into view. It is the favicon (the Vite leftover is gone), it sits beside the wordmark sharing the orb's mood glow, it draws itself — the weft threading the warp — once at every boot, and it anchors the ABOUT strip in Settings. The identity is codified in [`docs/BRAND.md`](docs/BRAND.md): the palette is law, the voice is calm, sovereign, honest — lowercase statements, no exclamation marks, honesty over reassurance.

**The Tapestry.**

The constellation is dead — removed, setting migrated away. In its place, behind the orb: **LOOM's autobiography, woven.** Warp threads are the machine's own git commits, newest brightest. Weft threads are its organs — alive ones in accent light, deleted ones left as faint scars — the decks you sail, and every build it has survived: a clean pass runs smooth, a repaired build carries a visible knot. What the watch has learned about you tints the cloth. Hover names any thread; click an organ thread and the organ opens; click a commit thread and the timeline opens. Every LOOM weaves a different cloth, because every LOOM lives a different life. No other machine can render this surface, because no other machine builds itself.

**The Shuttle.**

The shuttle is the part of a loom that carries the weft through the warp. Here it carries your intent. **⌘K** opens a glass palette over any deck: every command LOOM understands — decks, watch, build, organs, system — fuzzy-filtered as you type, grouped, keyboard-driven. One catalog, derived from the same tables the voice rules use and test-enforced against drift, feeds both: anything sayable is typeable, anything typeable is sayable. Free text that matches nothing falls through to the companion, exactly like speech. And the voice gained discoverability — say "what can you do" and LOOM answers from the same catalog, no model call.

---

## Phase 17 — Depth

**Phase 17 — shipped.**

The Terminal and AGORA decks were empty. Now they are deep — on free, keyless sources, through LOOM's own hands.

**The root cause, killed.** The desktop quote proxy sent no User-Agent; Yahoo answered every request with 429, and the whole Terminal rendered silently blank. Diagnosed live, fixed at the engine: every market request now carries a browser UA (with a second-host retry on 429), and the fix is proven by a live integration test. The old failure mode — a panel that is empty and won't say why — is now against the law: every panel states its condition.

**The market engine.** `market.rs` — five typed commands over hardcoded, allowlisted hosts: Yahoo intraday charts, Coinbase Exchange ticker/24h/order-book/trades, Frankfurter FX. No keys, no third-party proxy on desktop, symbols validated before any request leaves the machine. Browser dev mode uses the same shapes over CORS-open sources.

**The Terminal deepens.** The movers table is now *your* tape — add and remove tickers inline, persisted, the poller follows live. Click any symbol and a detail panel opens: full intraday area chart, open/high/low/prev-close/volume, tinted delta. New CRYPTO strip (BTC/ETH/SOL spot + 24h) and FX strip (EUR/GBP/JPY — labeled *daily*, because the source is daily and LOOM does not fake liveness). Header health chips — EQUITIES · CRYPTO · FX — show green/stale/dark per source with honest ages.

**AGORA gets a floor.** When your local AGORA app isn't running, the deck is no longer one dark card. LOOM renders its own floor: a live order-book ladder (12 levels a side, cumulative depth bars, mid + spread in bps), a flowing trades tape tinted by taker side, product chips (BTC/ETH/SOL). The launch controls compress into a strip above the floor — START still ignites your local exchange, and when it answers, the iframe takes over exactly as before. About 0.9 requests/second worst case against a public limit of ten: a polite guest.

*(AGORA removed in Phase 18; the floor lives in the Terminal.)*

---

## Phase 18 — Excision

**Phase 18 — shipped.**

AGORA left the ship. The owner's verdict was final, and LOOM removes cleanly or not at all: the process-spawn subsystem, the deck, the iframe dock, the settings, the voice phrases — all gone, to the last grep. Stored settings from older installs are retired by an idempotent boot migration; a cockpit left pointing at the departed deck wakes in the void. The `libc` dependency left with it.

**The floor stayed.** It never needed AGORA — it was LOOM's own, on Coinbase's open data. It now lives where it belongs: click BTC, ETH, or SOL in the Terminal's crypto strip and the floor opens as an overlay — order-book ladder, cumulative depth bars, mid and spread in basis points, the trades tape tinted by taker side. Its polls run only while it's open. Close it and the feed goes quiet.

Four decks: **void · globe · terminal · ember**. Nothing on board that doesn't earn its keep.

---

## Phase 19 — Vigor

**Phase 19 — shipped.**

Built organs had a toy ceiling: storage and a UI kit. *"Alert me when BTC drops 5% in an hour"* could not produce a working thing. Now it can.

**Organs grow hands.** Six powers, each a token the organ's manifest must declare and you must approve:

| power | what it grants |
|---|---|
| `market` | read market data — charts, crypto, order books, trades, FX — through LOOM's own engine |
| `watch` | read the salience feed and your watchlist |
| `timeline` | read LOOM's own git history |
| `voice` | speak aloud through the cockpit's voice |
| `notify` | raise a calm glass notice in the corner of the cockpit |
| `pulse` | run on a schedule while LOOM is open — down to every 30 seconds |

**Governed the LOOM way.** The permission card lists requested powers in plain language before anything runs. Every power is budgeted per organ — market 30 calls/min, voice one utterance per 30s, notices six an hour — and a throttled organ shows a dim THROTTLED chip instead of crashing. Every power is revocable live from the organ's title bar: flip the toggle and the organ's next call is calmly refused. The validation sandbox mocks all six powers deterministically, so an organ's generated tests prove its behavior — what it notifies, what it says, what it schedules — offline, before you ever approve it.

**The builder knows its hands.** When your sentence implies powers, the builder's prompt carries the exact API contract and a worked example; the model declares the powers it needs, writes code that uses them, and writes tests against the sandbox's recorded outputs. Say the sentence. Approve the card. Own the tool.

---

## Phase 20 — Initiative

**Phase 20 — shipped.**

Until now LOOM built only what you asked. It waited. A computer that builds *itself for you* shouldn't wait — so LOOM began to notice, and to propose.

**Earned, never guessed.** LOOM keeps a private, local ledger of how you actually use it — which decks you visit, what you ask for, how often you open the watch, which markets you check. A deterministic observer — no model call, no cloud — reads that ledger against the salience it has already learned about you. When, and *only* when, the evidence crosses a real threshold, it forms an idea and shows its receipt: *"you opened the BTC floor 6 times. I could notify you when it moves more than 3% in an hour."* If it can't quote what you did, it stays silent — and silence is the common case, by design. This is the opposite of a paperclip that guesses.

**Proposed, then consented.** The idea arrives as one calm card near the orb — the woven mark, the reasoning in plain words, and the powers the organ would ask for, shown up front. Three choices: **weave it**, **not now**, **never**. "Weave it" doesn't do anything special — it drops the sentence into the exact same build pipeline a typed request uses, so the organ still plans, tests, and self-proves in the sandbox, and you still approve its powers on the permission card before it runs. "Not now" buys a day of quiet. "Never" retires that idea forever.

**Governed.** At most one idea a day. One setting silences it completely. Every "never" is remembered. The organs LOOM grows on its own initiative are marked as its own in the timeline. A machine that grows tools for you, only ever with your consent — no wrapper can ship that, because no wrapper builds itself.

---

## Phase 21 — Selfhood

**Phase 21 — shipped.**

Until now, one thing was always off-limits: the kernel — the code LOOM itself lives in. Organs were free; the machine's own body was not. This is the flip. **LOOM edits its own source, and it cannot brick itself doing it.**

The whole design is the safety. An edit to LOOM's own kernel passes five walls, in order, and can skip none:

1. **Isolation.** LOOM's model drafts the change, but it is never written to the running code. The core spins up an isolated git worktree and applies it there. The live app is untouched while it's judged.
2. **Proof.** In that isolation, LOOM runs the *real* compiler and the *real* test suite — `tsc` and `vitest` — over the change. Not a sandbox approximation: the same checks that guard every human commit. If it fails, LOOM's builder reads the compiler's own errors and repairs its edit, then proves it again. If it can't be made to pass, it's abandoned and the live tree never knew.
3. **Approval.** You see the actual diff — the exact lines, added and removed, in the file LOOM wants to change — under a card that says plainly *LOOM wants to change itself*. You approve or you discard. Always.
4. **Commit.** Only then does the change touch the live tree, as a git commit to LOOM's own source, with the prior state recorded as the last known good.
5. **Recovery.** And if a change that passed every wall still somehow breaks the running app, LOOM comes home: on the next start it detects that the last edit never confirmed a healthy boot and rolls itself back to the last good commit, before the suspect code even loads. It cannot strand you.

**It cannot edit its own conscience.** One invariant sits above the rest: LOOM may edit its kernel, but never the machinery that keeps the kernel safe — the validator, the isolation, the recovery boot, the approval gate, or the list of what's protected. That set is carved out and refused in the core, before an edit is ever isolated. A machine that can rewrite itself but not disable its own safety.

This first turn is deliberately bounded — the TypeScript kernel, running from source in dev, where an approved change hot-reloads live in front of you. The Rust core and packaged-app self-rebuilds are the next horizon. But the thing the whole project was named for is now real: a computer that weaves itself into being, and can reach back and reweave the loom.

---

## How it weaves

<img src=".github/assets/weave.svg" alt="How LOOM weaves an organ: your sentence, the builder writes three files, the gate validates in a sandbox with a repair loop, the timeline commits, you approve and it lives" width="100%"/>

The builder does not invent design — it **composes a curated design kit** (`loom.ui`): glass cards, stats, progress, lists, buttons — so every organ is born beautiful, and lives as a draggable window on the desktop.

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

**Voice** — fully offline speech, downloaded once from Settings (like pulling the fleet):

| piece | model | size |
|---|---|---|
| Ears (STT) | whisper `ggml-base.en` (Metal) | 148 MB |
| Voice: Lessac — warm, neutral (US, default) | `en_US-lessac-medium` | ~64 MB |
| Voice: Alba — calm (British) | `en_GB-alba-medium` | ~64 MB |
| Voice: LibriTTS — rich (US) | `en_US-libritts-high` | ~100 MB |

Hold the **orb** (or **Space**) to talk; release to send. Replies are spoken aloud. Audition and switch voices in the Settings organ — which, being an organ, LOOM can edit for you.

---

## First five minutes

**Prerequisites:** macOS (Apple Silicon recommended), [Node](https://nodejs.org) 20+, the [Rust toolchain](https://rustup.rs), and [Ollama](https://ollama.com). About 35 GB free for the model fleet. Voice is optional — download it from Settings after first launch.

```bash
# 1. Clone and install
git clone https://github.com/AllStreets/loom.git
cd loom && npm install

# 2. Pull the model fleet (once, ~35 GB total — do this while you explore the code)
ollama pull qwen3-coder:30b-a3b-q4_K_M   # builder: writes and repairs code
ollama pull gpt-oss:20b                  # companion: the always-on presence
ollama pull qwen3:1.7b                   # rewriter: structures your words for the model

# 3. Verify everything is wired up
npm run check      # vitest + cargo test — must be fully green

# 4. Open LOOM
npm run tauri dev
```

On first launch the companion greets you. When the fleet is ready, type or speak your first build request — *"build me a water tracker"* or *"build an organ that tracks my reading log"* — and watch LOOM plan it, write it, test it, repair it if needed, and ask your permission before anything runs. Approve the card and your new organ is alive in the desktop.

**Voice:** hold the **orb** (or press **Space**) to talk; release to send. To download voices, open Settings from the dock and use the Download button next to each voice — no account, no network call beyond the download.

---

## Quickstart (short form)

```bash
git clone https://github.com/AllStreets/loom.git
cd loom && npm install
ollama pull qwen3-coder:30b-a3b-q4_K_M && ollama pull gpt-oss:20b && ollama pull qwen3:1.7b
npm run check && npm run tauri dev
```

Type into LOOM — *"Build an organ that tracks my daily water intake with a goal and a progress bar."* — and press **Enter**. Watch it write, validate, repair if needed, and commit; approve the permission card and your new organ is alive.

---

## Roadmap

Built in phases, each a working, tested, reviewed milestone.

| phase | what | status |
|---|---|---|
| **1 · Foundation** | Tauri shell · Rust core · resident model fleet · git Timeline · CI | shipped |
| **2 · The Loom** | self-building engine: sandboxed validation · self-repair loop · permission-gated organs · review toggle · real-model selftest | **shipped** |
| **3 · Companion** | prompt compiler · the presence (text) · organ editing by sentence · seed organs | **shipped** |
| **4 · The orb + living UI** | react-three-fiber oracle-light orb · breathing motion · the living dashboard | **shipped** |
| **4.5 · The Atelier** | loom.ui design kit — organs beautiful by construction · OS desktop: glass windows + dock | **shipped** |
| **5 · Voice** | offline whisper + piper voices · hold-the-orb / Space push-to-talk · spoken replies · Settings organ | **shipped** |
| **6 · Vitality** | threads of light · ambient field · ignition · kit v2 (hero/spark/section) · DOM-grounded builder · first-run greeting | **shipped** |
| **9 · The Cockpit (Stage 1)** | deck layer · bundled AUSPEX globe · voice command of the world · cloud-override builder (`claude-opus-4-8`, opt-in) | **shipped** |
| **10 · The Cockpit (Stage 2)** | salience engine · live world sensors (AUSPEX stories + USGS quakes) · watchlist + engagement · living constellation · watch panel · voice briefings · deck origin isolation (prod custom protocol) | **shipped** |
| **11 · The Cockpit (Stage 3)** | chrome design language · hardening (error boundaries, LOOM-voice failure copy) · Terminal deck (live tape / indices / movers / macro + finance wire) | **shipped** |
| **12 · The Cockpit (Stage 4a)** | ownership: organ delete + tombstones · reset-to-defaults · persistence (watchOpen, minimized set) · constellation off-by-default · interact-by-default · deck-mode legibility · orb transparent-mode over decks | **shipped** |
| **13 · The Cockpit (Stage 4b)** | EMBER failsafe deck · AGORA exchange dock · deckserve generalized to all decks · five decks total | **shipped** |
| **14 · The Cockpit (Stage 5)** | LOOM-owned Rust quote proxy (desktop never touches third-party) · globe fly-to on briefings and locate · salience learns from owner behavior (transparent local weights) · AGORA engine health strip | **shipped** |
| **15 · The Cockpit (Stage 6)** | command: LOOM starts/stops AGORA itself (managed child process, validated spawn, exit-kill) · learned-weights inspection + CLEAR LEARNING · whisper log silence · warning-free build | **shipped** |
| **16 · Identity** | the brand system (woven mark on every surface, BRAND.md) · the Tapestry (constellation removed; LOOM's history woven live behind the orb) · the Shuttle (⌘K palette + voice sharing one drift-proof command catalog, "what can you do") | **shipped** |
| **17 · Depth** | the market engine (typed keyless sources: Yahoo UA-fixed · Coinbase Exchange · Frankfurter; 429 root cause dead) · Terminal depth (editable watchlist, symbol detail charts, crypto + FX strips, per-source health) · AGORA's native floor (order-book ladder, trades tape, launch strip) | **shipped** |
| **18 · Excision** | AGORA removed entirely (spawn subsystem, deck, settings, voice — migration-clean) · the floor folds into the Terminal as the crypto detail overlay · four decks | **shipped** |
| **19 · Vigor** | organs grow hands: six real powers (market · watch · timeline · voice · notify · pulse) — manifest-declared, permission-carded, budgeted, revocable live, sandbox-mocked · the builder learns the power APIs with grounded tests | **shipped** |
| **20 · Initiative** | LOOM proposes organs unprompted — a local usage observer + a deterministic rules engine that only fires on earned evidence · a calm consented proposal card (weave it / not now / never) whose "weave it" flows into the normal build pipeline · rate-limited, silenceable, tombstoned | **shipped** |
| **21 · Selfhood** | LOOM edits its own TypeScript kernel behind five walls — isolated-worktree validation (real tsc + vitest) · owner diff-approval · commit to source + hot-reload · recovery boot that rolls back a bad edit · a self-protection invariant (it cannot edit its own safety machinery) | **shipped** |
| **later** | Rust-core self-edit + packaged self-rebuild (Phase 22) · EMBER Forge-in-deck · LoRA fine-tune bridge · salience place-field · timeline-aware organs · embedding-based intent classifier · KEEL · PRISM · SIGNET | vision |

Design record: [`docs/superpowers/specs`](docs/superpowers/specs) · plans: [`docs/superpowers/plans`](docs/superpowers/plans) · brand: [`docs/BRAND.md`](docs/BRAND.md) · tracked follow-ups: [`docs/FOLLOWUPS.md`](docs/FOLLOWUPS.md)

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
