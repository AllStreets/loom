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
       // loom.ui.tokens -> { bg, panel, t1, t2, t3, accent, go, warn, danger }  (CSS color strings)
       // loom.notify(text)                                                                          [needs "notify"]
     }
   }
   Style with inline styles using loom.ui.tokens. No external imports, no network, no document.cookie, no window.top.

3. test.js — an ES module:
   export const tests = [
     { name: "renders without crashing", fn: async ({ el, loom, assert }) => { /* ... */ } },
   ];
   Each fn gets a fresh el (organ already rendered into it), a mock loom api, and assert(cond, msg).

Rules: complete files only, no placeholders or TODOs; small and focused; real functionality, never filler.`;

export function organSystemPrompt(kind: "manifest" | "code" | "tests" | "edit"): string {
  const base = `You are the Loom, the build engine inside LOOM, a sovereign offline computer. You write organs.\n\n${ORGAN_CONTRACT}\n\nOutput ONLY the requested file content in a single fenced code block. No prose before or after.`;
  switch (kind) {
    case "manifest": return base + `\nNow output manifest.json only. Choose a short kebab-case id and the MINIMAL permissions the request needs.`;
    case "code": return base + `\nNow output organ.js only. It must match the manifest's id and only use APIs its permissions allow.`;
    case "tests": return base + `\nNow output test.js only: 2-4 meaningful tests that verify the organ's real behavior (not trivial truths).`;
    case "edit": return base + `\nYou are EDITING one existing file. Output ONLY SEARCH/REPLACE edit blocks in this exact format (no prose, no full file):\n<<<<<<< SEARCH\n(lines copied exactly from the current file)\n=======\n(replacement lines)\n>>>>>>> REPLACE`;
  }
}
