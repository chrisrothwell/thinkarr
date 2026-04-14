/**
 * Unit tests for sonarr.ts — specifically the title-matching logic in
 * getSeriesStatus() (issue #270).
 *
 * The original implementation used substring matching (.includes()), which
 * caused "Celebrity Race Across the World" to be returned when the user asked
 * about "Race Across the World", exhausting tool call rounds on a wrong match.
 *
 * The fix: prefer exact (case-insensitive) match; fall back to substring only
 * when no exact match exists.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------
vi.mock("@/lib/config", () => ({ getConfig: vi.fn((key: string) => (key === "sonarr.url" ? "http://sonarr" : "apikey")) }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// ---------------------------------------------------------------------------
// Fake series list returned by the /series endpoint
// ---------------------------------------------------------------------------
const FAKE_SERIES = [
  { id: 1, title: "Celebrity Race Across the World", year: 2023, status: "continuing", monitored: false, seasons: [], statistics: { totalEpisodeCount: 18, episodeCount: 6 } },
  { id: 2, title: "Race Across the World", year: 2019, status: "continuing", monitored: true, seasons: [], statistics: { totalEpisodeCount: 24, episodeCount: 24 } },
  { id: 3, title: "The Amazing Race", year: 2001, status: "continuing", monitored: false, seasons: [], statistics: { totalEpisodeCount: 100, episodeCount: 50 } },
];

// ---------------------------------------------------------------------------
// Mock fetch — /series returns FAKE_SERIES; /series/:id returns the matching entry
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const match = FAKE_SERIES.find((s) => url.endsWith(`/series/${s.id}`));
      const body = match ?? FAKE_SERIES;
      return { ok: true, status: 200, json: async () => body };
    }),
  );
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
import { getSeriesStatus, searchSeries } from "@/lib/services/sonarr";

// ---------------------------------------------------------------------------
// Lookup results: mix of library entries (have id) and external lookups (no id)
// ---------------------------------------------------------------------------
const FAKE_LOOKUP = [
  { id: 10, title: "CIA", year: 2026, status: "continuing", monitored: true, tvdbId: 462856 },
  { title: "CIA (1992)", year: 1992, status: "ended", monitored: false, tvdbId: 111111 },
  { id: 11, title: "CIA Files", year: 2020, status: "ended", monitored: true, tvdbId: 222222 },
];

describe("searchSeries — filters to library entries only", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => FAKE_LOOKUP })),
    );
  });

  it("excludes results with no id (not in the Sonarr library)", async () => {
    const results = await searchSeries("CIA");
    expect(results.every((r) => r.id !== undefined)).toBe(true);
  });

  it("returns only the two library entries", async () => {
    const results = await searchSeries("CIA");
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.title)).toEqual(["CIA", "CIA Files"]);
  });
});

describe("getSeriesStatus — title matching", () => {
  it("returns the exact match when a more specific title also contains the search term", async () => {
    const result = await getSeriesStatus("Race Across the World");
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Race Across the World");
  });

  it("is case-insensitive for exact match", async () => {
    const result = await getSeriesStatus("race across the world");
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Race Across the World");
  });

  it("falls back to substring match when no exact match exists", async () => {
    // "Celebrity" alone won't exact-match anything but will substring-match "Celebrity Race Across the World"
    const result = await getSeriesStatus("Celebrity Race");
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Celebrity Race Across the World");
  });

  it("returns null when the series is not in Sonarr at all", async () => {
    const result = await getSeriesStatus("Nonexistent Show");
    expect(result).toBeNull();
  });
});
