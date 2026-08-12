import { describe, it, expect } from "vitest";
import { normalize } from "./normalize";

describe("normalize", () => {
  it("trims leading and trailing whitespace", () => {
    expect(normalize("  hello  ")).toBe("hello");
  });

  it("collapses multiple internal spaces to one", () => {
    expect(normalize("hello   world")).toBe("hello world");
  });

  it("collapses tabs and mixed whitespace runs", () => {
    expect(normalize("hello\t\t world")).toBe("hello world");
  });

  it("collapses newlines within a run", () => {
    expect(normalize("hello  \n  world")).toBe("hello world");
  });

  it("strips zero-width space (U+200B)", () => {
    expect(normalize("hel​lo")).toBe("hello");
  });

  it("strips zero-width non-joiner (U+200C)", () => {
    expect(normalize("hel‌lo")).toBe("hello");
  });

  it("strips zero-width no-break space / BOM (U+FEFF)", () => {
    expect(normalize("﻿hello")).toBe("hello");
  });

  it("strips soft hyphen (U+00AD)", () => {
    expect(normalize("hel­lo")).toBe("hello");
  });

  it("applies Unicode NFC normalization", () => {
    // e + combining acute accent (NFD) should become single é (NFC)
    const nfd = "é";
    const nfc = "é";
    expect(normalize(nfd)).toBe(nfc);
  });

  it("handles empty string", () => {
    expect(normalize("")).toBe("");
  });

  it("handles already-normalized string unchanged", () => {
    expect(normalize("hello world")).toBe("hello world");
  });
});
