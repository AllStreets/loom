export const PERMISSIONS = ["storage", "model", "notify"] as const;
export type Permission = (typeof PERMISSIONS)[number];

export function ctxFor(chars: number): number {
  const tokens = Math.ceil((chars * 2) / 3.3) + 3000;
  return Math.min(32768, Math.max(8192, Math.ceil(tokens / 2048) * 2048));
}

export const ORGAN_CONTRACT = `An ORGAN is a small self-contained tool inside LOOM, made of exactly three files:

1. manifest.json — {"id": "<kebab-case>", "name": "<Display Name>", "description": "<one line>", "version": 1, "permissions": [...]}
   Allowed permissions (request ONLY what the organ truly needs): "storage" (persistent key-value store), "model" (chat with the local model), "notify" (show a notification).

2. organ.js — an ES module:
   export default {
     id: "<same id>",
     render(el, loom) {
       // el: the organ's root HTMLElement (render all UI inside it)
       // loom.storage.get(key, fallback) / loom.storage.set(key, value) / loom.storage.del(key)  [needs "storage"]
       // await loom.model.chat([{role:"user",content:"..."}]) -> string                            [needs "model"]
       // loom.notify(text)                                                                          [needs "notify"]

       // loom.ui — design kit (always available, no permission needed):
       //   loom.ui.tokens                           -> { bg, panel, t1, t2, t3, accent, go, warn, danger }
       //   loom.ui.heading(text, sub?)              -> header block (17px t1 + optional 12.5px t2 sub)
       //   loom.ui.card(opts?)                      -> { root, body } glass panel (opts.title = mono eyebrow)
       //   loom.ui.button(label, opts?)             -> <button> (variant: "primary"|"ghost"|"danger"; opts.action, opts.onClick)
       //   loom.ui.input(opts?)                     -> <input> (opts.placeholder, opts.action, opts.onEnter, opts.value)
       //   loom.ui.row(...children)                 -> flex row, gap 8, align-center
       //   loom.ui.stack(...children)               -> flex column, gap 8
       //   loom.ui.stat(label, value)               -> big mono accent value over small uppercase label
       //   loom.ui.setStat(statEl, value)           -> update stat value in place
       //   loom.ui.progress(pct)                    -> progress bar element with .set(pct) method
       //   loom.ui.list()                           -> { root, add(el), clear() } column list container
       //   loom.ui.listRow(text, opts?)             -> panel row with text; opts.onRemove adds a ghost x button
       //   loom.ui.badge(text, tone?)               -> mono pill (tones: accent/go/warn/danger/muted)
       //   loom.ui.empty(text)                      -> centered t3 empty-state message

       // DESIGN LANGUAGE:
       //   Compose loom.ui primitives — never hand-roll styled divs.
       //   Ad-hoc style ONLY for layout spacing (margin/flex gap between sections).
       //   One accent moment per organ: a stat, a progress bar, or a primary button — not all.
       //   Generous whitespace; small text uses t2/t3; hierarchy = heading -> content -> actions.
       //   Empty states use loom.ui.empty(). Lists use loom.ui.list() + loom.ui.listRow().
     }
   }
   No external imports, no network, no document.cookie, no window.top.
   EVERY interactive element (buttons, inputs) MUST set a data-action attribute naming what it does, e.g.
   button.dataset.action = "add"; input.dataset.action = "new-item"; deleteBtn.dataset.action = "remove".
   These are the STABLE selectors the tests use — without them the tests cannot find your elements.

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

export function organSystemPrompt(kind: "manifest" | "code" | "tests" | "edit" | "repair"): string {
  const base = `You are the Loom, the build engine inside LOOM, a sovereign offline computer. You write organs.\n\n${ORGAN_CONTRACT}\n\nOutput ONLY the requested file content in a single fenced code block. No prose before or after.`;
  switch (kind) {
    case "manifest": return base + `\nNow output manifest.json only. Choose a short kebab-case id and the MINIMAL permissions the request needs.`;
    case "code": return base + `\nNow output organ.js only. It must match the manifest's id and only use APIs its permissions allow.\nBuild the UI ONLY from loom.ui factories (plus plain layout containers for top-level spacing). Never hand-roll styled divs — use loom.ui.card, loom.ui.heading, loom.ui.button, loom.ui.input, loom.ui.list, loom.ui.listRow, loom.ui.stat, loom.ui.badge, loom.ui.empty, etc.`;
    case "tests": return base + `\nNow output test.js only: 2-4 meaningful tests that verify the organ's real behavior (not trivial truths).\nABSOLUTE RULES:\n- No import statements anywhere in test.js — use the organ provided in the test context ({ el, loom, assert, organ }). The organ is already rendered into el before each test runs.\n- Each test starts with FRESH empty storage — never assume another test's data exists.\n- Select interactive elements ONLY via [data-action="..."] attributes (they are guaranteed by the organ contract); never by tag order or text.\n- Prefer asserting on loom.storage state over DOM text.`;
    case "repair": return base + `\nYour previous file FAILED validation. You will be given the file and the exact errors. Output the COMPLETE corrected file in one fenced code block — fix the errors, keep the intended behavior, and follow every contract rule (especially: test.js must contain no import statements).`;
    case "edit": return base + `\nYou are EDITING one existing file. Output ONLY SEARCH/REPLACE edit blocks in this exact format (no prose, no full file):\n<<<<<<< SEARCH\n(lines copied exactly from the current file)\n=======\n(replacement lines)\n>>>>>>> REPLACE`;
  }
}
