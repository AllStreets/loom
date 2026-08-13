import { describe, it, expect } from "vitest";
import { ctxFor, ORGAN_CONTRACT, PERMISSIONS } from "./prompts";

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
