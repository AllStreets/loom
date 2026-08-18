/**
 * sensors.ts — live world sensors for the Watch runtime.
 *
 * Two free sensors LOOM can reach without API keys:
 *   - fetchAuspexStories(): AUSPEX's public Supabase stories table (anon REST)
 *   - fetchQuakes(): USGS all_day GeoJSON earthquake feed
 *
 * Both return WatchEvent[] and degrade gracefully on error (→ []).
 * A once-per-streak console.warn prevents log spam.
 */

import type { WatchEvent } from "./types";

// AUSPEX's public Supabase instance (publishable, RLS-protected anon key —
// the same one AUSPEX ships to every browser and AgentZeus already reads).
// This is NOT a new exposure: it is intentionally public by design.
const AUSPEX_SUPA_URL = "https://rdsmaktxefqtfxogoauq.supabase.co";
const AUSPEX_SUPA_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJkc21ha3R4ZWZxdGZ4b2dvYXVxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3MzI4MDAsImV4cCI6MjA5NzMwODgwMH0.N5zfuFrVIMdrZ9adXmiUVaD2EhCu0j1Inqf2ru4bJc8";

const USGS_ALL_DAY_URL =
  "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson";

const FETCH_TIMEOUT_MS = 10_000;

// ── Error-streak guards (prevent log spam) ─────────────────────────────────────

let auspexErrStreak = 0;
let quakesErrStreak = 0;

function onAuspexError(err: unknown) {
  auspexErrStreak++;
  if (auspexErrStreak === 1) {
    console.debug("[watch/sensors] AUSPEX fetch failed — will retry next poll:", err);
  }
}

function onAuspexSuccess() {
  if (auspexErrStreak > 0) {
    console.debug("[watch/sensors] AUSPEX feed restored after", auspexErrStreak, "failed poll(s)");
  }
  auspexErrStreak = 0;
}

function onQuakesError(err: unknown) {
  quakesErrStreak++;
  if (quakesErrStreak === 1) {
    console.debug("[watch/sensors] USGS quakes fetch failed — will retry next poll:", err);
  }
}

function onQuakesSuccess() {
  if (quakesErrStreak > 0) {
    console.debug("[watch/sensors] USGS quakes feed restored after", quakesErrStreak, "failed poll(s)");
  }
  quakesErrStreak = 0;
}

// ── Category mapping ───────────────────────────────────────────────────────────

/**
 * Maps AUSPEX story category strings to LOOM watch categories.
 * AUSPEX uses: geo, military, finance, climate, tech (and typed events like launch, cyclone…)
 */
function mapAuspexCategory(cat: string | null | undefined): string {
  if (!cat) return "world";
  const c = cat.toLowerCase().trim();
  // Direct pass-through for known categories
  const known = new Set([
    "geo", "military", "finance", "climate", "tech",
    "launch", "space", "cyclone", "volcano", "fire", "flood",
    "drought", "earthquake", "disaster", "medical", "physics", "science",
    "outage",
  ]);
  if (known.has(c)) return c;
  // Strip severity suffix (e.g. "climate-severe" → "climate")
  const base = c.replace(/-severe$/, "");
  if (known.has(base)) return base;
  return "world";
}

// ── AUSPEX sensor ─────────────────────────────────────────────────────────────

interface AuspexStoryRow {
  id: string;
  title: string;
  summary?: string | null;
  url?: string | null;
  category?: string | null;
  lat?: number | null;
  lng?: number | null;
  published_at?: string | null;
  agent_name?: string | null;
}

/**
 * Fetch recent stories from the AUSPEX public Supabase REST API.
 * Normalises each row into a WatchEvent.
 */
export async function fetchAuspexStories(limit = 50): Promise<WatchEvent[]> {
  const url =
    `${AUSPEX_SUPA_URL}/rest/v1/stories` +
    `?select=id,title,summary,url,category,lat,lng,published_at,agent_name` +
    `&order=published_at.desc` +
    `&limit=${limit}`;
  try {
    const res = await fetch(url, {
      headers: {
        apikey: AUSPEX_SUPA_KEY,
        Authorization: `Bearer ${AUSPEX_SUPA_KEY}`,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows: AuspexStoryRow[] = await res.json();
    if (!Array.isArray(rows)) throw new Error("Unexpected response shape");
    onAuspexSuccess();
    return rows.map((row): WatchEvent => ({
      id: `auspex:${row.id}`,
      title: row.title ?? "(untitled)",
      summary: row.summary ?? undefined,
      url: row.url ?? undefined,
      source: "auspex",
      category: mapAuspexCategory(row.category),
      lat: row.lat ?? undefined,
      lng: row.lng ?? undefined,
      publishedAt: row.published_at ?? new Date().toISOString(),
    }));
  } catch (err) {
    onAuspexError(err);
    return [];
  }
}

// ── USGS quake sensor ──────────────────────────────────────────────────────────

interface UsgsFeature {
  id: string;
  properties: {
    mag?: number | null;
    place?: string | null;
    time?: number | null;
    url?: string | null;
    title?: string | null;
  };
  geometry?: {
    coordinates?: [number, number, number];
  };
}

interface UsgsGeoJson {
  features: UsgsFeature[];
}

/**
 * Fetch USGS all_day earthquake GeoJSON and return events above minMag.
 * Category is "seismic" for mag < 6.0, "seismic-major" for mag >= 6.0.
 */
export async function fetchQuakes(minMag = 4.5): Promise<WatchEvent[]> {
  try {
    const res = await fetch(USGS_ALL_DAY_URL, {
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: UsgsGeoJson = await res.json();
    if (!data?.features || !Array.isArray(data.features)) {
      throw new Error("Unexpected GeoJSON shape");
    }
    onQuakesSuccess();
    return data.features
      .filter((f) => (f.properties.mag ?? 0) >= minMag)
      .map((f): WatchEvent => {
        const mag = f.properties.mag ?? 0;
        const coords = f.geometry?.coordinates;
        return {
          id: `quakes:${f.id}`,
          title: f.properties.title ?? `M${mag.toFixed(1)} earthquake`,
          url: f.properties.url ?? undefined,
          source: "quakes",
          category: mag >= 6.0 ? "seismic-major" : "seismic",
          lat: coords ? coords[1] : undefined,
          lng: coords ? coords[0] : undefined,
          publishedAt: f.properties.time
            ? new Date(f.properties.time).toISOString()
            : new Date().toISOString(),
          magnitude: mag,
        };
      });
  } catch (err) {
    onQuakesError(err);
    return [];
  }
}
