// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { manifestGuard } from "../../lib/loom/validate";
import { files as notesFiles } from "./notes";
import { files as timelineFiles } from "./timeline";
import { installSeeds } from "./install";

// ── helpers ───────────────────────────────────────────────────────────────────

function getFile(files: { name: string; content: string }[], name: string): string {
  const f = files.find((x) => x.name === name);
  if (!f) throw new Error(`file "${name}" not found`);
  return f.content;
}

function syntaxCheck(src: string): void {
  // Strip module-level export syntax the same way the selftest does, then
  // verify new Function() does not throw a SyntaxError.
  const stripped = src
    .replace(/^export\s+default\s+/m, "const __x = ")
    .replace(/^export\s+const\s+tests\s*=/m, "const tests =")
    .replace(/^\s*import\b[^\n]*\n?/gm, "");
  new Function(stripped);
}

// ── seed data snapshots ───────────────────────────────────────────────────────

const ALL_SEEDS = [
  { id: "notes", files: notesFiles },
  { id: "timeline", files: timelineFiles },
];

// ── installSeeds unit tests ───────────────────────────────────────────────────

describe("installSeeds", () => {
  let list: ReturnType<typeof vi.fn>;
  let write: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    list = vi.fn();
    write = vi.fn().mockResolvedValue("sha");
  });

  it("installs both seeds when none exist", async () => {
    list.mockResolvedValue([]);
    const installed = await installSeeds({ list, write });
    expect(write).toHaveBeenCalledTimes(2);
    expect(installed).toEqual(["notes", "timeline"]);
  });

  it("skips an existing organ and installs the missing one", async () => {
    list.mockResolvedValue([
      { id: "notes", manifest: "{}", granted: null },
    ]);
    const installed = await installSeeds({ list, write });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(
      "timeline",
      timelineFiles,
      "loom: seed timeline",
    );
    expect(installed).toEqual(["timeline"]);
  });

  it("never overwrites — write failure on one seed does not prevent the other", async () => {
    list.mockResolvedValue([]);
    write.mockImplementation(async (id: string) => {
      if (id === "notes") throw new Error("disk full");
      return "sha";
    });
    const installed = await installSeeds({ list, write });
    // notes failed; timeline should still be installed
    expect(installed).toEqual(["timeline"]);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("returns empty array without throw when list() fails", async () => {
    list.mockRejectedValue(new Error("backend unavailable"));
    const installed = await installSeeds({ list, write });
    expect(installed).toEqual([]);
    expect(write).not.toHaveBeenCalled();
  });
});

// ── content validity ──────────────────────────────────────────────────────────

describe("seed content validity", () => {
  for (const seed of ALL_SEEDS) {
    describe(`seed: ${seed.id}`, () => {
      it("manifest passes manifestGuard", () => {
        const raw = getFile(seed.files, "manifest.json");
        const result = manifestGuard(raw, seed.id);
        expect(result.ok, result.ok ? "" : (result as { ok: false; error: string }).error).toBe(true);
      });

      it("organ.js passes syntax check", () => {
        const src = getFile(seed.files, "organ.js");
        expect(() => syntaxCheck(src)).not.toThrow();
      });

      it("test.js passes syntax check", () => {
        const src = getFile(seed.files, "test.js");
        expect(() => syntaxCheck(src)).not.toThrow();
      });

      it("test.js contains no import statements", () => {
        const src = getFile(seed.files, "test.js");
        expect(/^\s*import\b/m.test(src)).toBe(false);
      });
    });
  }

  it("notes manifest permissions are exactly [\"storage\"]", () => {
    const raw = getFile(notesFiles, "manifest.json");
    const parsed = JSON.parse(raw);
    expect(parsed.permissions).toEqual(["storage"]);
  });

  it("timeline manifest permissions are exactly []", () => {
    const raw = getFile(timelineFiles, "manifest.json");
    const parsed = JSON.parse(raw);
    expect(parsed.permissions).toEqual([]);
  });
});
