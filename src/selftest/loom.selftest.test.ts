// @vitest-environment node
import { describe, it, expect } from "vitest";
import { organSystemPrompt, ctxFor } from "../lib/loom/prompts";
import { extractCode, applyEditBlocks } from "../lib/loom/edits";
import { manifestGuard } from "../lib/loom/validate";
import { classifyByRules, classifyIntent } from "../lib/compiler/intent";
import { files as noteFiles } from "../organs/seeds/notes";
import { recordExperience, retrieveExemplars } from "../lib/loom/experience";
import type { BuildRecord } from "../lib/loom/experience";

// ── helpers ──────────────────────────────────────────────────────────────────

async function pickBuilder(): Promise<string> {
  const res = await fetch("http://localhost:11434/api/tags");
  if (!res.ok) throw new Error(`Ollama /api/tags returned ${res.status}`);
  const data = (await res.json()) as { models: { name: string }[] };
  const coders = data.models
    .map((m) => m.name)
    .filter((n) => n.toLowerCase().includes("coder"));
  if (!coders.length)
    throw new Error(
      "No model with 'coder' in its name found. Is Ollama running and the fleet pulled?"
    );
  // pick the one whose name contains the largest integer before the letter 'b'
  // e.g. "qwen3-coder:30b-a3b-q4_K_M" → 30, "qwen2.5-coder:7b" → 7
  function bestNum(name: string): number {
    let best = 0;
    for (const m of name.toLowerCase().matchAll(/(\d+(?:\.\d+)?)b/g)) {
      const v = parseFloat(m[1]);
      if (v > best) best = v;
    }
    return best;
  }
  coders.sort((a, b) => bestNum(b) - bestNum(a));
  return coders[0];
}

