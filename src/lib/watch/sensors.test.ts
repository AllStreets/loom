import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchAuspexStories, fetchQuakes } from "./sensors";

// ── fetch mock helpers ────────────────────────────────────────────────────────

function mockFetchOk(data: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(data),
    })
  );
}

function mockFetchFail(status = 500) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: false,
      status,
      json: () => Promise.resolve([]),
    })
  );
}

function mockFetchNetworkError() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new Error("network error"))
  );
}

beforeEach(() => {
  vi.stubGlobal("AbortSignal", {
    timeout: vi.fn().mockReturnValue({}),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── fetchAuspexStories ────────────────────────────────────────────────────────

describe("fetchAuspexStories", () => {
  it("normalises rows into WatchEvent[]", async () => {
    mockFetchOk([
      {
        id: "abc123",
        title: "Cyclone Hits Coast",
        summary: "A strong cyclone...",
        url: "https://example.com/story/1",
        category: "cyclone",
        lat: 15.0,
        lng: 80.0,
        published_at: "2026-08-18T08:00:00Z",
        agent_name: "artemis",
      },
    ]);
    const events = await fetchAuspexStories(10);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: "auspex:abc123",
      title: "Cyclone Hits Coast",
      source: "auspex",
      category: "cyclone",
      lat: 15.0,
      lng: 80.0,
      publishedAt: "2026-08-18T08:00:00Z",
    });
    expect(events[0].magnitude).toBeUndefined();
  });

  it("handles null lat/lng gracefully", async () => {
    mockFetchOk([
      {
        id: "xyz",
        title: "Sanctions update",
        category: "geo",
        lat: null,
        lng: null,
        published_at: "2026-08-18T09:00:00Z",
      },
    ]);
    const events = await fetchAuspexStories();
    expect(events[0].lat).toBeUndefined();
    expect(events[0].lng).toBeUndefined();
  });

  it("maps category via category mapping (climate-severe → climate)", async () => {
    mockFetchOk([
      { id: "1", title: "Heat wave", category: "climate-severe", published_at: new Date().toISOString() },
    ]);
    const events = await fetchAuspexStories();
    expect(events[0].category).toBe("climate");
  });

  it("maps unknown category to 'world'", async () => {
    mockFetchOk([
      { id: "1", title: "Mystery event", category: "unknown-type", published_at: new Date().toISOString() },
    ]);
    const events = await fetchAuspexStories();
    expect(events[0].category).toBe("world");
  });

  it("prefixes id with 'auspex:'", async () => {
    mockFetchOk([{ id: "row1", title: "Test", category: "geo", published_at: new Date().toISOString() }]);
    const events = await fetchAuspexStories();
    expect(events[0].id).toBe("auspex:row1");
  });

  it("returns [] on HTTP error without throwing", async () => {
    mockFetchFail(503);
    const events = await fetchAuspexStories();
    expect(events).toEqual([]);
  });

  it("returns [] on network error without throwing", async () => {
    mockFetchNetworkError();
    const events = await fetchAuspexStories();
    expect(events).toEqual([]);
  });

  it("returns [] on unexpected response shape without throwing", async () => {
    mockFetchOk({ not: "an array" });
    const events = await fetchAuspexStories();
    expect(events).toEqual([]);
  });
});

// ── fetchQuakes ───────────────────────────────────────────────────────────────

const sampleUsgsGeoJson = {
  features: [
    {
      id: "us7000abcd",
      properties: {
        mag: 6.2,
        place: "50km NW of City",
        time: new Date("2026-08-18T07:00:00Z").getTime(),
        url: "https://earthquake.usgs.gov/detail/us7000abcd",
        title: "M 6.2 - 50km NW of City",
      },
      geometry: { coordinates: [140.5, 38.2, 10.0] },
    },
    {
      id: "us7000efgh",
      properties: {
        mag: 4.8,
        place: "Near Island",
        time: new Date("2026-08-18T06:00:00Z").getTime(),
        url: null,
        title: "M 4.8 - Near Island",
      },
      geometry: { coordinates: [145.0, 35.0, 30.0] },
    },
    {
      id: "us7000tiny",
      properties: {
        mag: 3.1, // below default minMag — should be filtered
        place: "Somewhere",
        time: Date.now(),
        title: "M 3.1 - Somewhere",
      },
      geometry: { coordinates: [100.0, 20.0, 5.0] },
    },
  ],
};

describe("fetchQuakes", () => {
  it("normalises features into WatchEvent[]", async () => {
    mockFetchOk(sampleUsgsGeoJson);
    const events = await fetchQuakes(4.5);
    expect(events).toHaveLength(2); // 3.1 filtered out
    const big = events.find((e) => e.id === "quakes:us7000abcd");
    expect(big).toBeDefined();
    expect(big).toMatchObject({
      source: "quakes",
      category: "seismic-major",
      lat: 38.2,
      lng: 140.5,
      magnitude: 6.2,
    });
    expect(big!.publishedAt).toBe("2026-08-18T07:00:00.000Z");
  });

  it("assigns seismic category for mag < 6.0", async () => {
    mockFetchOk(sampleUsgsGeoJson);
    const events = await fetchQuakes(4.5);
    const small = events.find((e) => e.id === "quakes:us7000efgh");
    expect(small?.category).toBe("seismic");
  });

  it("assigns seismic-major category for mag >= 6.0", async () => {
    mockFetchOk(sampleUsgsGeoJson);
    const events = await fetchQuakes(4.5);
    const big = events.find((e) => e.id === "quakes:us7000abcd");
    expect(big?.category).toBe("seismic-major");
  });

  it("filters by minMag", async () => {
    mockFetchOk(sampleUsgsGeoJson);
    const all = await fetchQuakes(4.5);
    expect(all.every((e) => (e.magnitude ?? 0) >= 4.5)).toBe(true);
  });

  it("prefixes id with 'quakes:'", async () => {
    mockFetchOk(sampleUsgsGeoJson);
    const events = await fetchQuakes(4.5);
    expect(events.every((e) => e.id.startsWith("quakes:"))).toBe(true);
  });

  it("returns [] on HTTP error without throwing", async () => {
    mockFetchFail(504);
    const events = await fetchQuakes();
    expect(events).toEqual([]);
  });

  it("returns [] on network error without throwing", async () => {
    mockFetchNetworkError();
    const events = await fetchQuakes();
    expect(events).toEqual([]);
  });

  it("returns [] on unexpected response shape without throwing", async () => {
    mockFetchOk({ no_features: true });
    const events = await fetchQuakes();
    expect(events).toEqual([]);
  });
});
