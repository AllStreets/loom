import { describe, it, expect, vi } from "vitest";
import { buildOrgan } from "./build";

const MANIFEST = JSON.stringify({ id: "runs", name: "Runs", description: "d", version: 1, permissions: ["storage"] });

function mkDeps(overrides: Partial<Parameters<typeof buildOrgan>[1]> = {}) {
  const chat = vi.fn()
    .mockResolvedValueOnce("```json\n" + MANIFEST + "\n```")
    .mockResolvedValueOnce("```js\nexport default { id: 'runs', render(el){ el.textContent='hi'; } }\n```")
    .mockResolvedValueOnce("```js\nexport const tests = [];\n```");
  const write = vi.fn().mockResolvedValue("sha123");
  const gate = vi.fn().mockResolvedValue({ ok: true, manifest: JSON.parse(MANIFEST), verdict: { ok: true, stage: "pass", errors: [], testResults: [] } });
  return { chat, write, gate, ...overrides };
}

describe("buildOrgan", () => {
  it("happy path: manifest -> code -> tests -> gate -> write, committing with the organ id", async () => {
    const deps = mkDeps();
    const r = await buildOrgan("track my runs", deps);
    expect(r.ok).toBe(true);
    expect(r.organId).toBe("runs");
    expect(r.sha).toBe("sha123");
    expect(deps.chat).toHaveBeenCalledTimes(3);
    expect(deps.write).toHaveBeenCalledWith("runs",
      expect.arrayContaining([expect.objectContaining({ name: "manifest.json" })]),
      expect.stringContaining("runs"));
  });
  it("attempts ONE repair on gate failure, then fails without writing if still red", async () => {
    const deps = mkDeps({ gate: vi.fn().mockResolvedValue({ ok: false, verdict: { ok: false, stage: "render", errors: ["boom"], testResults: [] } }) });
    // 4th chat call = the repair round
    deps.chat.mockResolvedValueOnce("```js\nexport default { id: 'runs', render(el){ el.textContent='fixed'; } }\n```");
    const r = await buildOrgan("x", deps);
    expect(r.ok).toBe(false);
    expect(r.stage).toBe("render");
    expect(deps.chat).toHaveBeenCalledTimes(4);      // manifest, code, tests, repair
    expect(deps.gate).toHaveBeenCalledTimes(2);      // initial + revalidation
    expect(deps.write).not.toHaveBeenCalled();
    expect(r.error).toContain("boom");
    // the repair prompt carried the error and the broken file
    const repairCall = deps.chat.mock.calls[3];
    expect(repairCall[1][1].content).toContain("boom");
    expect(repairCall[1][1].content).toContain("organ.js");
  });
  it("repairs test.js when the tests stage fails, then writes on green", async () => {
    const gate = vi.fn()
      .mockResolvedValueOnce({ ok: false, verdict: { ok: false, stage: "tests", errors: ["adds water: fails"], testResults: [] } })
      .mockResolvedValueOnce({ ok: true, manifest: JSON.parse(MANIFEST), verdict: { ok: true, stage: "pass", errors: [], testResults: [] } });
    const deps = mkDeps({ gate });
    deps.chat.mockResolvedValueOnce("```js\nexport const tests = [{ name: 'fixed', fn: async ({assert}) => assert(true) }];\n```");
    const r = await buildOrgan("track water", deps);
    expect(r.ok).toBe(true);
    expect(deps.chat).toHaveBeenCalledTimes(4);
    // the REPAIRED tests content is what gets written
    const written = deps.write.mock.calls[0][1].find((f: { name: string }) => f.name === "test.js");
    expect(written.content).toContain("fixed");
  });
  it("never writes when the manifest is invalid", async () => {
    const deps = mkDeps({ chat: vi.fn().mockResolvedValue("not json at all") });
    const r = await buildOrgan("x", deps);
    expect(r.ok).toBe(false);
    expect(deps.write).not.toHaveBeenCalled();
  });
  it("rejects a concurrent build", async () => {
    const slowGate = vi.fn().mockImplementation(() => new Promise((res) => setTimeout(() => res({ ok: false, verdict: { ok: false, stage: "load", errors: ["x"], testResults: [] } }), 50)));
    const deps = mkDeps({ gate: slowGate });
    const first = buildOrgan("a", deps);
    const second = await buildOrgan("b", mkDeps());
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/already running/i);
    await first;
  });
});
