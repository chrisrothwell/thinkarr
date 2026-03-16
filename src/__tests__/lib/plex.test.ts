/**
 * Unit tests for plex.ts — focuses on mapMetadata behaviour for issue #14/#16:
 * - Season items use showTitle (parentTitle) so the LLM doesn't see bare "Season N"
 * - Episode items include showTitle, seasonNumber, episodeNumber
 * - getRecentlyAdded deduplicates TV entries by show
 * - searchCollections returns items from a matching collection (issue #15)
 * - searchByTag returns items tagged with a given genre (issue #15)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the config module (not needed for pure mapping logic, but plex.ts imports it)
vi.mock("@/lib/config", () => ({
  getConfig: (key: string) => {
    if (key === "plex.url") return "http://plex.local:32400";
    if (key === "plex.token") return "test-token";
    return null;
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// We test the exported functions after mocking fetch
const MOVIE_ITEM = {
  title: "The Matrix",
  year: 1999,
  type: "movie",
  summary: "A hacker discovers the truth.",
  rating: 8.7,
  key: "/library/metadata/1",
  thumb: "/library/metadata/1/thumb/100",
  addedAt: 1700000000,
};

const SEASON_ITEM = {
  title: "Season 1",          // Bare season title — should be replaced
  type: "season",
  parentTitle: "Breaking Bad", // Show name lives here
  index: 1,                   // Season number
  key: "/library/metadata/2",
  thumb: "/library/metadata/2/thumb/200",
  addedAt: 1700000001,
  leafCount: 7,
};

const EPISODE_ITEM = {
  title: "Pilot",
  type: "episode",
  grandparentTitle: "Breaking Bad",
  parentIndex: 1,  // season
  index: 1,        // episode
  key: "/library/metadata/3",
  thumb: "/library/metadata/3/thumb/300",
  addedAt: 1700000002,
};

describe("getRecentlyAdded — deduplication and title mapping", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        MediaContainer: {
          Metadata: [
            MOVIE_ITEM,
            SEASON_ITEM,
            // Two more seasons from the same show — should be deduped
            { ...SEASON_ITEM, index: 2, title: "Season 2" },
            { ...SEASON_ITEM, index: 3, title: "Season 3" },
          ],
        },
      }),
    }));
  });

  it("maps movie items with correct type and title", async () => {
    const { getRecentlyAdded } = await import("@/lib/services/plex");
    const results = await getRecentlyAdded();
    const movie = results.find((r) => r.type === "movie");
    expect(movie).toBeDefined();
    expect(movie!.title).toBe("The Matrix");
  });

  it("maps season items: title includes show name, not bare 'Season N'", async () => {
    const { getRecentlyAdded } = await import("@/lib/services/plex");
    const results = await getRecentlyAdded();
    const season = results.find((r) => r.type === "season");
    expect(season).toBeDefined();
    expect(season!.title).toContain("Breaking Bad");
    expect(season!.title).not.toBe("Season 1");
    expect(season!.showTitle).toBe("Breaking Bad");
    expect(season!.seasonNumber).toBe(1);
  });

  it("deduplicates multiple seasons from the same show", async () => {
    const { getRecentlyAdded } = await import("@/lib/services/plex");
    const results = await getRecentlyAdded();
    const seasons = results.filter((r) => r.type === "season");
    // All three seasons share showTitle "Breaking Bad" → only one should appear
    expect(seasons.length).toBe(1);
  });
});

describe("mapMetadata — episode parent context", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        MediaContainer: {
          Metadata: [EPISODE_ITEM],
        },
      }),
    }));
  });

  it("episode items include showTitle, seasonNumber, episodeNumber", async () => {
    const { getRecentlyAdded } = await import("@/lib/services/plex");
    const results = await getRecentlyAdded();
    const ep = results.find((r) => r.type === "episode");
    expect(ep).toBeDefined();
    expect(ep!.showTitle).toBe("Breaking Bad");
    expect(ep!.seasonNumber).toBe(1);
    expect(ep!.episodeNumber).toBe(1);
  });
});

describe("searchCollections — issue #15", () => {
  it("returns items from the matching collection", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({
        // GET /library/sections
        ok: true,
        json: async () => ({ MediaContainer: { Directory: [{ key: "1" }] } }),
      })
      .mockResolvedValueOnce({
        // GET /library/sections/1/collections?title=Marvel
        ok: true,
        json: async () => ({
          MediaContainer: { Metadata: [{ ratingKey: "42", title: "Marvel", key: "/library/collections/42" }] },
        }),
      })
      .mockResolvedValueOnce({
        // GET /library/collections/42/children
        ok: true,
        json: async () => ({
          MediaContainer: { Metadata: [MOVIE_ITEM] },
        }),
      }));

    const { searchCollections } = await import("@/lib/services/plex");
    const results = await searchCollections("Marvel");
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("The Matrix");
  });

  it("returns empty array when no collection matches", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ MediaContainer: { Directory: [{ key: "1" }] } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ MediaContainer: { Metadata: [] } }),
      }));

    const { searchCollections } = await import("@/lib/services/plex");
    const results = await searchCollections("Nonexistent");
    expect(results).toHaveLength(0);
  });
});

describe("searchByTag — issue #15", () => {
  it("returns items matching the genre tag across sections", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({
        // GET /library/sections
        ok: true,
        json: async () => ({
          MediaContainer: { Directory: [{ key: "1", type: "movie" }] },
        }),
      })
      .mockResolvedValueOnce({
        // GET /library/sections/1/all?type=1&genre=Action
        ok: true,
        json: async () => ({
          MediaContainer: { Metadata: [MOVIE_ITEM] },
        }),
      }));

    const { searchByTag } = await import("@/lib/services/plex");
    const results = await searchByTag("Action");
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("The Matrix");
  });

  it("skips non-movie and non-show sections", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          MediaContainer: { Directory: [{ key: "1", type: "photo" }, { key: "2", type: "music" }] },
        }),
      }));

    const { searchByTag } = await import("@/lib/services/plex");
    const results = await searchByTag("Action");
    expect(results).toHaveLength(0);
  });
});
