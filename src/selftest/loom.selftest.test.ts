// @vitest-environment node
import { describe, it, expect } from "vitest";
import { organSystemPrompt, ctxFor } from "../lib/loom/prompts";
import { extractCode, applyEditBlocks } from "../lib/loom/edits";
import { manifestGuard } from "../lib/loom/validate";
import { classifyByRules, classifyIntent } from "../lib/compiler/intent";
import { files as noteFiles } from "../organs/seeds/notes";

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
