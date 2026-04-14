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
// Library series returned by /series — all have id (issue #361)
// ---------------------------------------------------------------------------
const FAKE_LIBRARY = [
  { id: 10, title: "CIA (2026)", year: 2026, status: "continuing", monitored: true, tvdbId: 462856, seasons: [{}, {}] },
  { id: 11, title: "CIA Files", year: 2020, status: "ended", monitored: true, tvdbId: 222222, seasons: [{}] },
  { id: 12, title: "Scrubs (2026)", year: 2026, status: "continuing", monitored: true, tvdbId: 465690, seasons: [{}, {}, {}] },
  { id: 13, title: "Run", year: 2019, status: "ended", monitored: false, tvdbId: 333333, seasons: [] },
];

describe("searchSeries — searches library only, never /series/lookup (issue #361)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        // Must call /series, not /series/lookup
        if ((url as string).includes("/series/lookup")) throw new Error("lookup endpoint must not be called");
        const match = FAKE_LIBRARY.find((s) => (url as string).endsWith(`/series/${s.id}`));
        return { ok: true, status: 200, json: async () => match ?? FAKE_LIBRARY };
      }),
    );
  });

  it("returns library entries matching title substring", async () => {
    const results = await searchSeries("CIA");
    expect(results.map((r) => r.title)).toEqual(["CIA (2026)", "CIA Files"]);
  });

  it("matches by year when a 4-digit year term is given", async () => {
    const results = await searchSeries("2026");
    expect(results.map((r) => r.title)).toEqual(["CIA (2026)", "Scrubs (2026)"]);
  });

  it("returns empty array when no library series match", async () => {
    const results = await searchSeries("Way of Choices");
    expect(results).toHaveLength(0);
  });

  it("derives seasonCount from seasons array", async () => {
    const results = await searchSeries("CIA (2026)");
    expect(results[0].seasonCount).toBe(2);
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
