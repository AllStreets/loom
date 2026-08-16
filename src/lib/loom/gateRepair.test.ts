import { describe, it, expect, vi } from "vitest";
import { runGateWithRepair } from "./gateRepair";

const MANIFEST = JSON.stringify({ id: "runs", name: "Runs", description: "d", version: 1, permissions: ["storage"] });
const RENDERED_HTML = `<div><input data-action="new-item"><button data-action="add">Add</button></div>`;
const CODE = `export default { id: 'runs', render(el){ el.textContent='hi'; } }`;
const TESTS = `export const tests = [];`;

function mkGateOk() {
  return vi.fn().mockResolvedValue({
    ok: true,
    manifest: JSON.parse(MANIFEST),
    verdict: { ok: true, stage: "pass", errors: [], testResults: [], renderedHtml: RENDERED_HTML },
  });
}

function mkGateFail(stage: string, errors: string[]) {
  return vi.fn().mockResolvedValue({
    ok: false,
    verdict: { ok: false, stage, errors, testResults: [], renderedHtml: RENDERED_HTML },
  });
}

function mkEmit() {
  return vi.fn() as (phase: string, detail: string) => void;
}

describe("runGateWithRepair", () => {
  it("passes through immediately when gate is already green", async () => {
    const gate = mkGateOk();
    const chat = vi.fn();
    const result = await runGateWithRepair(
      { manifest: MANIFEST, code: CODE, tests: TESTS },
      "runs",
      { chat, gate, emit: mkEmit() },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.repairRounds).toBe(0);
    }
    expect(chat).not.toHaveBeenCalled();
    expect(gate).toHaveBeenCalledTimes(1);
  });

  it("repair chat uses temperature 0.0", async () => {
    const gate = vi.fn()
      .mockResolvedValueOnce({ ok: false, verdict: { ok: false, stage: "tests", errors: ["boom"], testResults: [], renderedHtml: RENDERED_HTML } })
      .mockResolvedValue({ ok: true, manifest: JSON.parse(MANIFEST), verdict: { ok: true, stage: "pass", errors: [], testResults: [], renderedHtml: RENDERED_HTML } });
    const chat = vi.fn().mockResolvedValue(`\`\`\`js\n${CODE}\n\`\`\``);
    await runGateWithRepair(
      { manifest: MANIFEST, code: CODE, tests: TESTS },
      "runs",
      { chat, gate, emit: mkEmit() },
    );
    expect(chat).toHaveBeenCalledOnce();
    const [, , opts] = chat.mock.calls[0];
    expect(opts).toMatchObject({ temperature: 0.0 });
  });

  it("QW-3: errors containing 'import' → test.js targeted on round 1 in tests stage", async () => {
    const gate = vi.fn()
      .mockResolvedValueOnce({ ok: false, verdict: { ok: false, stage: "tests", errors: ["cannot resolve import './organ.js'"], testResults: [], renderedHtml: RENDERED_HTML } })
      .mockResolvedValue({ ok: true, manifest: JSON.parse(MANIFEST), verdict: { ok: true, stage: "pass", errors: [], testResults: [], renderedHtml: RENDERED_HTML } });
    const chat = vi.fn().mockResolvedValue(`\`\`\`js\n${TESTS}\n\`\`\``);
    await runGateWithRepair(
      { manifest: MANIFEST, code: CODE, tests: TESTS },
      "runs",
      { chat, gate, emit: mkEmit() },
    );
    const [, messages] = chat.mock.calls[0];
    const userContent = messages[1].content as string;
    expect(userContent).toContain("test.js");
    expect(userContent).not.toContain("organ.js\n\nCURRENT");
  });

  it("QW-3: 'querySelector ... null' → organ.js targeted on round 1 in tests stage", async () => {
    const gate = vi.fn()
      .mockResolvedValueOnce({ ok: false, verdict: { ok: false, stage: "tests", errors: ["querySelector returned null"], testResults: [], renderedHtml: RENDERED_HTML } })
      .mockResolvedValue({ ok: true, manifest: JSON.parse(MANIFEST), verdict: { ok: true, stage: "pass", errors: [], testResults: [], renderedHtml: RENDERED_HTML } });
    const chat = vi.fn().mockResolvedValue(`\`\`\`js\n${CODE}\n\`\`\``);
    await runGateWithRepair(
      { manifest: MANIFEST, code: CODE, tests: TESTS },
      "runs",
      { chat, gate, emit: mkEmit() },
    );
    const [, messages] = chat.mock.calls[0];
    const userContent = messages[1].content as string;
    expect(userContent).toContain("organ.js");
    // The FILE header line must say organ.js
    expect(userContent.startsWith("FILE: organ.js")).toBe(true);
  });

  it("QW-2: priorAttempts text (with before/after) present in round-2+ repair prompts", async () => {
    // Round 1: gate fails with error "boom1"
    // Round 2: gate still fails with "boom2" — the round-2 chat prompt must mention round 1's before/after
    const gate = vi.fn()
      .mockResolvedValueOnce({ ok: false, verdict: { ok: false, stage: "tests", errors: ["boom1"], testResults: [], renderedHtml: RENDERED_HTML } })
      .mockResolvedValueOnce({ ok: false, verdict: { ok: false, stage: "tests", errors: ["boom2"], testResults: [], renderedHtml: RENDERED_HTML } })
      .mockResolvedValue({ ok: true, manifest: JSON.parse(MANIFEST), verdict: { ok: true, stage: "pass", errors: [], testResults: [], renderedHtml: RENDERED_HTML } });
    const chat = vi.fn().mockResolvedValue(`\`\`\`js\n${CODE}\n\`\`\``);
    await runGateWithRepair(
      { manifest: MANIFEST, code: CODE, tests: TESTS },
      "runs",
      { chat, gate, emit: mkEmit() },
    );
    expect(chat).toHaveBeenCalledTimes(2);
    const [, round2Messages] = chat.mock.calls[1];
    const round2User = round2Messages[1].content as string;
    // Must include PRIOR REPAIR ATTEMPTS section
    expect(round2User).toContain("PRIOR REPAIR ATTEMPTS");
    // Must include "before:" and "after:" with error lines
    expect(round2User).toContain("before:");
    expect(round2User).toContain("after:");
    // Must show the first round's pre-repair error
    expect(round2User).toContain("boom1");
  });

  it("repairRounds on failure is the real round count (not 0)", async () => {
    // All gate calls fail — exhausts 3 rounds
    const gate = vi.fn().mockResolvedValue({
      ok: false,
      verdict: { ok: false, stage: "tests", errors: ["still failing"], testResults: [], renderedHtml: RENDERED_HTML },
    });
    const chat = vi.fn().mockResolvedValue(`\`\`\`js\n${CODE}\n\`\`\``);
    const result = await runGateWithRepair(
      { manifest: MANIFEST, code: CODE, tests: TESTS },
      "runs",
      { chat, gate, emit: mkEmit() },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.repairRounds).toBe(3);
    }
  });
});
