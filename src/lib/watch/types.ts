/**
 * types.ts — canonical Watch types for LOOM's salience engine.
 *
 * WatchEvent: normalised form of any live world event (AUSPEX story, USGS quake, etc.)
 * ScoredEvent: WatchEvent enriched with a salience score and human-readable reasons.
 */

export interface WatchEvent {
  id: string;
  title: string;
  summary?: string;
  url?: string;
  /** Sensor source identifier ("auspex" | "quakes") */
  source: string;
  /**
   * AUSPEX story categories: "geo" | "military" | "finance" | "climate" | "tech"
   * AUSPEX typed event categories: "launch" | "space" | "cyclone" | "volcano" |
   *   "fire" | "flood" | "drought" | "earthquake" | "disaster" | "medical" |
   *   "physics" | "science"
   * USGS quake sensor: "seismic" | "seismic-major"
   */
  category: string;
  lat?: number;
  lng?: number;
  publishedAt: string; // ISO-8601
  magnitude?: number; // USGS quakes only
}

export interface ScoredEvent extends WatchEvent {
  score: number; // [0, 1] — higher is more salient
  reasons: string[]; // human-readable factor breakdown
}
