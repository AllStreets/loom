// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { manifestGuard } from "../../lib/loom/validate";
import { ShellUnavailableError } from "../../lib/core";
import { files as notesFiles } from "./notes";
import { files as timelineFiles } from "./timeline";
import { files as settingsFiles } from "./settings";
import { installSeeds } from "./install";

beforeEach(() => { if (typeof localStorage !== "undefined") localStorage.clear(); });
afterEach(() => { if (typeof localStorage !== "undefined") localStorage.clear(); });

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
  { id: "settings", files: settingsFiles },
];

// ── installSeeds unit tests ───────────────────────────────────────────────────

describe("installSeeds", () => {
  let list: ReturnType<typeof vi.fn>;
  let write: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    list = vi.fn();
    write = vi.fn().mockResolvedValue("sha");
  });

  it("installs all seeds when none exist", async () => {
    list.mockResolvedValue([]);
    const installed = await installSeeds({ list, write });
    expect(write).toHaveBeenCalledTimes(3);
    expect(installed).toEqual(["notes", "timeline", "settings"]);
  });

  it("skips an existing organ and installs the missing ones", async () => {
    list.mockResolvedValue([
      { id: "notes", manifest: "{}", granted: null },
    ]);
    const installed = await installSeeds({ list, write });
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledWith(
      "timeline",
      timelineFiles,
      "loom: seed timeline",
    );
    expect(write).toHaveBeenCalledWith(
      "settings",
      settingsFiles,
      "loom: seed settings",
    );
    expect(installed).toEqual(["timeline", "settings"]);
  });

  it("never overwrites — write failure on one seed does not prevent the others", async () => {
    list.mockResolvedValue([]);
    write.mockImplementation(async (id: string) => {
      if (id === "notes") throw new Error("disk full");
      return "sha";
    });
    const installed = await installSeeds({ list, write });
    // notes failed; timeline and settings should still be installed
    expect(installed).toEqual(["timeline", "settings"]);
    expect(write).toHaveBeenCalledTimes(3);
  });

  it("returns empty array without throw when list() fails", async () => {
    list.mockRejectedValue(new Error("backend unavailable"));
    const installed = await installSeeds({ list, write });
    expect(installed).toEqual([]);
    expect(write).not.toHaveBeenCalled();
  });
});

// ── installSeeds failure logging ──────────────────────────────────────────────

describe("installSeeds failure logging", () => {
  it("console.debug when write fails with ShellUnavailableError", async () => {
    const list = vi.fn().mockResolvedValue([]);
    const write = vi.fn().mockRejectedValue(new ShellUnavailableError());
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await installSeeds({ list, write });
    expect(debugSpy).toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    debugSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("console.warn when write fails with a non-ShellUnavailableError", async () => {
    const list = vi.fn().mockResolvedValue([]);
    const write = vi.fn().mockRejectedValue(new Error("disk full"));
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await installSeeds({ list, write });
    expect(warnSpy).toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalled();
    debugSpy.mockRestore();
    warnSpy.mockRestore();
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

  it("settings manifest permissions are exactly [\"settings\"]", () => {
    const raw = getFile(settingsFiles, "manifest.json");
    const parsed = JSON.parse(raw);
    expect(parsed.permissions).toEqual(["settings"]);
  });

  it("install includes settings seed", async () => {
    const list = vi.fn().mockResolvedValue([]);
    const write = vi.fn().mockResolvedValue("sha");
    const installed = await installSeeds({ list, write });
    expect(installed).toContain("settings");
    expect(write).toHaveBeenCalledWith("settings", settingsFiles, "loom: seed settings");
  });
});

// ── tombstone tests ───────────────────────────────────────────────────────────

describe("installSeeds tombstones", () => {
  it("skips seed ids in loom.organs.deleted tombstone list", async () => {
    // Put notes in the tombstone list
    localStorage.setItem("loom.organs.deleted", JSON.stringify(["notes"]));

    const list = vi.fn(async () => []);
    const write = vi.fn(async () => "sha");

    const installed = await installSeeds({ list, write });

    // notes must NOT be installed
    expect(write).not.toHaveBeenCalledWith("notes", expect.anything(), expect.anything());
    // notes must not appear in returned list
    expect(installed).not.toContain("notes");
  });

  it("installs seeds not in tombstone list", async () => {
    // Only notes is tombstoned
    localStorage.setItem("loom.organs.deleted", JSON.stringify(["notes"]));

    const list = vi.fn(async () => []);
    const write = vi.fn(async () => "sha");

    const installed = await installSeeds({ list, write });

    // timeline and settings should be installed (not tombstoned)
    expect(write).toHaveBeenCalledWith("timeline", expect.anything(), expect.anything());
    expect(write).toHaveBeenCalledWith("settings", expect.anything(), expect.anything());
    expect(installed).toContain("timeline");
    expect(installed).toContain("settings");
  });

  it("skips seeds already in the organ list (existing behavior)", async () => {
    const list = vi.fn(async () => [
      { id: "notes", manifest: "{}", granted: null },
    ]);
    const write = vi.fn(async () => "sha");

    await installSeeds({ list, write });

    expect(write).not.toHaveBeenCalledWith("notes", expect.anything(), expect.anything());
  });
});
