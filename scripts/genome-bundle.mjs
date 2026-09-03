#!/usr/bin/env node
/**
 * genome-bundle.mjs — pack LOOM's genome into the binary (Phase 23 / Rebirth).
 *
 * PROTECTED. Runs as the first step of `beforeBuildCommand`, so every packaged
 * LOOM carries the full git history it was woven from. Writes:
 *
 *   src-tauri/genome/genome.bundle   `git bundle create … --all`
 *   src-tauri/genome/genome.json     { sha, createdAt }
 *
 * Both are Tauri bundle resources (tauri.conf.json → bundle.resources) and are
 * gitignored — they are build outputs, never committed. On first packaged
 * launch, `loomhome::seed_source` clones the bundle into loomhome/source and
 * checks out `sha`, so the genome and the body agree.
 *
 * Exits non-zero outside a git repository: a LOOM without its genome cannot
 * reweave, and the build must say so rather than ship a hollow body.
 *
 * Pure Node, no dependencies.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

/**
 * Build the genome bundle for the repo at `repoRoot`, writing into
 * `<repoRoot>/src-tauri/genome/` (or `outDir` when given — tests).
 * Returns { ok, sha, bundle, json, error }.
 */
export function bundleGenome(repoRoot, outDir = join(repoRoot, "src-tauri", "genome")) {
  const top = git(repoRoot, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) {
    return { ok: false, error: "not a git repository — the genome cannot be bundled" };
  }
  const head = git(repoRoot, ["rev-parse", "HEAD"]);
  if (!head.ok) {
    return { ok: false, error: "no commits yet — the genome is empty" };
  }
  mkdirSync(outDir, { recursive: true });
  const bundle = join(outDir, "genome.bundle");
  const json = join(outDir, "genome.json");
  const b = git(repoRoot, ["bundle", "create", bundle, "--all"]);
  if (!b.ok) {
    return { ok: false, error: `git bundle failed — ${b.err}` };
  }
  const meta = { sha: head.out, createdAt: new Date().toISOString() };
  writeFileSync(json, JSON.stringify(meta, null, 2) + "\n");
  return { ok: true, sha: head.out, bundle, json };
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const r = bundleGenome(process.cwd());
  if (!r.ok) {
    console.error(`[genome] ${r.error}`);
    process.exit(1);
  }
  console.log(`[genome] bundled ${r.sha.slice(0, 7)} → ${r.bundle}`);
}
