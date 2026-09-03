/**
 * Tests for the genome bundle script (scripts/genome-bundle.mjs).
 *
 * Runs under vitest. Pure Node: builds a real temp git repo with two commits,
 * bundles it, clones the bundle elsewhere, and asserts the clone's HEAD equals
 * the sha recorded in genome.json — the contract loomhome::seed_source relies
 * on. Also asserts the honest failure outside a repository.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { bundleGenome } from "./genome-bundle.mjs";

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

describe("genome bundle", () => {
  let repo, out, clone;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "loom-genome-repo-"));
    out = mkdtempSync(join(tmpdir(), "loom-genome-out-"));
    clone = mkdtempSync(join(tmpdir(), "loom-genome-clone-"));
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.name", "Test"]);
    git(repo, ["config", "user.email", "test@localhost"]);
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "first"]);
    writeFileSync(join(repo, "a.txt"), "two\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "second"]);
  });

  afterEach(() => {
    for (const d of [repo, out, clone]) rmSync(d, { recursive: true, force: true });
  });

  it("writes a bundle a fresh clone restores to the recorded sha, with full history", () => {
    const r = bundleGenome(repo, out);
    expect(r.ok).toBe(true);
    expect(existsSync(r.bundle)).toBe(true);
    const meta = JSON.parse(readFileSync(r.json, "utf8"));
    expect(meta.sha).toBe(git(repo, ["rev-parse", "HEAD"]));
    expect(typeof meta.createdAt).toBe("string");

    git(clone, ["clone", "-q", r.bundle, "src"]);
    const src = join(clone, "src");
    expect(git(src, ["rev-parse", "HEAD"])).toBe(meta.sha);
    expect(git(src, ["rev-list", "--count", "HEAD"])).toBe("2");
    expect(readFileSync(join(src, "a.txt"), "utf8")).toBe("two\n");
  });

  it("refuses outside a git repository, honestly", () => {
    const plain = mkdtempSync(join(tmpdir(), "loom-genome-plain-"));
    try {
      const r = bundleGenome(plain, out);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/not a git repository/);
      expect(existsSync(join(out, "genome.bundle"))).toBe(false);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
