import { useEffect, useState } from "react";
import { organList, organRead, organGrant, type OrganEntry } from "../core";
import { manifestGuard, type OrganManifest } from "../loom/validate";
import { makeLoomApi } from "./api";

export type OrganState = {
  entry: OrganEntry;
  manifest: OrganManifest;
  granted: string[];
  approved: boolean;
  error: string | null;
};

export function useOrgans(): {
  organs: OrganState[];
  approve(id: string): Promise<void>;
  reload(): void;
} {
  const [organs, setOrgans] = useState<OrganState[]>([]);

  async function load() {
    const entries = await organList();
    const states: OrganState[] = [];
    for (const entry of entries) {
      const result = manifestGuard(entry.manifest);
      if (!result.ok) continue;
      const manifest = result.manifest;
      let granted: string[] = [];
      try {
        granted = JSON.parse(entry.granted ?? "[]");
      } catch {
        granted = [];
      }
      // Approved = every permission granted; on first sight (never granted at
      // all) the declared powers must be approved too. Once the owner has
      // approved, revoking a single power must NOT resurface the card.
      const permissionsOk = manifest.permissions.every((p) => granted.includes(p));
      const powersOk = (manifest.powers ?? []).every((p) => granted.includes(p));
      const approved = entry.granted !== null ? permissionsOk : permissionsOk && powersOk;
      states.push({ entry, manifest, granted, approved, error: null });
    }
    setOrgans(states);
  }

  useEffect(() => {
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function approve(id: string) {
    const state = organs.find((o) => o.entry.id === id);
    if (!state) return;
    // Grant exactly what the card showed: permissions + declared powers.
    const tokens = [...new Set([...state.manifest.permissions, ...(state.manifest.powers ?? [])])];
    await organGrant(id, JSON.stringify(tokens));
    await load();
  }

  function reload() {
    load();
  }

  return { organs, approve, reload };
}

export async function mountOrgan(
  el: HTMLDivElement,
  state: OrganState,
): Promise<string | null> {
  try {
    const code = await organRead(state.entry.id, "organ.js");
    const blob = new Blob([code], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    try {
      const mod = await import(/* @vite-ignore */ url);
      mod.default.render(el, makeLoomApi(state.entry.id, state.granted));
    } finally {
      URL.revokeObjectURL(url);
    }
    return null;
  } catch (err) {
    return String(err);
  }
}
