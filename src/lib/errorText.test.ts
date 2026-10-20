import { describe, expect, it } from "vitest";
import { errorText } from "./errorText";

describe("errorText", () => {
  it("never says [object Object]", () => {
    expect(errorText({ message: "model timed out" })).toBe("model timed out");
    expect(errorText({ error: "organ_write failed: disk full" })).toBe("organ_write failed: disk full");
    expect(errorText({ kind: "Io", code: 28 })).toBe('{"kind":"Io","code":28}');
    expect(errorText(new Error("boom"))).toBe("boom");
    expect(errorText("plain")).toBe("plain");
    expect(errorText(undefined)).toBe("undefined");
  });
});
