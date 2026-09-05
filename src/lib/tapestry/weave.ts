/**
 * weave.ts — the Tapestry's pure loom.
 *
 * Maps LOOM's lived history onto a woven band:
 * - warp (vertical, structural): recent timeline commits — the machine's own
 *   git history. Newest brightest, newest furthest right (weaving advances).
 * - weft (horizontal, colored): organs (alive = accent, deleted = faint scar),
 *   build experiences (clean pass = smooth thread, repaired
 *   build = visible knots — honesty in cloth), and generations — each woven
 *   body of LOOM itself, tied as a knot on the warp of the commit it was
 *   woven from; the current one luminous.
 *
 * PURE + DETERMINISTIC: no Math.random, no Date.now. Age arrives via
 * `inputs.now`; jitter is seeded from ids/shas (fnv-1a), so the same life
 * always weaves the same cloth. Coordinates are normalized 0..1 on both axes;
 * the renderer maps them onto its own band geometry. Colors are token NAMES
 * (e.g. "--accent") — the renderer resolves them; no raw hex here.
 */

// ── Input types (narrow; callers adapt their richer records down to these) ────

export interface WeaveCommit {
  sha: string;
  message: string;
}

export interface WeaveOrgan {
  id: string;
}

export interface WeaveExperience {
  ts: number;
  organId: string;
  ok: boolean;
  repairRounds: number;
}

/** One woven body of LOOM — a generation from the ledger. */
export interface WeaveGeneration {
  /** The genome sha the binary was woven from. */
  sha: string;
  wovenAt: number;
  isCurrent: boolean;
}

export interface WeaveInputs {
  /** Newest first — timelineLog order. */
  commits: WeaveCommit[];
  organs: WeaveOrgan[];
  deletedOrganIds: string[];
  experiences: WeaveExperience[];
  /** Woven generations of LOOM itself. Optional — only the shell knows them. */
  generations?: WeaveGeneration[];
  /** Current epoch ms — passed in so this module never calls Date.now(). */
  now: number;
}

// ── Output types ──────────────────────────────────────────────────────────────

export type ThreadAction =
  | { kind: "organ"; id: string }
  | { kind: "commit"; sha: string }
  | null;

export interface WarpThread {
  id: string;
  /** 0..1 across the band; newest commit furthest right. */
  x: number;
  opacity: number;
  /** CSS custom-property name, e.g. "--t2". */
  colorToken: string;
  label: string;
  action: ThreadAction;
}

export type WeftKind = "organ" | "scar" | "build" | "generation";

export interface WeftThread {
  id: string;
  /** 0..1 down the band. */
  y: number;
  opacity: number;
  colorToken: string;
  label: string;
  action: ThreadAction;
  kind: WeftKind;
  /** x positions (0..1) of visible knots — repaired/failed builds, and the
   *  single anchor knot of a generation thread. */
  knots: number[];
  /** A generation thread — its one knot is a woven crossing, not a loop. */
  knot?: boolean;
  /** The current generation only — the body that is running right now. */
  luminous?: boolean;
}

export interface WeaveModel {
  warp: WarpThread[];
  weft: WeftThread[];
}

// ── Caps ──────────────────────────────────────────────────────────────────────

// PERF CAP (honest): the band renders at most WARP_CAP + WEFT_CAP = 64 threads
// total. A long life is summarized, not fully drawn — organs, generations and
// scars win weft slots in that order; oldest builds fall off the cloth first.
export const WARP_CAP = 24;
export const WEFT_CAP = 40;

/** Max knots drawn per repaired thread — beyond this the count lives in the label. */
const KNOT_CAP = 3;

const LABEL_MAX = 64;

/** Generations whose sha has left the warp are tied along this left margin (0..1). */
const UNPLACED_MARGIN = 0.3;

// ── Deterministic seed — fnv-1a hash of an id/sha → [0,1) ─────────────────────

/** Exported for geometry.ts — the whole tapestry seeds from the same hash. */
export function hash01(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0x100000000;
}

// ── Age copy ──────────────────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;

/** "woven today" / "woven 1 day ago" / "woven N days ago" — never negative. */
export function formatAge(now: number, ts: number): string {
  const days = Math.floor(Math.max(0, now - ts) / DAY);
  if (days === 0) return "woven today";
  return days === 1 ? "woven 1 day ago" : `woven ${days} days ago`;
}

function truncate(s: string): string {
  return s.length > LABEL_MAX ? s.slice(0, LABEL_MAX - 1) + "…" : s;
}

// ── The loom ──────────────────────────────────────────────────────────────────

