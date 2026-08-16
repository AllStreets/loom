import { describe, it, expect } from "vitest";
import { ctxFor, ORGAN_CONTRACT, PERMISSIONS, organSystemPrompt } from "./prompts";

describe("ctxFor", () => {
  it("floors at 8192 and caps at 32768, stepping by 2048", () => {
    expect(ctxFor(900)).toBe(8192);
    expect(ctxFor(46000)).toBe(32768);
    expect(ctxFor(90000)).toBe(32768);
    expect(ctxFor(20000) % 2048).toBe(0);
  });
});

describe("contract", () => {
  it("documents the organ files and permission catalog", () => {
    for (const f of ["manifest.json", "organ.js", "test.js"]) expect(ORGAN_CONTRACT).toContain(f);
    for (const p of PERMISSIONS) expect(ORGAN_CONTRACT).toContain(p);
    expect(ORGAN_CONTRACT).toContain("export default");
  });

  it("documents the loom.ui design kit factories", () => {
    expect(ORGAN_CONTRACT).toContain("loom.ui");
    expect(ORGAN_CONTRACT).toContain("card");
    expect(ORGAN_CONTRACT).toContain("design");
  });

  it("documents loom.settings api and whitelisted keys", () => {
    expect(ORGAN_CONTRACT).toContain("loom.settings");
    expect(ORGAN_CONTRACT).toContain("voice.default");
    expect(ORGAN_CONTRACT).toContain("voice.speakReplies");
    expect(ORGAN_CONTRACT).toContain("orb.tier");
    expect(ORGAN_CONTRACT).toContain("loom.reviewBeforeSave");
    expect(ORGAN_CONTRACT).toContain("settings-type organs");
  });
});

describe("organSystemPrompt", () => {
  it("exemplars and lessons are injected between the contract and the task instruction", () => {
    const exemplarText = "PAST SUCCESSFUL BUILD (request: \"track my runs\", passed in 0 repair rounds):\nexport default { id: \"run-tracker\" }";
    const lessonText = "A similar past build (\"track my runs\") failed at stage tests with: querySelector returned null. Avoid that failure mode.";
    const prompt = organSystemPrompt("code", { exemplars: exemplarText, lessons: lessonText });

    // Both blocks must appear
    expect(prompt).toContain("EXPERIENCE — PAST SUCCESSFUL BUILDS");
    expect(prompt).toContain("LESSONS FROM PAST FAILURES");
    expect(prompt).toContain(exemplarText);
    expect(prompt).toContain(lessonText);

    // Experience block must come BEFORE the task instruction line
    const expPos = prompt.indexOf("EXPERIENCE — PAST SUCCESSFUL BUILDS");
    const taskPos = prompt.indexOf("Now output organ.js only");
    expect(expPos).toBeGreaterThan(-1);
    expect(taskPos).toBeGreaterThan(-1);
    expect(expPos).toBeLessThan(taskPos);

    // The experience block must come AFTER the contract (ORGAN_CONTRACT content check)
    const contractPos = prompt.indexOf("An ORGAN is a small self-contained tool");
    expect(contractPos).toBeGreaterThan(-1);
    expect(expPos).toBeGreaterThan(contractPos);
  });

  it("prompt without exemplars/lessons does not contain EXPERIENCE block", () => {
    const prompt = organSystemPrompt("code");
    expect(prompt).not.toContain("EXPERIENCE — PAST SUCCESSFUL BUILDS");
    expect(prompt).not.toContain("LESSONS FROM PAST FAILURES");
  });

  it("empty exemplars string does not inject EXPERIENCE block", () => {
    const prompt = organSystemPrompt("code", { exemplars: "", lessons: "" });
    expect(prompt).not.toContain("EXPERIENCE — PAST SUCCESSFUL BUILDS");
  });
});
