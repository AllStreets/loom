// "notify" is NOT here — it is gated exclusively as a power (see validate.ts
// POWERS); manifestGuard migrates legacy manifests that still declare it under
// permissions.
export const PERMISSIONS = ["storage", "model", "settings"] as const;
export type Permission = (typeof PERMISSIONS)[number];

// ── Powers — when a request smells like it needs real hands ───────────────────
// Keyword classes, word-boundary matched: alert/notify, speak/voice,
// remind/every/schedule (pulse), commit/history (timeline). Generous on ambiguity — an unneeded block costs tokens, a missing
// one costs the build — but plain widget requests ("water tracker") never match.
const POWER_HINTS = [
  // notify — alerts and notices (plain-speech phrasings included: recall-biased)
  "alert\\w*", "notif\\w*", "toasts?", "tell me", "ping", "let me know", "warn\\w*",
  // voice — the organ speaks
  "speak\\w*", "say", "voice", "aloud", "announce\\w*",
  // pulse — schedules and repetition
  "every", "schedul\\w*", "periodic\\w*", "intervals?", "recurring", "remind\\w*", "pulses?", "poll\\w*",
  // timeline — the history of the weave
  "commits?", "history", "timeline", "changelog",
];
const POWER_HINT_RE = new RegExp("\\b(?:" + POWER_HINTS.join("|") + ")\\b", "i");

/** True when a build request implies the organ may need one of the four powers. */
export function requestImpliesPowers(request: string): boolean {
  return POWER_HINT_RE.test(request);
}

/** The worked powered example — also the selftest fixture, so the few-shot the
 *  model studies is the exact organ CI proves passes offline. */
export const POWERS_FEWSHOT = {
  manifest: `{
  "id": "stand-up-reminder",
  "name": "Stand-Up Reminder",
  "description": "Every hour, reminds you to stand and stretch.",
  "version": 1,
  "permissions": ["storage"],
  "powers": ["notify", "pulse", "voice"]
}`,
  code: `export default {
  id: "stand-up-reminder",
  render(el, loom) {
    const ui = loom.ui;
    const { root, body } = ui.card({ title: "Stand-Up Reminder" });
    body.appendChild(ui.heading("Stand-Up Reminder", "A nudge to stand every hour."));
    const count = ui.stat("nudges today", "0");
    body.appendChild(ui.row(count, ui.badge("running", "accent")));
    el.appendChild(root);
    const nudge = () => {
      const today = new Date().toISOString().slice(0, 10);
      const rec = loom.storage.get("nudges", { day: today, n: 0 });
      const n = rec.day === today ? rec.n + 1 : 1;
      loom.storage.set("nudges", { day: today, n });
      ui.setStat(count, String(n));
      loom.notify("Time to stand", "Nudge " + n + " today — a minute on your feet.");
      loom.voice.say("Time to stand and stretch.");
    };
    loom.pulse.every(3600000, nudge);
  }
};`,
  tests: `export const tests = [
  { name: "registers one pulse at a lawful interval", fn: async ({ loom, assert }) => {
    assert(loom.pulse.registered.length === 1, "one pulse registered");
    assert(loom.pulse.registered[0] >= 30000, "interval is at least 30s");
  } },
  { name: "the first pulse notifies, speaks, and counts one nudge", fn: async ({ loom, assert }) => {
    await new Promise((r) => setTimeout(r, 0)); // let the immediate mock pulse finish
    assert(loom.notify.sent.length === 1, "one notification sent");
    assert(loom.notify.sent[0].title === "Time to stand", "title is the nudge");
    assert(loom.voice.said.length === 1, "spoke exactly once");
    assert(loom.storage.get("nudges", null).n === 1, "one nudge counted");
  } },
];`,
};

