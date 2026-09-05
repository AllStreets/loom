import { PERMISSIONS } from "./prompts";
import { sandboxRun, type SandboxVerdict, type OrganFilesIn } from "./sandbox";
export type { OrganFilesIn };

export type OrganManifest = { id: string; name: string; description: string; version: number; permissions: string[]; powers?: string[] };

/** The four organ powers the model is taught — what a built organ may request. */
export const POWERS = ["timeline", "voice", "notify", "pulse"] as const;

/**
 * Kernel powers (Rebirth): LOOM's own body, READ directly and MOVED only by
 * asking. `self` grants three reads — identity, the tool table, the
 * generations shelf — and the right to ASK the owner to thread, reweave, or
 * return. It does not grant those acts: they dispatch a `loom-body-request`,
 * and only chrome, after the owner's consent card, calls the protected
 * orchestration (`src/lib/organs/bodyGate.ts`).
 *
 * That split is the round-1 correction. Organs share the shell's JS realm and
 * are honesty-enforced, not sandboxed, so a capability one organ holds is one
 * any organ's code can reach: a grant decides who may ask through the api, and
 * the owner's card is where what happens is decided. The card is not a wall —
 * same-realm code can reach the Tauri bridge directly; `bodyGate.ts` states the
 * whole threat model. The Settings seed declares `self`; the prompts
 * never teach it, so a built organ does not learn to ask for it. Any manifest
 * that does declare it still passes through the owner's permission card, and
 * `need("self")` gates every call.
 */
export const KERNEL_POWERS = ["self"] as const;
export type Power = (typeof POWERS)[number] | (typeof KERNEL_POWERS)[number];

const ALL_POWERS: readonly string[] = [...POWERS, ...KERNEL_POWERS];

/** Plain-language labels for the permission card and the POWERS row. */
export const POWER_LABELS: Record<Power, string> = {
  timeline: "read the timeline",
  voice: "speak aloud",
  notify: "notify you",
  pulse: "run on a schedule (up to every 30s)",
  self: "read LOOM's identity and generations, and ask you to thread, reweave, or return",
};

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
  // Legacy normalization: "notify" was once a permission; it is now gated
  // exclusively as a power. Old manifests that still declare it under
  // "permissions" are migrated at read time — moved into "powers" (deduped),
  // never rejected — so they keep working and their notify shows up in the
  // per-power POWERS revocation row (which iterates manifest.powers).
  const legacyNotify = man.permissions.includes("notify");
  if (legacyNotify) man.permissions = man.permissions.filter((p) => p !== "notify");
  for (const p of man.permissions) {
    if (!(PERMISSIONS as readonly string[]).includes(p)) return { ok: false, error: `unknown permission: ${String(p)}` };
  }
  if (man.powers !== undefined && man.powers !== null) {
    if (!Array.isArray(man.powers)) return { ok: false, error: "powers must be an array" };
    for (const p of man.powers) {
      if (!ALL_POWERS.includes(p)) return { ok: false, error: `unknown power: ${String(p)}` };
    }
  }
  if (legacyNotify) {
    const powers = Array.isArray(man.powers) ? (man.powers as string[]) : [];
    if (!powers.includes("notify")) man.powers = [...powers, "notify"];
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

export async function renderProbe(files: OrganFilesIn, expectedId?: string):
  Promise<{ ok: boolean; renderedHtml?: string; error?: string }> {
  const mg = manifestGuard(files.manifest, expectedId);
  if (!mg.ok) return { ok: false, error: mg.error };
  const verdict = await sandboxRun(files, 8000, { probeOnly: true });
  if (!verdict.ok) {
    return { ok: false, error: verdict.errors.join("; ") };
  }
  return { ok: true, renderedHtml: verdict.renderedHtml };
}
