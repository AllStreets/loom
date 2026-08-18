import type { organList, organWrite } from "../../lib/core";
import { files as notesFiles } from "./notes";
import { files as timelineFiles } from "./timeline";
import { files as settingsFiles } from "./settings";

type SeedEntry = { id: string; files: typeof notesFiles };

const SEEDS: SeedEntry[] = [
  { id: "notes", files: notesFiles },
  { id: "timeline", files: timelineFiles },
  { id: "settings", files: settingsFiles },
];

export async function installSeeds(deps: {
  list: typeof organList;
  write: typeof organWrite;
}): Promise<string[]> {
  let existing: string[] = [];
  try {
    const entries = await deps.list();
    existing = entries.map((e) => e.id);
  } catch (err) {
    console.debug("[installSeeds] could not load organ list:", err);
    return [];
  }

  // Read tombstone list — deleted seed organs must not be reinstalled
  let tombstones: string[] = [];
  try {
    const raw = localStorage.getItem("loom.organs.deleted");
    tombstones = raw ? JSON.parse(raw) : [];
  } catch {
    // ignore parse errors
  }

  const installed: string[] = [];

  for (const seed of SEEDS) {
    if (existing.includes(seed.id)) continue;
    if (tombstones.includes(seed.id)) continue;
    try {
      await deps.write(seed.id, seed.files, `loom: seed ${seed.id}`);
      installed.push(seed.id);
    } catch (err) {
      console.debug(`[installSeeds] failed to install seed "${seed.id}":`, err);
    }
  }

  return installed;
}