export const POWERS_CONTRACT = `POWERS — four gated capabilities beyond the basics. The manifest MUST declare every power the organ calls in an optional "powers" array (any subset of "timeline", "voice", "notify", "pulse"); the owner approves them, and undeclared or revoked calls throw a permission error. Declare ONLY what the request truly needs.

   Signatures (on the same loom object):
   await loom.timeline.log(n?)              -> [{ sha, message }] recent commits                                                    [needs "timeline"]
   await loom.voice.say(text)               -> speaks aloud (300-char cap)                                                          [needs "voice"]
   loom.notify(title, body?)                -> glass toast notice                                                                   [needs "notify"]
   loom.pulse.every(ms, fn)                 -> runs fn every ms while LOOM is open; returns cancel(); min 30000ms, max 4 per organ  [needs "pulse"]

   BUDGETS (per organ — an exceeded call throws a calm error, so pace yourself): voice <= 1 utterance/30s; notify <= 6/hour.

   SANDBOX MOCKS (what test.js runs against — deterministic, offline):
   - loom.notify.sent      -> array of { title, body } the mock recorded
   - loom.voice.said       -> array of spoken strings (already capped at 300 chars)
   - loom.pulse.registered -> array of registered intervals (ms); pulse.every fires its callback ONCE immediately so tests observe one cycle
   - timeline.log returns canned rows
   Test powered behavior by asserting on these hooks (and storage) — never on real network or timers.

   WORKED EXAMPLE — "remind me to stand up every hour":
   manifest.json:
   ${POWERS_FEWSHOT.manifest}
   organ.js:
   ${POWERS_FEWSHOT.code}
   test.js:
   ${POWERS_FEWSHOT.tests}`;

// ── SELF-EDIT contract (Phase 21 — the builder edits LOOM itself) ─────────────
//
// Injected ONLY into the builder prompt for kernel-edit (self_edit) drafting,
// never into organ builds. Conditionally built like POWERS_CONTRACT so a normal
// organ build never pays these tokens. It teaches the SEARCH/REPLACE format
// against the REAL current file, the five walls in one honest line, the
// whitelist reality, the repair contract, and one worked example.

/** The worked self-edit example — a small, safe numeric-constant edit, shown as
 *  a proper SEARCH/REPLACE block against a plausible editable file. Exported so
 *  the prompt test can prove it parses under edits.ts. */
export const SELF_EDIT_FEWSHOT = `<<<<<<< SEARCH
export const PULSE_MIN_MS = 30000;
=======
export const PULSE_MIN_MS = 15000;
>>>>>>> REPLACE`;

export const SELF_EDIT_CONTRACT = `SELF-EDIT — you are editing LOOM's OWN TypeScript kernel, not building an organ. This is the highest-blast-radius act in the system; the design is the safety.

   THE TASK: produce the MINIMAL SEARCH/REPLACE edit against the REAL current file contents you are given (never a full file, never a rewrite). Exact format — the SEARCH lines must be copied verbatim from the current file:
   <<<<<<< SEARCH
   (lines copied exactly from the current file)
   =======
   (replacement lines)
   >>>>>>> REPLACE

   THE FIVE WALLS (one honest line): your edit is applied in an isolated git worktree and type-checked (tsc --noEmit) + tested (vitest) BEFORE it can touch the running app, then the owner must approve the diff — so keep it small, keep it correct, make it pass tsc and the file's tests.

   THE WHITELIST: you may only edit src/** .ts/.tsx files. The safety machinery — kernelBuild.ts, the diff-review card, the recovery beacon, entry points (src/main.tsx, index.html) and configs (vite.config.ts, tsconfig*.json, package.json) — is PERMANENTLY OFF-LIMITS; a proposal targeting any of it is refused in Rust before isolation. Do not target it.

   ON A REPAIR TURN: you are given the failing stage (tsc | vitest) and the captured output. Fix the edit to pass. Do NOT fight the tests — they are the spec; make your change conform to them.

   WORKED EXAMPLE — "make the pulse minimum 15 seconds" (a small, safe constant change in an editable file):
   ${SELF_EDIT_FEWSHOT}`;

// ── RUST-core self-edit contract (Phase 22 — the builder reaches the marrow) ──
//
// Injected ONLY when the self-edit target is a `.rs` file under src-tauri/. It
// teaches the two honest differences from a TypeScript edit: the validation is
// `cargo check` + `cargo test` (the tests are the spec), and — critically — a
// Rust edit does NOT hot-reload; it needs a RESTART to load. Plus the Rust
// safety core that is permanently off-limits. Conditionally built like the
// POWERS block so a TS self-edit never pays these tokens.

