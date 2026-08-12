import { PERMISSIONS } from "./prompts";
import { sandboxRun, type SandboxVerdict, type OrganFilesIn } from "./sandbox";

export type OrganManifest = { id: string; name: string; description: string; version: number; permissions: string[] };

const ID_RE = /^[a-z0-9-]{1,32}$/;

export function manifestGuard(manifestRaw: string, expectedId?: string):
  { ok: true; manifest: OrganManifest } | { ok: false; error: string } {
  let m: unknown;
  try { m = JSON.parse(manifestRaw); } catch (e) { return { ok: false, error: "manifest is not valid JSON: " + String(e) }; }
  const man = m as Partial<OrganManifest>;
  for (const field of ["id", "name", "description", "version", "permissions"] as const) {
    if (man[field] === undefined || man[field] === null) return { ok: false, error: `manifest missing "${field}"` };
  }
  if (typeof man.id !== "string" || !ID_RE.test(man.id)) return { ok: false, error: `invalid organ id: ${String(man.id)}` };
  if (expectedId && man.id !== expectedId) return { ok: false, error: `manifest id "${man.id}" does not match expected "${expectedId}"` };
  if (typeof man.name !== "string") return { ok: false, error: 'manifest field "name" has the wrong type' };
  if (typeof man.description !== "string") return { ok: false, error: 'manifest field "description" has the wrong type' };
  if (typeof man.version !== "number") return { ok: false, error: 'manifest field "version" has the wrong type' };
  if (!Array.isArray(man.permissions)) return { ok: false, error: "permissions must be an array" };
  for (const p of man.permissions) {
    if (!(PERMISSIONS as readonly string[]).includes(p)) return { ok: false, error: `unknown permission: ${String(p)}` };
  }
  return { ok: true, manifest: man as OrganManifest };
}

export async function gate(files: OrganFilesIn, expectedId?: string):
  Promise<{ ok: boolean; manifest?: OrganManifest; verdict?: SandboxVerdict; error?: string }> {
  const mg = manifestGuard(files.manifest, expectedId);
  if (!mg.ok) return { ok: false, error: mg.error };
  const verdict = await sandboxRun(files);
  return { ok: verdict.ok, manifest: mg.manifest, verdict };
}