async function chat(model: string, system: string, user: string): Promise<string> {
  const body = JSON.stringify({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    stream: false,
    options: {
      temperature: 0.2,
      num_ctx: ctxFor(system.length + user.length),
    },
  });
  const res = await fetch("http://localhost:11434/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Ollama /api/chat returned ${res.status}`);
  const data = (await res.json()) as { message: { content: string } };
  return data.message.content;
}

// ── constants ─────────────────────────────────────────────────────────────────

const REPS = 3;

// A fixed valid manifest for the code task (so it doesn't depend on task-a)
const FIXED_MANIFEST = JSON.stringify({
  id: "run-tracker",
  name: "Run Tracker",
  description: "Track daily runs: distance and time.",
  version: 1,
  permissions: ["storage"],
});

// A small sample organ.js for the edit task
const SAMPLE_ORGAN = `export default {
  id: "run-tracker",
  render(el, loom) {
    const h = document.createElement("h2");
    h.textContent = "My Runs";
    el.appendChild(h);

    const list = document.createElement("ul");
    const runs = loom.storage.get("runs", []);
    for (const r of runs) {
      const li = document.createElement("li");
      li.textContent = r.distance + "km in " + r.time + "min";
      list.appendChild(li);
    }
    el.appendChild(list);

    const btn = document.createElement("button");
    btn.textContent = "Add Run";
    btn.onclick = () => {
      const distance = parseFloat(prompt("Distance (km)?") || "0");
      const time = parseFloat(prompt("Time (min)?") || "0");
      const runs = loom.storage.get("runs", []);
      runs.push({ distance, time });
      loom.storage.set("runs", runs);
    };
    el.appendChild(btn);
  }
};`;

// ── suite ─────────────────────────────────────────────────────────────────────

describe.skipIf(!process.env.SELFTEST)("loom selftest", { timeout: 300_000 }, () => {
  let model: string;

  it("picks a coder model", async () => {
    model = await pickBuilder();
    console.info(`[selftest] using model: ${model}`);
    expect(model).toBeTruthy();
  });

  it("build-manifest: 3 reps", async () => {
    const m = model ?? (await pickBuilder());
    const system = organSystemPrompt("manifest");
    const user = "Build an organ to track my daily runs (distance, time).";

    let passed = 0;
    for (let rep = 1; rep <= REPS; rep++) {
      const t0 = Date.now();
      const raw = await chat(m, system, user);
      const code = extractCode(raw);
      const result = manifestGuard(code);
      const ms = Date.now() - t0;
      if (result.ok) {
        passed++;
        console.info(`[build-manifest] rep ${rep} PASS (${ms}ms) id=${result.manifest.id}`);
      } else {
        console.info(`[build-manifest] rep ${rep} FAIL (${ms}ms) error=${result.error}`);
        console.info(`  raw:\n${raw.slice(0, 400)}`);
      }
      expect(result.ok, `rep ${rep}: ${result.ok ? "" : (result as { ok: false; error: string }).error}`).toBe(true);
    }
    console.info(`[build-manifest] ${passed}/${REPS} passed`);
  });

  it("build-organ-code: 3 reps", async () => {
    const m = model ?? (await pickBuilder());
    const system = organSystemPrompt("code");
    const user = `Manifest:\n${FIXED_MANIFEST}\n\nBuild the organ.js for a run tracker that lets the user log distance and time and view past runs.`;

    let passed = 0;
    for (let rep = 1; rep <= REPS; rep++) {
      const t0 = Date.now();
      const raw = await chat(m, system, user);
      const code = extractCode(raw);
      const ms = Date.now() - t0;

      const hasExportDefault = code.includes("export default");
      const hasRender = code.includes("render");
      // Accept both direct usage (loom.ui.card) and aliased usage (const ui = loom.ui; ui.card)
      const hasUiKit = code.includes("loom.ui.") || (code.includes("loom.ui") && /\bui\.(card|heading|button|input|list|listRow|stat|badge|empty|row|stack|progress)\b/.test(code));

      // strip module syntax so new Function can parse it
      const stripped = code
        .replace(/^export\s+default\s+/, "const __organ = ")
        .replace(/\bimport\b[^;]*;?\s*/g, "");

      let fnOk = false;
      let fnErr = "";
      try {
        new Function(stripped);
        fnOk = true;
      } catch (e) {
        fnErr = String(e);
      }

      if (hasExportDefault && hasRender && fnOk && hasUiKit) {
        passed++;
        console.info(`[build-organ-code] rep ${rep} PASS (${ms}ms)`);
      } else {
        console.info(
          `[build-organ-code] rep ${rep} FAIL (${ms}ms) exportDefault=${hasExportDefault} render=${hasRender} fnOk=${fnOk} hasUiKit=${hasUiKit} fnErr=${fnErr}`
        );
        console.info(`  code snippet:\n${code.slice(0, 400)}`);
      }

      expect(hasExportDefault, `rep ${rep}: missing 'export default'`).toBe(true);
      expect(hasRender, `rep ${rep}: missing 'render'`).toBe(true);
      expect(fnOk, `rep ${rep}: new Function threw: ${fnErr}`).toBe(true);
      expect(hasUiKit, `rep ${rep}: organ does not use loom.ui kit (expected loom.ui.factory or const ui = loom.ui + ui.factory calls)`).toBe(true);
    }
    console.info(`[build-organ-code] ${passed}/${REPS} passed`);
  });

  it("build-tests: 3 reps — test.js must be import-free and use the organ context", async () => {
    const m = model ?? (await pickBuilder());
    const system = organSystemPrompt("tests");
    const user = `Manifest:\n${FIXED_MANIFEST}\n\nCode:\n${SAMPLE_ORGAN}\n\nWrite test.js for this organ.`;

    let passed = 0;
    for (let rep = 1; rep <= REPS; rep++) {
      const t0 = Date.now();
      const raw = await chat(m, system, user);
      const code = extractCode(raw);
      const ms = Date.now() - t0;

      const hasTests = code.includes("export const tests");
      // the failure mode seen live: `import ... from './organ.js'` cannot resolve in the sandbox
      const hasImport = /^\s*import\b/m.test(code) || code.includes("./organ.js");

      if (hasTests && !hasImport) {
        passed++;
        console.info(`[build-tests] rep ${rep} PASS (${ms}ms)`);
      } else {
        console.info(`[build-tests] rep ${rep} FAIL (${ms}ms) hasTests=${hasTests} hasImport=${hasImport}`);
        console.info(`  code snippet:\n${code.slice(0, 400)}`);
      }
      expect(hasTests, `rep ${rep}: missing 'export const tests'`).toBe(true);
      expect(hasImport, `rep ${rep}: test.js contains an import (sandbox cannot resolve imports)`).toBe(false);
    }
    console.info(`[build-tests] ${passed}/${REPS} passed`);
  });

  it("edit-blocks: 3 reps", async () => {
    const m = model ?? (await pickBuilder());
    const system = organSystemPrompt("edit");
    const user = `Current file (organ.js):\n\`\`\`js\n${SAMPLE_ORGAN}\n\`\`\`\n\nRequest: Change the heading text to 'Run Log'.`;

    let passed = 0;
    for (let rep = 1; rep <= REPS; rep++) {
      const t0 = Date.now();
      const raw = await chat(m, system, user);
      const ms = Date.now() - t0;

      let applied: string | null = null;
      let applyErr = "";
      try {
        applied = applyEditBlocks(SAMPLE_ORGAN, raw);
      } catch (e) {
        applyErr = String(e);
      }

      const containsRunLog = applied != null && applied.includes("Run Log");

      if (applied != null && containsRunLog) {
        passed++;
        console.info(`[edit-blocks] rep ${rep} PASS (${ms}ms)`);
      } else {
        console.info(
          `[edit-blocks] rep ${rep} FAIL (${ms}ms) applied=${applied != null} containsRunLog=${containsRunLog} err=${applyErr}`
        );
        console.info(`  raw:\n${raw.slice(0, 500)}`);
      }

      expect(applied, `rep ${rep}: applyEditBlocks returned null (err: ${applyErr})`).not.toBeNull();
      expect(containsRunLog, `rep ${rep}: result does not contain "Run Log"`).toBe(true);
    }
    console.info(`[edit-blocks] ${passed}/${REPS} passed`);
  });

  it("intent-compile: 6 canned utterances (no model)", () => {
    // organIds available for these tests
    const organIds = ["water-tracker", "notes"];

    const cases: Array<{
      utterance: string;
      expectedIntent: string;
      expectedOrganId?: string;
    }> = [
      { utterance: "add a delete button to the water tracker", expectedIntent: "edit_organ", expectedOrganId: "water-tracker" },
      { utterance: "build me a habit tracker", expectedIntent: "build_organ" },
      { utterance: "hello there", expectedIntent: "converse" },
      { utterance: "notes", expectedIntent: "act_on_organ", expectedOrganId: "notes" },
      { utterance: "make me a budget tool", expectedIntent: "build_organ" },
      { utterance: "change the notes heading", expectedIntent: "edit_organ", expectedOrganId: "notes" },
    ];

    for (const { utterance, expectedIntent, expectedOrganId } of cases) {
      const result = classifyByRules(utterance, organIds);
      expect(result, `"${utterance}" → rules returned null`).not.toBeNull();
      expect(result!.intent, `"${utterance}" → wrong intent`).toBe(expectedIntent);
      if (expectedOrganId !== undefined) {
        expect(result!.organId, `"${utterance}" → wrong organId`).toBe(expectedOrganId);
      }
      expect(result!.source, `"${utterance}" → wrong source`).toBe("rules");
      console.info(
        `[intent-compile] "${utterance}" → ${result!.intent}${result!.organId ? "/" + result!.organId : ""} (confidence=${result!.confidence})`
      );
    }
  });

  it("intent-compile: 1 rules-unsure utterance through real rewriter model", async () => {
    // This utterance deliberately has no organ mention, no build phrase, no greeting —
    // rules will return null and the real model must classify it.
    const utterance = "hmm what about the thing from yesterday";

    // Wire askModel to the real rewriter via Ollama /api/chat directly
    async function askModel(prompt: string): Promise<string> {
      const body = JSON.stringify({
        model: "qwen3:1.7b",
        messages: [{ role: "user", content: prompt }],
        stream: false,
        options: { temperature: 0.1, num_ctx: 2048 },
      });
      const res = await fetch("http://localhost:11434/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`Ollama /api/chat returned ${res.status}`);
      const data = (await res.json()) as { message: { content: string } };
      return data.message.content;
    }

    const t0 = Date.now();
    const result = await classifyIntent(utterance, [], askModel);
    const ms = Date.now() - t0;

    const VALID_INTENTS = new Set(["build_organ", "edit_organ", "act_on_organ", "converse"]);

    console.info(
      `[intent-compile] model-path: "${utterance}" → ${result.intent} (source=${result.source}, confidence=${result.confidence}, ${ms}ms)`
    );

    expect(VALID_INTENTS.has(result.intent), `intent "${result.intent}" is not a valid Intent value`).toBe(true);
    expect(["rules", "model"] as string[]).toContain(result.source);
  });

  it("tests-grounded-in-dom: 3 reps — test.js selectors must match provided rendered HTML", async () => {
    const m = model ?? (await pickBuilder());

    // A hand-written movie-list DOM that the model must ground its selectors in.
    // This is exactly the kind of DOM a real movie-tracker organ would produce.
    const MOVIE_DOM = `<div><div><input data-action="new-movie" placeholder="Movie title..."><button data-action="add">Add</button></div><ul data-action="list"><li>Inception <button data-action="remove">x</button></li></ul></div>`;

    const MOVIE_MANIFEST = JSON.stringify({
      id: "movie-tracker",
      name: "Movie Tracker",
      description: "Track movies to watch.",
      version: 1,
      permissions: ["storage"],
    });

    const MOVIE_CODE = `export default {
  id: "movie-tracker",
  render(el, loom) {
    const ui = loom.ui;
    const { root, body } = ui.card({ title: "Movie Tracker" });
    const input = ui.input({ placeholder: "Movie title...", action: "new-movie" });
    const addBtn = ui.button("Add", { action: "add" });
    const row = ui.row(input, addBtn);
    const listContainer = ui.list();
    listContainer.root.dataset.action = "list";
    const render = () => {
      listContainer.clear();
      const movies = loom.storage.get("movies", []);
      movies.forEach((title, i) => {
        const item = ui.listRow(title, { onRemove: () => {
          const ms = loom.storage.get("movies", []);
          ms.splice(i, 1);
          loom.storage.set("movies", ms);
          render();
        }});
        // mark remove buttons
        const rmBtn = item.querySelector("button");
        if (rmBtn) rmBtn.dataset.action = "remove";
        listContainer.add(item);
      });
    };
    addBtn.addEventListener("click", () => {
      const val = input.value.trim();
      if (!val) return;
      const movies = loom.storage.get("movies", []);
      movies.push(val);
      loom.storage.set("movies", movies);
      input.value = "";
      render();
    });
    body.appendChild(row);
    body.appendChild(listContainer.root);
    el.appendChild(root);
    render();
  }
};`;

    const system = organSystemPrompt("tests");
    // Give the model the real DOM — this is the DOM-grounded tests-gen prompt
    const user =
      `Manifest:\n${MOVIE_MANIFEST}\n\nCode:\n${MOVIE_CODE}\n\n` +
      `The organ's ACTUAL rendered HTML (ground truth — your selectors MUST match elements present here):\n${MOVIE_DOM}`;

    // Extract all data-action values from the DOM
    function extractDomActions(html: string): Set<string> {
      const actions = new Set<string>();
      for (const m of html.matchAll(/data-action="([^"]+)"/g)) {
        actions.add(m[1]);
      }
      return actions;
    }

    // Extract data-action references from test.js source
    function extractTestActions(src: string): Set<string> {
      const actions = new Set<string>();
      for (const m of src.matchAll(/\[data-action="([^"]+)"\]/g)) {
        actions.add(m[1]);
      }
      return actions;
    }

    // Count .value = assignments and [data-action="add"] click patterns
    function countValueAssignments(src: string): number {
      return (src.match(/\.value\s*=/g) ?? []).length;
    }
    function countAddClicks(src: string): number {
      // Form 1: chained querySelector('[data-action="add"]').click()
      const chainedPattern = /\[data-action="add"\][^;]*\.click\(\)/g;
      const chainedCount = (src.match(chainedPattern) ?? []).length;

      // Form 2: separated variable — const b = el.querySelector('[data-action="add"]'); b.click()
      // Find variable names assigned from add-selector queries
      const addVarPattern = /(?:const|let|var)\s+(\w+)\s*=\s*[^;]*\[data-action="add"\]/g;
      const addVarNames: string[] = [];
      for (const m of src.matchAll(addVarPattern)) {
        addVarNames.push(m[1]);
      }
      let separatedCount = 0;
      for (const varName of addVarNames) {
        // count how many times varName.click() appears
        const varClickPattern = new RegExp("\\b" + varName + "\\s*\\.click\\(\\)", "g");
        separatedCount += (src.match(varClickPattern) ?? []).length;
      }

      return chainedCount + separatedCount;
    }

    const domActions = extractDomActions(MOVIE_DOM);

    let passed = 0;
    for (let rep = 1; rep <= REPS; rep++) {
      const t0 = Date.now();
      const raw = await chat(m, system, user);
      const code = extractCode(raw);
      const ms = Date.now() - t0;

      const hasTests = code.includes("export const tests");
      const hasImport = /^\s*import\b/m.test(code) || code.includes("./organ.js");

      // Check that all data-action selectors used in the test exist in the DOM
      const testActions = extractTestActions(code);
      const unknownActions: string[] = [];
      for (const action of testActions) {
        if (!domActions.has(action)) unknownActions.push(action);
      }
      const selectorsGrounded = unknownActions.length === 0;

      // Multi-add compliance: if test clicks add >= 2 times, it must set .value at least as many times
      const addClicks = countAddClicks(code);
      const valueAssigns = countValueAssignments(code);
      const multiAddOk = addClicks < 2 || valueAssigns >= addClicks;

      const ok = hasTests && !hasImport && selectorsGrounded && multiAddOk;
      if (ok) {
        passed++;
        console.info(`[tests-grounded-in-dom] rep ${rep} PASS (${ms}ms) addClicks=${addClicks} valueAssigns=${valueAssigns}`);
      } else {
        console.info(
          `[tests-grounded-in-dom] rep ${rep} FAIL (${ms}ms) hasTests=${hasTests} hasImport=${hasImport} unknownActions=${JSON.stringify(unknownActions)} multiAddOk=${multiAddOk}(clicks=${addClicks},assigns=${valueAssigns})`
        );
        console.info(`  code snippet:\n${code.slice(0, 600)}`);
      }

      expect(hasTests, `rep ${rep}: missing 'export const tests'`).toBe(true);
      expect(hasImport, `rep ${rep}: test.js contains an import`).toBe(false);
      expect(selectorsGrounded, `rep ${rep}: test uses unknown data-action selectors: ${JSON.stringify(unknownActions)} (DOM has: ${JSON.stringify([...domActions])})`).toBe(true);
      expect(multiAddOk, `rep ${rep}: multi-add pattern violation — ${addClicks} add clicks but only ${valueAssigns} .value= assignments`).toBe(true);
    }
    console.info(`[tests-grounded-in-dom] ${passed}/${REPS} passed`);
  });

  it("build-dashboardy-organ: 3 reps — model reaches for hero pattern", async () => {
    const m = model ?? (await pickBuilder());
    const system = organSystemPrompt("code");
    const DASH_MANIFEST = JSON.stringify({
      id: "step-counter",
      name: "Step Counter",
      description: "Daily step count with a goal.",
      version: 1,
      permissions: ["storage"],
    });
    const user = `Manifest:\n${DASH_MANIFEST}\n\nBuild an organ showing my daily step count with a goal.`;

    let passed = 0;
    for (let rep = 1; rep <= REPS; rep++) {
      const t0 = Date.now();
      const raw = await chat(m, system, user);
      const code = extractCode(raw);
      const ms = Date.now() - t0;

      const hasExportDefault = code.includes("export default");
      const hasRender = code.includes("render");
      // Hero pattern: model must reach for ui.hero, ui.progress, or ui.stat
      const hasHeroPattern =
        code.includes("ui.hero") ||
        code.includes("ui.progress") ||
        code.includes("ui.stat") ||
        code.includes("loom.ui.hero") ||
        code.includes("loom.ui.progress") ||
        code.includes("loom.ui.stat");

      const stripped = code
        .replace(/^export\s+default\s+/, "const __organ = ")
        .replace(/\bimport\b[^;]*;?\s*/g, "");
      let fnOk = false;
      let fnErr = "";
      try {
        new Function(stripped);
        fnOk = true;
      } catch (e) {
        fnErr = String(e);
      }

      const ok = hasExportDefault && hasRender && fnOk && hasHeroPattern;
      if (ok) {
        passed++;
        console.info(`[build-dashboardy-organ] rep ${rep} PASS (${ms}ms) heroPattern=${hasHeroPattern}`);
      } else {
        console.info(
          `[build-dashboardy-organ] rep ${rep} FAIL (${ms}ms) exportDefault=${hasExportDefault} render=${hasRender} fnOk=${fnOk} heroPattern=${hasHeroPattern} fnErr=${fnErr}`
        );
        console.info(`  code snippet:\n${code.slice(0, 400)}`);
      }

      expect(hasExportDefault, `rep ${rep}: missing 'export default'`).toBe(true);
      expect(hasRender, `rep ${rep}: missing 'render'`).toBe(true);
      expect(fnOk, `rep ${rep}: new Function threw: ${fnErr}`).toBe(true);
      expect(hasHeroPattern, `rep ${rep}: organ does not use a hero pattern (ui.hero / ui.progress / ui.stat)`).toBe(true);
    }
    console.info(`[build-dashboardy-organ] ${passed}/${REPS} passed`);
  });

  it("exemplars-injected: organSystemPrompt with exemplars injects EXPERIENCE block", () => {
    const withExemplars = organSystemPrompt("code", {
      exemplars: "PAST SUCCESSFUL BUILD (request: \"track my runs\", passed in 0 repair rounds):\nexport default { id: \"run-tracker\" }",
      lessons: "A similar past build (\"track my runs\") failed at stage tests with: querySelector returned null. Avoid that failure mode.",
    });
    const withoutExemplars = organSystemPrompt("code");
    expect(withExemplars).toContain("EXPERIENCE — PAST SUCCESSFUL BUILDS");
    expect(withExemplars).toContain("LESSONS FROM PAST FAILURES");
    expect(withExemplars).toContain("track my runs");
    expect(withExemplars.length).toBeGreaterThan(withoutExemplars.length);
    console.info(`[exemplars-injected] prompt with exemplars is ${withExemplars.length - withoutExemplars.length} chars longer`);
  });

  it("exemplars-store-growth: seeded record is retrievable; recordExperience grows the store", () => {
    // Selftest runs in Node where localStorage does not exist — install a minimal
    // in-memory shim for this test so the store assertions run for real instead of
    // silently skipping. Removed in finally.
    const mem = new Map<string, string>();
    // @ts-expect-error minimal shim for the Node selftest environment
    globalThis.localStorage = {
      getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
      setItem: (k: string, v: string) => { mem.set(k, String(v)); },
      removeItem: (k: string) => { mem.delete(k); },
      clear: () => { mem.clear(); },
    };
    try {

    // Seed a successful counter-organ record
    const COUNTER_RECORD: BuildRecord = {
      ts: Date.now() - 1000,
      kind: "build",
      request: "build a counter organ that increments a number",
      organId: "counter",
      ok: true,
      repairRounds: 0,
      manifest: JSON.stringify({ id: "counter", name: "Counter", description: "Increment a number.", version: 1, permissions: ["storage"] }),
      code: `export default { id: "counter", render(el, loom) { const ui = loom.ui; const count = loom.storage.get("count", 0); const stat = ui.stat("count", count); const btn = ui.button("Increment", { action: "increment", onClick: () => { const c = loom.storage.get("count", 0) + 1; loom.storage.set("count", c); ui.setStat(stat, c); } }); el.appendChild(stat); el.appendChild(btn); } }`,
      tests: `export const tests = [{ name: "renders", fn: async ({el, assert}) => { assert(el.textContent.length > 0, "renders"); } }]`,
    };

    recordExperience(COUNTER_RECORD);

    // The store must now contain the seeded record — verify via retrieval (hard assertion:
    // the shim guarantees a working store)
    const exemplars = retrieveExemplars("counter organ increment", 5);
    expect(exemplars, "seeded counter record must be retrievable").toContain("counter");
    console.info("[exemplars-store-growth] seeded counter record is retrievable from store");

    // Now record a second (synthetic) success and verify store count grew
    const before = (() => {
      const raw = localStorage.getItem("loom.exp.v1");
      if (!raw) return 0;
      return (JSON.parse(raw) as unknown[]).length;
    })();
    expect(before, "store must contain the seeded record").toBeGreaterThanOrEqual(1);

    recordExperience({
      ts: Date.now(),
      kind: "build",
      request: "build a counter organ that increments a number",
      organId: "counter-v2",
      ok: true,
      repairRounds: 0,
    });

    const after = (() => {
      const raw = localStorage.getItem("loom.exp.v1");
      if (!raw) return 0;
      return (JSON.parse(raw) as unknown[]).length;
    })();

    // The store MUST have grown by >= 1 (hard assertion — no environment skip)
    expect(after).toBeGreaterThanOrEqual(before + 1);
    console.info(`[exemplars-store-growth] store grew from ${before} to ${after} records`);
    } finally {
      // Remove the shim so no other selftest task sees a fake localStorage
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  it("edit-organ: 3 reps — notes seed organ.js heading change", async () => {
    const m = model ?? (await pickBuilder());

    // Pull organ.js content from the notes seed directly
    const organJsFile = noteFiles.find((f) => f.name === "organ.js");
    expect(organJsFile, "notes seed organ.js not found").toBeTruthy();
    const notesOrganJs = organJsFile!.content;

    const system = organSystemPrompt("edit");
    const user = `Current file (organ.js):\n\`\`\`js\n${notesOrganJs}\n\`\`\`\n\nRequest: Change the heading text to 'My Notes'.`;

    let passed = 0;
    for (let rep = 1; rep <= REPS; rep++) {
      const t0 = Date.now();
      const raw = await chat(m, system, user);
      const ms = Date.now() - t0;

      let applied: string | null = null;
      let applyErr = "";
      try {
        applied = applyEditBlocks(notesOrganJs, raw);
      } catch (e) {
        applyErr = String(e);
      }

      const containsMyNotes = applied != null && applied.includes("My Notes");

      if (applied != null && containsMyNotes) {
        passed++;
        console.info(`[edit-organ] rep ${rep} PASS (${ms}ms)`);
      } else {
        console.info(
          `[edit-organ] rep ${rep} FAIL (${ms}ms) applied=${applied != null} containsMyNotes=${containsMyNotes} err=${applyErr}`
        );
        console.info(`  raw:\n${raw.slice(0, 500)}`);
      }

      expect(applied, `rep ${rep}: applyEditBlocks returned null (err: ${applyErr})`).not.toBeNull();
      expect(containsMyNotes, `rep ${rep}: result does not contain "My Notes"`).toBe(true);
    }
    console.info(`[edit-organ] ${passed}/${REPS} passed`);
  });
});