/** The worked Rust self-edit example — a small, safe constant change to an
 *  EDITABLE core file (src-tauri/src/fleet.rs, outside PROTECTED_RUST). Exported
 *  so the prompt test can prove it parses+applies under edits.ts. */
export const SELF_EDIT_RUST_FEWSHOT = `<<<<<<< SEARCH
const TIMEOUT_MS: u64 = 45_000;
=======
const TIMEOUT_MS: u64 = 60_000;
>>>>>>> REPLACE`;

export const SELF_EDIT_RUST_CONTRACT = `RUST CORE — this target is a Rust source file (src-tauri/src/**.rs): you are editing LOOM's native core, the highest-blast-radius surface there is. Everything above still holds; three Rust-specific truths override the TypeScript framing:

   VALIDATION IS CARGO: your edit is validated in isolation with \`cargo check\` AND then \`cargo test\` — it must COMPILE and it must PASS THE TESTS. The tests are the spec; write your change to satisfy them, never to fight them. On a repair turn you are given the failing stage (cargo-check | cargo-test) and cargo's own output — read it and fix the edit.

   NO HOT-RELOAD — RESTART TO LOAD: unlike a TypeScript edit, a Rust edit does NOT live-reload. \`tauri dev\` compiled the running binary once at startup and does not watch src-tauri/. Once approved, your change is committed to source but takes effect only after LOOM is RESTARTED. Do not expect a live effect; do not add code that assumes it reloaded.

   THE RUST SAFETY CORE IS OFF-LIMITS: these files are refused in Rust before isolation — do NOT target them: src-tauri/src/main.rs, lib.rs, kernel.rs, exec.rs, error.rs, timeline.rs, the pre-boot guard module, scripts/kernel-preboot.mjs, and Cargo.toml / Cargo.lock (a dependency edit is an arbitrary-code vector). Editable core files are things like fleet.rs, organs.rs, voice.rs.

   KEEP IT MINIMAL: one small, surgical SEARCH/REPLACE against the real current file — never a rewrite.

   WORKED RUST EXAMPLE — "give the fleet a little more time" (a small, safe constant change in an editable core file, src-tauri/src/fleet.rs):
   ${SELF_EDIT_RUST_FEWSHOT}`;

// ── PACKAGED self-edit contract (Phase 23 — rebirth) ─────────────────────────
//
// Injected ONLY when LOOM runs as a built app (mode === "packaged"). A packaged
// LOOM has no `tauri dev` to hot-reload TypeScript and no compiler watching the
// core: an approved edit lands in the genome, and becomes the running app only
// after a reweave — a rebuild the owner approves, minutes long. The paragraph
// teaches that hinge and asks for a bounded edit. It does not repeat the
// protected set; the lists above already carry it. Dev mode never pays these
// tokens and its prompt is byte-identical to before this block existed.

export const SELF_EDIT_PACKAGED_CONTRACT = `PACKAGED — LOOM is running as a built app, not under \`tauri dev\`. Here an approved edit lands in the genome but does not yet run: a core edit becomes real only after a reweave — LOOM rebuilding itself from source and becoming the new generation — and the owner approves that reweave separately from approving your diff. A reweave takes minutes, not seconds, so keep the edit bounded to one region of one file: one thing changed, nothing rewritten, no edit that only pays off across several turns. The protected set named above is never editable, in any mode; do not propose an edit to it.`;

/** True when a self-edit target is a Rust-core file (src-tauri/…​.rs). Mirrors
 *  kernelBuild.isRustCorePath so the prompt injection matches the pipeline. */
function isRustTarget(targetPath?: string): boolean {
  return !!targetPath && targetPath.startsWith("src-tauri/") && targetPath.endsWith(".rs");
}

