import { describe, it, expect } from "vitest";
import { extractCode, scrubFences, applyBlock, applyEditBlocks, spliceEntries } from "./edits";

describe("extractCode", () => {
  it("strips a clean fenced block", () => {
    expect(extractCode("```javascript\nconst a = 1;\n```")).toBe("const a = 1;");
  });
  it("strips a TRUNCATED closing fence (the kb.js corruption bug)", () => {
    expect(extractCode("```javascript\nconst a = 1;")).toBe("const a = 1;");
  });
  it("extracts an inner fenced block from prose", () => {
    expect(extractCode("Here you go:\n```js\nconst a = 1;\n```\nDone.")).toBe("const a = 1;");
  });
  it("passes through unfenced code", () => {
    expect(extractCode("const a = 1;")).toBe("const a = 1;");
  });
});

describe("applyEditBlocks", () => {
  const file = "function greet(name) {\n  const msg = \"hi \" + name;\n  return msg;\n}\n";
  it("applies an exact-match replace", () => {
    const raw = "<<<<<<< SEARCH\n  const msg = \"hi \" + name;\n=======\n  const msg = \"hello \" + name;\n>>>>>>> REPLACE";
    expect(applyEditBlocks(file, raw)).toContain("hello ");
  });
  it("tolerates whitespace drift in SEARCH", () => {
    const raw = "<<<<<<< SEARCH\nconst msg = \"hi \" + name;\n=======\n  const msg = \"hey \" + name;\n>>>>>>> REPLACE";
    expect(applyEditBlocks(file, raw)).toContain("hey ");
  });
  it("adds lines by repeating an anchor line", () => {
    const raw = "<<<<<<< SEARCH\n  return msg;\n=======\n  console.log(msg);\n  return msg;\n>>>>>>> REPLACE";
    const out = applyEditBlocks(file, raw)!;
    expect(out).toContain("console.log(msg);");
    expect(out).toContain("return msg;");
  });
  it("throws when SEARCH does not match", () => {
    const raw = "<<<<<<< SEARCH\nnot in file\n=======\nx\n>>>>>>> REPLACE";
    expect(() => applyEditBlocks(file, raw)).toThrow();
  });
  it("returns null when there are no blocks", () => {
    expect(applyEditBlocks(file, "here is the whole file...")).toBeNull();
  });
  it("applies two blocks in sequence and stays valid JS", () => {
    const raw =
      "<<<<<<< SEARCH\n  const msg = \"hi \" + name;\n=======\n  const msg = \"hello \" + name;\n>>>>>>> REPLACE\n\n" +
      "<<<<<<< SEARCH\nfunction greet(name) {\n=======\n// greet a user\nfunction greet(name) {\n>>>>>>> REPLACE";
    const out = applyEditBlocks(file, raw)!;
    expect(() => new Function(out)).not.toThrow();
    expect(out).toContain("// greet a user");
  });
});

describe("spliceEntries", () => {
  const kb = "const ITEMS = [\n{ id: \"old\" },\n];\n";
  it("splices messy fenced prose output with trailing comma", () => {
    const raw = "Here you go:\n```javascript\n{ id: \"new1\" },\n{ id: \"new2\" },\n```";
    const out = spliceEntries(kb, "ITEMS", raw);
    expect(() => new Function(out)).not.toThrow();
    expect(out).toContain("new1");
    expect(out).toContain("old");
  });
  it("handles the model wrongly wrapping in const X = [...]", () => {
    const raw = "```\nconst ITEMS = [\n{ id: \"a\" }\n];\n```";
    const out = spliceEntries(kb, "ITEMS", raw);
    expect(out).toContain("\"a\"");
    expect(out).toContain("old");
  });
  it("throws on invalid entry syntax", () => {
    expect(() => spliceEntries(kb, "ITEMS", "{ id: \"broken\", ")).toThrow();
  });
});