export function weaveModel(inputs: WeaveInputs): WeaveModel {
  // ---- warp: recent commits, newest brightest + furthest right ----
  const commits = inputs.commits.slice(0, WARP_CAP);
  const n = commits.length;
  const warp: WarpThread[] = commits.map((c, i) => ({
    id: `warp-${c.sha}`,
    // Even spacing in (0,1); i=0 (newest) closest to the right edge.
    x: (n - i) / (n + 1),
    // Newest ~0.85, decaying with age; never fully invisible.
    opacity: Math.max(0.12, 0.85 * Math.pow(0.88, i)),
    colorToken: "--t2",
    label: truncate(`commit ${c.sha.slice(0, 7)} · ${c.message}`),
    action: { kind: "commit", sha: c.sha },
  }));

  // ---- weft candidates, in slot-priority order ----
  const alive = new Set(inputs.organs.map((o) => o.id));

  type Candidate = Omit<WeftThread, "y" | "intensity">;
  const candidates: Candidate[] = [];

  // Alive organs — accent-bright, clickable, labeled with weave age when a
  // successful build record for the organ exists.
  for (const organ of inputs.organs) {
    const firstBuild = inputs.experiences
      .filter((e) => e.organId === organ.id && e.ok)
      .reduce<WeaveExperience | null>(
        (min, e) => (min === null || e.ts < min.ts ? e : min),
        null
      );
    candidates.push({
      id: `organ-${organ.id}`,
      opacity: 0.75,
      colorToken: "--accent",
      label: firstBuild
        ? `organ · ${organ.id} · ${formatAge(inputs.now, firstBuild.ts)}`
        : `organ · ${organ.id}`,
      action: { kind: "organ", id: organ.id },
      kind: "organ",
      knots: [],
    });
  }

  // Generations — each woven body of LOOM, tied where its genome commit stands
  // on the warp. A sha the warp no longer holds (older than WARP_CAP, or a
  // body woven elsewhere) still gets a place: ordered by wovenAt on the left
  // margin, newest furthest right, so no generation vanishes from the cloth.
  const warpX = new Map(commits.map((c, i) => [c.sha, warp[i].x] as const));
  const generations = [...(inputs.generations ?? [])].sort((a, b) => b.wovenAt - a.wovenAt);
  const unplaced = generations.filter((g) => !warpX.has(g.sha)).sort((a, b) => a.wovenAt - b.wovenAt);
  const marginX = new Map(
    unplaced.map((g, i) => [g.sha, UNPLACED_MARGIN * ((i + 1) / (unplaced.length + 1))] as const)
  );
  for (const g of generations) {
    const onWarp = warpX.has(g.sha);
    const x = onWarp ? warpX.get(g.sha)! : marginX.get(g.sha)!;
    candidates.push({
      id: `generation-${g.sha}`,
      opacity: g.isCurrent ? 0.9 : 0.4,
      colorToken: g.isCurrent ? "--accent" : "--t3",
      label: `generation · ${g.sha.slice(0, 7)} · ${formatAge(inputs.now, g.wovenAt)}${g.isCurrent ? " · current" : ""}`,
      action: onWarp ? { kind: "commit", sha: g.sha } : null,
      kind: "generation",
      knots: [x],
      knot: true,
      luminous: g.isCurrent,
    });
  }

  // Deleted organs — faint scar threads. Not clickable: there is nothing to open.
  for (const id of inputs.deletedOrganIds) {
    candidates.push({
      id: `scar-${id}`,
      opacity: 0.16,
      colorToken: "--t3",
      label: `organ · ${id} · unwoven scar`,
      action: null,
      kind: "scar",
      knots: [],
    });
  }

  // Build experiences — newest first so the freshest passes survive the cap.
  // Clean pass = smooth thread; repaired = visible knots; failed = warn-toned.
  const builds = [...inputs.experiences].sort((a, b) => b.ts - a.ts);
  for (const e of builds) {
    const id = `build-${e.organId}-${e.ts}`;
    const knotCount = e.ok ? Math.min(e.repairRounds, KNOT_CAP) : Math.max(1, Math.min(e.repairRounds, KNOT_CAP));
    const knots = e.ok && e.repairRounds === 0
      ? []
      : Array.from({ length: knotCount }, (_, k) => 0.1 + hash01(`${id}#${k}`) * 0.8);
    candidates.push({
      id,
      opacity: e.ok ? 0.32 : 0.28,
      colorToken: e.ok ? "--accent" : "--warn",
      label: e.ok
        ? `build · ${e.organId} · ${e.repairRounds === 0 ? "clean pass" : `repaired ×${e.repairRounds}`}`
        : `build · ${e.organId} · failed`,
      action: alive.has(e.organId) ? { kind: "organ", id: e.organId } : null,
      kind: "build",
      knots,
    });
  }

  // PERF CAP applied here — see the honest note above WARP_CAP/WEFT_CAP.
  const capped = candidates.slice(0, WEFT_CAP);

  // ---- y layout: even slots + small id-seeded jitter (no exact collisions) ----
  const m = capped.length;
  const weft: WeftThread[] = capped.map((c, i) => {
    const slot = (i + 1) / (m + 1);
    const jitter = (hash01(c.id) - 0.5) * (0.6 / (m + 1));
    return { ...c, y: slot + jitter };
  });

  return { warp, weft };
}