/**
 * The system prompt for the self-edit builder. Distinct from organSystemPrompt:
 * it carries the SELF_EDIT_CONTRACT (never the ORGAN_CONTRACT / POWERS) and is
 * the ONLY place that block is injected. `repair` is true on a validation-failure
 * repair turn — the caller still supplies the stage+output in the user message;
 * this flag lets the contract read as a correction turn. When `targetPath` names
 * a Rust-core file, the RUST contract (cargo validation, restart-to-load, the
 * off-limits core) is appended — conditionally, so a TS self-edit never pays it.
 * When `mode` is "packaged" (default "dev"), the PACKAGED contract is appended
 * after it: a core edit is real only after a reweave the owner approves.
 */
export function selfEditSystemPrompt(opts?: { repair?: boolean; targetPath?: string; mode?: "dev" | "packaged" }): string {
  const rust = isRustTarget(opts?.targetPath);
  const packaged = opts?.mode === "packaged";
  const base = rust
    ? "You are the Loom, the build engine inside LOOM, a sovereign offline computer. " +
      "Right now you are editing LOOM's own Rust core."
    : "You are the Loom, the build engine inside LOOM, a sovereign offline computer. " +
      "Right now you are editing LOOM's own TypeScript kernel.";
  // The RUST block rides just after the shared contract — only for a .rs target.
  const rustBlock = rust ? `\n\n${SELF_EDIT_RUST_CONTRACT}` : "";
  // The PACKAGED block rides after the Rust block — only when LOOM is a built app.
  const packagedBlock = packaged ? `\n\n${SELF_EDIT_PACKAGED_CONTRACT}` : "";
  const turn = opts?.repair
    ? "\n\nThis is a REPAIR turn: your previous edit failed validation. You are given the failing stage and its output — fix the edit to pass, and do not fight the tests."
    : "";
  return `${base}\n\n${SELF_EDIT_CONTRACT}${rustBlock}${packagedBlock}${turn}\n\nOutput ONLY SEARCH/REPLACE edit blocks. No prose before or after, no full file.`;
}

export function ctxFor(chars: number): number {
  const tokens = Math.ceil((chars * 2) / 3.3) + 3000;
  return Math.min(32768, Math.max(8192, Math.ceil(tokens / 2048) * 2048));
}

