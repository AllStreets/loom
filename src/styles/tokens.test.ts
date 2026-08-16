import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Walk src/ and assert the brand-violating yellow hex appears nowhere.
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// Construct the forbidden literal at runtime so the source of this test file
// itself contains zero occurrences of it (keeps the grep sweep truly clean).
const YELLOW = "#" + "fb" + "bf" + "24";

describe("brand tokens", () => {
  it("no legacy yellow hex remains anywhere in src/", () => {
    const srcRoot = join(process.cwd(), "src");
    const files = walk(srcRoot).filter((f) => /\.(ts|tsx|css|js|jsx)$/.test(f));
    const offenders = files.filter((f) =>
      readFileSync(f, "utf8").toLowerCase().includes(YELLOW),
    );
    expect(offenders).toEqual([]);
  });

  it("--warn is remapped to orange #f97316 in tokens.css", () => {
    const css = readFileSync(join(process.cwd(), "src/styles/tokens.css"), "utf8");
    expect(css).toContain("--warn:#f97316");
  });

  it("declares the expanded shadow/motion tokens", () => {
    const css = readFileSync(join(process.cwd(), "src/styles/tokens.css"), "utf8");
    for (const tok of [
      "--shadow-1:",
      "--shadow-2:",
      "--shadow-3:",
      "--ease-out:",
      "--dur-fast:",
      "--dur-slow:",
      "--glass-raised:",
    ]) {
      expect(css).toContain(tok);
    }
  });

  it("removed the dead state-* variables", () => {
    const css = readFileSync(join(process.cwd(), "src/styles/tokens.css"), "utf8");
    expect(css).not.toContain("--state-listen");
    expect(css).not.toContain("--state-think");
    expect(css).not.toContain("--state-speak");
  });
});
