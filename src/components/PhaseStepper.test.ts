import { describe, it, expect } from "vitest";
import { deriveStepStates } from "./Companion";
import type { BuildEvent } from "../lib/loom/build";

function ev(phase: string, detail = ""): BuildEvent {
  return { ts: Date.now(), phase, detail, role: "builder" };
}

describe("deriveStepStates — build phase stepper", () => {
  it("all phases pending with no events", () => {
    const s = deriveStepStates([]);
    expect(s.manifest).toBe("pending");
    expect(s.write).toBe("pending");
  });

  it("marks earlier phases done and the latest phase current", () => {
    const s = deriveStepStates([ev("manifest"), ev("code"), ev("probe")]);
    expect(s.manifest).toBe("done");
    expect(s.code).toBe("done");
    expect(s.probe).toBe("current");
    expect(s.tests).toBe("pending");
  });

  it("marks the write phase current on the final commit", () => {
    const s = deriveStepStates([
      ev("manifest"),
      ev("code"),
      ev("probe"),
      ev("tests"),
      ev("gate"),
      ev("write"),
    ]);
    expect(s.gate).toBe("done");
    expect(s.write).toBe("current");
    expect(s.review).toBe("pending");
  });

  it("marks the failing phase as error when an error event is present", () => {
    const s = deriveStepStates([ev("manifest"), ev("code"), ev("error", "boom")]);
    // last canonical phase is code; error flags it
    expect(s.code).toBe("error");
    expect(s.manifest).toBe("done");
  });

  it("ignores non-canonical phases (e.g. repair) for stepper positioning", () => {
    const s = deriveStepStates([ev("manifest"), ev("code"), ev("repair"), ev("gate")]);
    expect(s.code).toBe("done");
    expect(s.gate).toBe("current");
  });
});
