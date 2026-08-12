import { describe, it, expect } from "vitest";
import { newOrganPlan, parseSteps } from "./plan";

describe("newOrganPlan", () => {
  it("is deterministic: manifest then code then tests", () => {
    expect(newOrganPlan("track my runs").steps).toEqual(["manifest", "code", "tests"]);
  });
});

describe("parseSteps", () => {
  const valid = ["manifest.json", "organ.js", "test.js"];
  it("parses fenced JSON steps", () => {
    const raw = '```json\n[{"file":"organ.js","step":"add a delete button"}]\n```';
    expect(parseSteps(raw, valid)).toEqual([{ file: "organ.js", step: "add a delete button" }]);
  });
  it("parses bare JSON inside prose", () => {
    const raw = 'Plan:\n[{"file":"organ.js","step":"x"},{"file":"test.js","step":"y"}]\nok';
    expect(parseSteps(raw, valid)).toHaveLength(2);
  });
  it("drops steps naming invalid files and caps at 6", () => {
    const steps = Array.from({ length: 9 }, (_, i) => ({ file: i % 2 ? "organ.js" : "evil.js", step: "s" + i }));
    const out = parseSteps(JSON.stringify(steps), valid);
    expect(out.length).toBeLessThanOrEqual(6);
    expect(out.every((s) => s.file === "organ.js")).toBe(true);
  });
  it("returns [] on garbage", () => {
    expect(parseSteps("no json here", valid)).toEqual([]);
  });
});
