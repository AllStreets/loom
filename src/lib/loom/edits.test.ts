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

/**
 * applyBlock is the TypeScript twin of `apply_exact_unique` in
 * src-tauri/src/kernel.rs. One concept, two implementations — and the loose one
 * is the one that touches organ code (companion/editOrgan.ts). Round 4 caught
 * three divergences; these are the tests for all of them.
 */
describe("applyBlock — literal, unique, non-empty (the Rust twin's discipline)", () => {
  const file = "const a = 1;\nconst b = 2;\n";

  it("writes $$ literally instead of collapsing it to $", () => {
    // String.prototype.replace interprets the REPLACEMENT argument: "$$" is the
    // escape for a single "$". A model-authored replacement is data, not a
    // pattern.
    expect(applyBlock(file, "const a = 1;", 'const a = "x$$y";'))
      .toContain('const a = "x$$y";');
  });

  it("writes $& literally instead of splicing the SEARCH text back in", () => {
    expect(applyBlock(file, "const a = 1;", 'const a = "x$&y";'))
      .toContain('const a = "x$&y";');
  });

  it("writes $` and $' literally instead of splicing the surrounding text", () => {
    const rep = "const a = \"p$`q$'r\";";
    const out = applyBlock(file, "const a = 1;", rep)!;
    expect(out).toContain(rep);
    expect(out).toContain("const b = 2;");
  });

  it("survives a real replacement that itself calls .replace with $&", () => {
    // The motivating case: an organ edit whose replacement contains regex
    // substitution source. It was written to disk mangled, silently.
    const rep = 'const a = s.replace(/x/g, "$&!");';
    expect(applyBlock(file, "const a = 1;", rep)).toContain(rep);
  });

  it("refuses an empty SEARCH rather than blind-appending", () => {
    expect(() => applyBlock(file, "", "const c = 3;")).toThrow(/empty SEARCH/i);
  });

  it("refuses an ambiguous SEARCH rather than silently taking the first match", () => {
    const dup = "log(1);\nlog(1);\n";
    expect(() => applyBlock(dup, "log(1);", "log(2);")).toThrow(/ambiguous/i);
  });

  it("refuses an ambiguous SEARCH on the whitespace-tolerant path too", () => {
    const dup = "  log(1);\nlog(1);\n";
    expect(() => applyBlock(dup, "log(1);", "log(2);")).toThrow(/ambiguous/i);
  });

  it("still returns null when the SEARCH is simply absent", () => {
    expect(applyBlock(file, "const z = 9;", "x")).toBeNull();
  });

  it("agrees with apply_exact_unique on the plain case", () => {
    expect(applyBlock("abc", "b", "X")).toBe("aXc");
  });
});

describe("applyEditBlocks surfaces the refusal so the retry can read it", () => {
  it("throws the ambiguity reason, not a generic 'not found'", () => {
    const dup = "log(1);\nlog(1);\n";
    const raw = "<<<<<<< SEARCH\nlog(1);\n=======\nlog(2);\n>>>>>>> REPLACE";
    expect(() => applyEditBlocks(dup, raw)).toThrow(/ambiguous/i);
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
