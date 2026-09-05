/**
 * typecheckConfig.test.ts — the gate that typechecks the tests must keep
 * typechecking the tests.
 *
 * Round-4 finding 3: `tsconfig.json` excluded `src/**\/*.test.ts(x)` and
 * `src/selftest/**`, and vitest transpiles without checking — so test files
 * were typechecked by NOTHING. A deliberate type error appended to a test file
 * passed both `npx tsc --noEmit` and `npm run build`. That is exactly where a
 * Rust-to-TypeScript shape drift hides, and the drift was real: `recovery.test.ts`
 * mocked `kernel_boot_check` with `{ rolledBackTo }` while `KernelBootCheck`
 * also requires `rollbackFailed`. The fifth wall's own test was checking a
 * shape Rust does not return.
 *
 * `tsconfig.check.json` closes it. This file is the guard on the guard: it is
 * cheap to delete a line from a JSON file and never notice the gate went quiet,
 * so the wiring is asserted here — the check config exists, inherits the
 * build's options, casts a net over `src` with no blanket test exclusion, its
 * shrinking backlog list has no stale entries, and both `npm run typecheck` and
 * CI actually run it.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

/** tsconfigs allow comments and trailing commas; JSON.parse does not. */
function parseJsonc(text: string): Record<string, unknown> {
  const stripped = text
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(stripped) as Record<string, unknown>;
}

const check = parseJsonc(read("tsconfig.check.json"));
const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

describe("the typecheck gate covers the tests", () => {
  it("tsconfig.check.json inherits the build's compiler options", () => {
    // Same rules for tests as for what ships — a second set of options would
    // be a second dialect, and drift would hide in the gap.
    expect(check.extends).toBe("./tsconfig.json");
  });

  it("casts its net over src with no blanket test exclusion", () => {
    expect(check.include).toEqual(["src"]);
    const exclude = (check.exclude ?? []) as string[];
    for (const pattern of exclude) {
      expect(
        /\*/.test(pattern),
        `"${pattern}" is a glob — the backlog list is named files only, so it ` +
          "cannot quietly grow to cover every test again",
      ).toBe(false);
    }
  });

  it("the backlog list is only named files that still exist (it must shrink)", () => {
    // A stale entry is a file that was renamed or fixed: the line is dead and
    // hides nothing, so delete it. Failing here is the nudge to do that.
    for (const rel of (check.exclude ?? []) as string[]) {
      expect(existsSync(resolve(ROOT, rel)), `${rel} is listed but does not exist`).toBe(true);
    }
  });

  it("the fifth wall's own tests are NOT on the backlog list", () => {
    // recovery / edits / the boot beacon are the Rust seam. If these ever land
    // on the list, the drift that broke this phase twice is unguarded again.
    const exclude = (check.exclude ?? []) as string[];
    for (const guarded of [
      "src/lib/loom/recovery.test.ts",
      "src/lib/loom/edits.test.ts",
      "src/components/Shell.bootbeacon.test.tsx",
      "src/lib/loom/typecheckConfig.test.ts",
    ]) {
      expect(exclude).not.toContain(guarded);
    }
  });

  it("npm run typecheck runs BOTH passes", () => {
    const script = pkg.scripts.typecheck;
    expect(script).toContain("tsc --noEmit");
    expect(script).toContain("tsconfig.check.json");
  });

  it("CI runs the npm script, so the local gate and CI cannot diverge", () => {
    const ci = read(".github/workflows/check.yml");
    expect(ci).toContain("run: npm run typecheck");
    // The bare `tsc` it replaced covered no test file at all.
    expect(ci).not.toContain("run: npx tsc --noEmit");
  });
});
