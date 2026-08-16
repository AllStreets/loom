import { describe, it, expect, beforeEach, vi } from "vitest";
import { recordExperience, retrieveExemplars, retrieveLessons, exportCorpus } from "./experience";
import type { BuildRecord } from "./experience";

// Mock localStorage
const store: Record<string, string> = {};
const localStorageMock = {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => { store[k] = v; },
  removeItem: (k: string) => { delete store[k]; },
  clear: () => { for (const k of Object.keys(store)) delete store[k]; },
};
vi.stubGlobal("localStorage", localStorageMock);
vi.stubGlobal("window", { __loomExportCorpus: undefined });

function makeRecord(overrides: Partial<BuildRecord> = {}): BuildRecord {
  return {
    ts: Date.now(),
    kind: "build",
    request: "track my runs",
    organId: "run-tracker",
    ok: true,
    repairRounds: 0,
    manifest: '{"id":"run-tracker"}',
    code: 'export default { id: "run-tracker", render(el,loom){} }',
    tests: 'export const tests = [];',
    ...overrides,
  };
}

describe("experience store", () => {
  beforeEach(() => { localStorageMock.clear(); });

  it("round-trips a record", () => {
    const r = makeRecord();
    recordExperience(r);
    expect(retrieveExemplars(r.request, 5)).toContain("run-tracker");
  });

  it("evicts oldest records when over cap (200)", () => {
    for (let i = 0; i < 201; i++) {
      recordExperience(makeRecord({ request: `request ${i}`, organId: `org-${i}`, ts: i }));
    }
    // After 201 insertions, we keep 200; the oldest (request 0) is evicted.
    // "request 200" should be present: query it directly (it scores highest on "request 200" token match).
    const exemplarsFor200 = retrieveExemplars("request 200", 5);
    expect(exemplarsFor200).toContain("request 200");
    // "request 0" was the oldest and got evicted.
    // Verify: query with a huge k — "request 0" should never appear in any PAST BUILD header.
    const allExemplars = retrieveExemplars("request", 200);
    // The header format is: PAST SUCCESSFUL BUILD (request: "request 0", ...)
    expect(allExemplars).not.toContain('request: "request 0"');
    // But request 200 IS there
    expect(allExemplars).toContain('request: "request 200"');
  });

  it("returns empty string when no records", () => {
    expect(retrieveExemplars("anything", 5)).toBe("");
  });

  it("returns empty string when score threshold not met", () => {
    recordExperience(makeRecord({ request: "completely unrelated xyz topic" }));
    expect(retrieveExemplars("alpha bravo charlie delta", 5)).toBe("");
  });

  it("scoring: more overlap = higher rank", () => {
    recordExperience(makeRecord({ request: "track my runs daily", organId: "run-tracker", code: "// run-tracker" }));
    recordExperience(makeRecord({ request: "a todo list for shopping", organId: "todo", code: "// todo" }));
    const result = retrieveExemplars("track runs", 2);
    const runPos = result.indexOf("run-tracker");
    const todoPos = result.indexOf("todo");
    // run-tracker should appear before todo (better overlap)
    expect(runPos).not.toBe(-1);
    // todo may not appear at all if score=0
    // If both appear, run-tracker first
    if (todoPos !== -1) expect(runPos).toBeLessThan(todoPos);
  });

  it("retrieveLessons returns one-line anti-patterns from FAILED records", () => {
    recordExperience(makeRecord({ ok: false, stage: "tests", errors: ["querySelector returned null\nmore detail"], request: "track my runs" }));
    const lessons = retrieveLessons("track runs", 5);
    expect(lessons).toContain("failed at stage tests");
    expect(lessons).toContain("querySelector returned null");
    expect(lessons).not.toContain("more detail"); // only first error line
  });

  it("retrieveLessons returns empty string when no failed records match", () => {
    recordExperience(makeRecord({ ok: true }));
    expect(retrieveLessons("anything", 5)).toBe("");
  });

  it("exportCorpus produces JSONL with prompt/completion/verdict triples", () => {
    recordExperience(makeRecord({ ok: true, manifest: '{"id":"r"}', code: "export default {}", tests: "export const tests = [];" }));
    recordExperience(makeRecord({ ok: false, manifest: '{"id":"bad"}', code: "bad code", stage: "tests" }));
    const corpus = exportCorpus();
    const lines = corpus.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(4); // 2 records * 3 phases = 6 lines
    for (const line of lines) {
      const obj = JSON.parse(line);
      expect(obj).toHaveProperty("prompt");
      expect(obj).toHaveProperty("completion");
      expect(obj).toHaveProperty("verdict");
      expect(["pass", "fail"]).toContain(obj.verdict);
    }
  });
});