export const ORGAN_CONTRACT = `An ORGAN is a small self-contained tool inside LOOM, made of exactly three files:

1. manifest.json — {"id": "<kebab-case>", "name": "<Display Name>", "description": "<one line>", "version": 1, "permissions": [...]}
   Allowed permissions (request ONLY what the organ truly needs): "storage" (persistent key-value store), "model" (chat with the local model), "settings" (read/write user preferences — request only for settings-type organs).
   Optional "powers" array (declare ONLY the capabilities the organ truly calls): "timeline" (read commit history), "voice" (speak aloud), "notify" (glass toast notices), "pulse" (scheduled runs while LOOM is open). Each power is owner-approved and budgeted; full signatures arrive in a POWERS block when a request needs them.

2. organ.js — an ES module:
   export default {
     id: "<same id>",
     render(el, loom) {
       // el: the organ's root HTMLElement (render all UI inside it)
       // loom.storage.get(key, fallback) / loom.storage.set(key, value) / loom.storage.del(key)  [needs "storage"]
       // await loom.model.chat([{role:"user",content:"..."}]) -> string                            [needs "model"]
       // loom.notify(title, body?)                                          [needs the "notify" POWER — declare it in "powers"]
       // loom.settings — request only for settings-type organs                                     [needs "settings"]
       //   loom.settings.get(key) -> string          whitelisted keys: voice.default (voice id),
       //                                               voice.speakReplies ("always"|"whenSpoken"|"never"),
       //                                               orb.tier ("auto"|"flat"),
       //                                               loom.reviewBeforeSave ("0"|"1")
       //   loom.settings.set(key, value) -> void     validates key + value against whitelist
       //   loom.settings.voices() -> [{id,label,present}]  all 3 voice ids with download status
       //   await loom.settings.audition(voiceId) -> void   speaks "Hello — I am LOOM." aloud
       //   await loom.settings.micTest() -> string   2s record + transcribe; returns text or error
       //   loom.settings.voiceStatus() -> Promise<{ready,whisper,voices,missing_bytes_hint}>
       //   await loom.settings.setup(onPct?) -> void downloads missing models (fires onPct(pct) 0-100)

       // loom.ui — design kit (always available, no permission needed):
       //   loom.ui.tokens                           -> { bg, panel, t1, t2, t3, accent, go, warn, danger }
       //   loom.ui.heading(text, sub?)              -> header block (17px t1 + optional 12.5px t2 sub)
       //   loom.ui.card(opts?)                      -> { root, body } glass panel (opts.title = mono eyebrow)
       //   loom.ui.button(label, opts?)             -> <button> (variant: "primary"|"ghost"|"danger"; opts.action, opts.onClick)
       //   loom.ui.input(opts?)                     -> <input> (opts.placeholder, opts.action, opts.onEnter, opts.value)
       //   loom.ui.row(...children)                 -> flex row, gap 8, align-center
       //   loom.ui.stack(...children)               -> flex column, gap 8
       //   loom.ui.stat(label, value)               -> mono accent value over uppercase label (20px)
       //   loom.ui.setStat(statEl, value)           -> update stat value in place
       //   loom.ui.progress(pct)                    -> progress bar element with .set(pct) method
       //   loom.ui.list()                           -> { root, add(el), clear() } column list container
       //   loom.ui.listRow(text, opts?)             -> panel row with text; opts.onRemove adds a ghost x button
       //   loom.ui.badge(text, tone?)               -> mono pill (tones: accent/go/warn/danger/muted)
       //   loom.ui.empty(text)                      -> centered t3 empty-state message
       //   --- v2 factories ---
       //   loom.ui.hero(value, label)               -> luminous 28px focal stat with glow — ONE per organ max
       //   loom.ui.spark(values, opts?)             -> inline SVG sparkline (60x18) from number array; .update(values) to refresh; use for trends
       //   loom.ui.keyval(pairs)                    -> aligned [[key, value], ...] rows (mono key, t1 value)
       //   loom.ui.section(title)                   -> titled group divider: mono uppercase label + hairline; use to separate logical sections
       //   loom.ui.dot(tone?)                       -> 8px glowing status dot (tones: accent/go/warn/danger/muted)
       //   loom.ui.toolbar(...children)             -> right-aligned action row, gap 6; use for card header action buttons
       //   --- v3 instruments ---
       //   loom.ui.tabs(labels, opts?)             -> { root, panels, onChange } pill tab row + panel switcher
       //   loom.ui.barChart(data, opts?)           -> SVG bar chart (data: [{label, value}], accent fill)
       //   loom.ui.lineChart(series, opts?)        -> SVG line chart with gradient area fill
       //   loom.ui.gauge(value, max, opts?)        -> SVG arc gauge with centered stat (strokeDasharray)
       //   loom.ui.heatmap(values, opts?)          -> 7xN alpha-scaled cell grid (habit/streak patterns)
       //   loom.ui.dataGrid(columns, rows)         -> div-based grid with sticky header, hover rows
       //   loom.ui.toggle(label, checked, onChange) -> styled track+thumb switch
       //   loom.ui.select(options, opts?)          -> styled native select (options: [{value,label}] or strings)
       //   loom.ui.spinner(size?)                  -> CSS-animated loading ring
       //   loom.ui.icon(name)                      -> inline SVG icon (check/x/plus/arrow/gear/clock/star/warn/info/copy/trash/refresh)

       // DESIGN LANGUAGE v3:
       //   Compose loom.ui primitives — never hand-roll styled divs.
       //   Ad-hoc style ONLY for layout spacing (margin/flex gap between sections).
       //   ONE HERO MOMENT PER ORGAN: every data organ earns exactly one focal highlight —
       //     ui.hero (for a key metric), ui.progress (for a goal/quota), or ui.stat (for a compact number).
       //     Never stack two hero moments; choose the single number that matters most.
       //   TRENDS: numbers over time -> ui.lineChart or ui.spark. Categories/comparisons -> ui.barChart.
       //   GOALS: progress toward a target -> ui.gauge (arc) or ui.progress (bar).
       //   HABITS/STREAKS: daily activity patterns over weeks -> ui.heatmap (7-row alpha-scaled grid).
       //   TABULAR DATA: structured rows/columns -> ui.dataGrid (sticky header, hover rows).
       //   MULTI-PAGE ORGANS: divide into logical views -> ui.tabs (pill row + panel switcher).
       //   ACTIONS: use ui.icon(name) on buttons to convey meaning, not decoration. Keep icons purposeful.
       //   SECTIONS: use ui.section(title) to separate logical groups (e.g. "Voice", "Appearance").
       //   STATUSES: use ui.dot(tone) inline beside a label to signal live state at a glance.
       //   TOOLBARS: use ui.toolbar(...btns) for card-header action areas — keeps buttons right-aligned.
       //   KEYVAL: use ui.keyval(pairs) for metadata or detail panels — never hand-code label/value rows.
       //   Generous whitespace; small text uses t2/t3; hierarchy = heading -> content -> actions.
       //   Empty states use loom.ui.empty(). Lists use loom.ui.list() + loom.ui.listRow().
       //   ONE HERO rule still applies: pick one focal number; surround with context via charts/gauges.
     }
   }
   No external imports, no network, no document.cookie, no window.top.
   EVERY interactive element (buttons, inputs) MUST set a data-action attribute naming what it does, e.g.
   button.dataset.action = "add"; input.dataset.action = "new-item"; deleteBtn.dataset.action = "remove".
   These are the STABLE selectors the tests use — without them the tests cannot find your elements.

   MUTATION SEMANTICS (required for deterministic tests):
   - After ANY mutation (add, remove, update), re-render the list from storage.
   - Clear the input field after a SUCCESSFUL add (input.value = ""). This makes multi-add deterministic.
   - Guard empty inputs: do NOT add an item when the trimmed value is empty.

   EXAMPLE organ (compact, beautiful, kit-composed):
   export default {
     id: "word-count",
     render(el, loom) {
       const ui = loom.ui;
       const { root, body } = ui.card({ title: "Word Count" });
       const heading = ui.heading("Paste & Count", "Measure your writing at a glance.");
       const field = ui.input({ placeholder: "Type or paste text...", action: "text-input" });
       const countStat = ui.stat("words", 0);
       const charStat = ui.stat("chars", 0);
       const stats = ui.row(countStat, charStat);
       stats.style.marginTop = "4px";
       body.appendChild(heading);
       body.appendChild(field);
       body.appendChild(stats);
       el.appendChild(root);
       field.addEventListener("input", () => {
         const val = field.value;
         ui.setStat(countStat, val.trim() ? val.trim().split(/\s+/).length : 0);
         ui.setStat(charStat, val.length);
       });
     }
   };

3. test.js — an ES module that exports ONLY a tests array. IMPORTANT: test.js must contain NO import statements of any kind (imports cannot resolve in the test sandbox). The organ is provided to every test through its context:
   export const tests = [
     { name: "renders a heading", fn: async ({ el, loom, assert, organ }) => {
       // el: a fresh element with the organ ALREADY rendered into it
       // organ: organ.js's default export (already imported for you — never import it yourself)
       assert(el.textContent.length > 0, "renders content");
     } },
   ];
   Each fn gets { el, loom, assert, organ }: a fresh rendered el, a mock loom api, assert(cond, msg), and the organ object.
   TEST ISOLATION: every test starts with a FRESH EMPTY storage and a fresh render of el — tests never see another test's data. To test behavior on existing data: loom.storage.set(...) first, then create your own element and await organ.render(myEl, loom), then assert on myEl.
   SELECTORS: find interactive elements ONLY via their data-action attributes — el.querySelector('[data-action="add"]') — never by tag position, class, or text. Read state from loom.storage (source of truth), and prefer storage assertions over DOM-text assertions.

Rules: complete files only, no placeholders or TODOs; small and focused; real functionality, never filler.

NOTE — LOOM's own TypeScript kernel (src/**) is now self-editable WITHIN the five walls (isolation, tsc+vitest validation, owner diff-approval, commit, recovery boot); the safety machinery that enforces those walls is permanently off-limits. That path uses its own SELF-EDIT contract, not this one.`;

