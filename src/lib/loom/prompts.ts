export const PERMISSIONS = ["storage", "model", "notify", "settings"] as const;
export type Permission = (typeof PERMISSIONS)[number];

export function ctxFor(chars: number): number {
  const tokens = Math.ceil((chars * 2) / 3.3) + 3000;
  return Math.min(32768, Math.max(8192, Math.ceil(tokens / 2048) * 2048));
}

export const ORGAN_CONTRACT = `An ORGAN is a small self-contained tool inside LOOM, made of exactly three files:

1. manifest.json — {"id": "<kebab-case>", "name": "<Display Name>", "description": "<one line>", "version": 1, "permissions": [...]}
   Allowed permissions (request ONLY what the organ truly needs): "storage" (persistent key-value store), "model" (chat with the local model), "notify" (show a notification), "settings" (read/write user preferences — request only for settings-type organs).

2. organ.js — an ES module:
   export default {
     id: "<same id>",
     render(el, loom) {
       // el: the organ's root HTMLElement (render all UI inside it)
       // loom.storage.get(key, fallback) / loom.storage.set(key, value) / loom.storage.del(key)  [needs "storage"]
       // await loom.model.chat([{role:"user",content:"..."}]) -> string                            [needs "model"]
       // loom.notify(text)                                                                          [needs "notify"]
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

       // loom.ui — design kit v2 (always available, no permission needed):
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

Rules: complete files only, no placeholders or TODOs; small and focused; real functionality, never filler.`;

export function organSystemPrompt(
  kind: "manifest" | "code" | "tests" | "edit" | "repair",
  opts?: { exemplars?: string; lessons?: string }
): string {
  const base = `You are the Loom, the build engine inside LOOM, a sovereign offline computer. You write organs.\n\n${ORGAN_CONTRACT}\n\nOutput ONLY the requested file content in a single fenced code block. No prose before or after.`;

  // Build experience injection block
  let experienceBlock = "";
  if (opts?.exemplars && opts.exemplars.length > 0) {
    experienceBlock += `\n\nEXPERIENCE — PAST SUCCESSFUL BUILDS (study these patterns):\n${opts.exemplars}`;
  }
  if (opts?.lessons && opts.lessons.length > 0) {
    experienceBlock += `\n\nLESSONS FROM PAST FAILURES:\n${opts.lessons}`;
  }

  // Insert experience block between contract (base) and task instruction
  const baseWithExp = base + experienceBlock;

  switch (kind) {
    case "manifest": return baseWithExp + `\nNow output manifest.json only. Choose a short kebab-case id and the MINIMAL permissions the request needs.`;
    case "code": return baseWithExp + `\nNow output organ.js only. It must match the manifest's id and only use APIs its permissions allow.\nBuild the UI ONLY from loom.ui factories (plus plain layout containers for top-level spacing). Never hand-roll styled divs — use loom.ui.card, loom.ui.heading, loom.ui.button, loom.ui.input, loom.ui.list, loom.ui.listRow, loom.ui.stat, loom.ui.badge, loom.ui.empty, loom.ui.hero, loom.ui.spark, loom.ui.keyval, loom.ui.section, loom.ui.dot, loom.ui.toolbar, and v3 instruments: loom.ui.tabs, loom.ui.barChart, loom.ui.lineChart, loom.ui.gauge, loom.ui.heatmap, loom.ui.dataGrid, loom.ui.toggle, loom.ui.select, loom.ui.spinner, loom.ui.icon.\nFor data/metrics organs: open with ui.hero(value, label) as the ONE focal moment, then support detail with ui.keyval or ui.spark for trends. For dashboards with charts: use ui.barChart or ui.lineChart for time-series, ui.gauge for goals, ui.heatmap for daily habits.`;
    case "tests": return baseWithExp + `\nNow output test.js only: 2-4 meaningful tests that verify the organ's real behavior (not trivial truths).\nABSOLUTE RULES:\n- No import statements anywhere in test.js — use the organ provided in the test context ({ el, loom, assert, organ }). The organ is already rendered into el before each test runs.\n- Each test starts with FRESH empty storage — never assume another test's data exists.\n- Select interactive elements ONLY via [data-action="..."] attributes (they are guaranteed by the organ contract); never by tag order or text.\n- Prefer asserting on loom.storage state over DOM text.\nCANONICAL INTERACTION PATTERNS (follow these exactly — they match the organ's mutation semantics):\n- MULTI-ADD: The input clears after each successful add. To add N items: set input.value = "first", click add, then set input.value = "second", click add again — set the value BEFORE each click, not once at the start.\n- STALE ELEMENTS: Re-query remove buttons and list rows after EVERY mutation. Never hold a NodeList or element reference across a click — use el.querySelectorAll('[data-action="remove"]')[i] freshly each time.\n- COUNT ASSERTIONS: Prefer loom.storage assertions for counts (e.g. loom.storage.get("items", []).length) over counting DOM nodes.`;
    case "repair": return baseWithExp + `\nYour previous file FAILED validation. You will be given the file and the exact errors. Output the COMPLETE corrected file in one fenced code block — fix the errors, keep the intended behavior, and follow every contract rule (especially: test.js must contain no import statements).`;
    case "edit": return baseWithExp + `\nYou are EDITING one existing file. Output ONLY SEARCH/REPLACE edit blocks in this exact format (no prose, no full file):\n<<<<<<< SEARCH\n(lines copied exactly from the current file)\n=======\n(replacement lines)\n>>>>>>> REPLACE`;
  }
}