export function organSystemPrompt(
  kind: "manifest" | "code" | "tests" | "edit" | "repair",
  opts?: { exemplars?: string; lessons?: string; request?: string }
): string {
  const base = `You are the Loom, the build engine inside LOOM, a sovereign offline computer. You write organs.\n\n${ORGAN_CONTRACT}\n\nOutput ONLY the requested file content in a single fenced code block. No prose before or after.`;

  // Powers are documented only when the request smells like it needs them —
  // plain widget builds keep a lean prompt.
  const powersBlock =
    opts?.request && requestImpliesPowers(opts.request) ? `\n\n${POWERS_CONTRACT}` : "";

  // Build experience injection block
  let experienceBlock = "";
  if (opts?.exemplars && opts.exemplars.length > 0) {
    experienceBlock += `\n\nEXPERIENCE — PAST SUCCESSFUL BUILDS (study these patterns):\n${opts.exemplars}`;
  }
  if (opts?.lessons && opts.lessons.length > 0) {
    experienceBlock += `\n\nLESSONS FROM PAST FAILURES:\n${opts.lessons}`;
  }

  // Insert powers + experience blocks between contract (base) and task instruction
  const baseWithExp = base + powersBlock + experienceBlock;

  switch (kind) {
    case "manifest": return baseWithExp + `\nNow output manifest.json only. Choose a short kebab-case id and the MINIMAL permissions the request needs.`;
    case "code": return baseWithExp + `\nNow output organ.js only. It must match the manifest's id and only use APIs its permissions allow.\nBuild the UI ONLY from loom.ui factories (plus plain layout containers for top-level spacing). Never hand-roll styled divs — use loom.ui.card, loom.ui.heading, loom.ui.button, loom.ui.input, loom.ui.list, loom.ui.listRow, loom.ui.stat, loom.ui.badge, loom.ui.empty, loom.ui.hero, loom.ui.spark, loom.ui.keyval, loom.ui.section, loom.ui.dot, loom.ui.toolbar, and v3 instruments: loom.ui.tabs, loom.ui.barChart, loom.ui.lineChart, loom.ui.gauge, loom.ui.heatmap, loom.ui.dataGrid, loom.ui.toggle, loom.ui.select, loom.ui.spinner, loom.ui.icon.\nFor data/metrics organs: open with ui.hero(value, label) as the ONE focal moment, then support detail with ui.keyval or ui.spark for trends. For dashboards with charts: use ui.barChart or ui.lineChart for time-series, ui.gauge for goals, ui.heatmap for daily habits.`;
    case "tests": return baseWithExp + `\nNow output test.js only: 2-4 meaningful tests that verify the organ's real behavior (not trivial truths).\nABSOLUTE RULES:\n- No import statements anywhere in test.js — use the organ provided in the test context ({ el, loom, assert, organ }). The organ is already rendered into el before each test runs.\n- Each test starts with FRESH empty storage — never assume another test's data exists.\n- Select interactive elements ONLY via [data-action="..."] attributes (they are guaranteed by the organ contract); never by tag order or text.\n- Prefer asserting on loom.storage state over DOM text.\nCANONICAL INTERACTION PATTERNS (follow these exactly — they match the organ's mutation semantics):\n- MULTI-ADD: The input clears after each successful add. To add N items: set input.value = "first", click add, then set input.value = "second", click add again — set the value BEFORE each click, not once at the start.\n- STALE ELEMENTS: Re-query remove buttons and list rows after EVERY mutation. Never hold a NodeList or element reference across a click — use el.querySelectorAll('[data-action="remove"]')[i] freshly each time.\n- COUNT ASSERTIONS: Prefer loom.storage assertions for counts (e.g. loom.storage.get("items", []).length) over counting DOM nodes.`;
    case "repair": return baseWithExp + `\nYour previous file FAILED validation. You will be given the file and the exact errors. Output the COMPLETE corrected file in one fenced code block — fix the errors, keep the intended behavior, and follow every contract rule (especially: test.js must contain no import statements).`;
    case "edit": return baseWithExp + `\nYou are EDITING one existing file. Output ONLY SEARCH/REPLACE edit blocks in this exact format (no prose, no full file):\n<<<<<<< SEARCH\n(lines copied exactly from the current file)\n=======\n(replacement lines)\n>>>>>>> REPLACE`;
  }
}
