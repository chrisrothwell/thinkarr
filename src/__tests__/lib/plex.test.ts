/**
 * Unit tests for plex.ts — focuses on mapMetadata behaviour for issue #14/#16:
 * - Season items use showTitle (parentTitle) so the LLM doesn't see bare "Season N"
 * - Episode items include showTitle, seasonNumber, episodeNumber
 * - getRecentlyAdded deduplicates TV entries by show
 * - searchCollections returns items from a matching collection (issue #15)
 * - searchByTag returns items tagged with a given genre (issue #15)
 * - Pagination: all search functions return { results, hasMore } (issue #109)
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

  it("maps movie items with correct mediaType and title", async () => {
    const { getRecentlyAdded } = await import("@/lib/services/plex");
    const { results } = await getRecentlyAdded();
    const movie = results.find((r) => r.mediaType === "movie");
    expect(movie).toBeDefined();
    expect(movie!.title).toBe("The Matrix");
  });

  it("maps season items: mediaType is 'tv', title includes show name, not bare 'Season N'", async () => {
    const { getRecentlyAdded } = await import("@/lib/services/plex");
    const { results } = await getRecentlyAdded();
    // Seasons now have mediaType "tv" (normalized from "season")
    const season = results.find((r) => r.mediaType === "tv" && r.showTitle);
    expect(season).toBeDefined();
    expect(season!.title).toContain("Breaking Bad");
    expect(season!.title).not.toBe("Season 1");
    expect(season!.showTitle).toBe("Breaking Bad");
    expect(season!.seasonNumber).toBe(1);
  });

  it("deduplicates multiple seasons from the same show", async () => {
    const { getRecentlyAdded } = await import("@/lib/services/plex");
    const { results } = await getRecentlyAdded();
    const tvItems = results.filter((r) => r.mediaType === "tv");
    // All three seasons share showTitle "Breaking Bad" → only one should appear
    expect(tvItems.length).toBe(1);
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
    const { results } = await getRecentlyAdded();
    const ep = results.find((r) => r.mediaType === "episode");
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
    const { results } = await searchCollections("Marvel");
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
    const { results, hasMore } = await searchCollections("Nonexistent");
    expect(results).toHaveLength(0);
    expect(hasMore).toBe(false);
  });
});

describe("searchCollections — issue #109: pagination", () => {
  it("returns hasMore=true when collection has more than 10 items", async () => {
    // Build 11 items — page 1 shows 0-9, hasMore=true (item 10 exists)
    const items = Array.from({ length: 11 }, (_, i) => ({ ...MOVIE_ITEM, title: `Film ${i}`, key: `/library/metadata/${i}` }));
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ MediaContainer: { Directory: [{ key: "1" }] } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ MediaContainer: { Metadata: [{ ratingKey: "1", title: "Big" }] } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ MediaContainer: { Metadata: items } }),
      }));

    const { searchCollections } = await import("@/lib/services/plex");
    const { results, hasMore } = await searchCollections("Big", 1);
    expect(results).toHaveLength(10);
    expect(hasMore).toBe(true);
  });

  it("page 2 returns items 10-19", async () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ ...MOVIE_ITEM, title: `Film ${i}`, key: `/library/metadata/${i}` }));
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ MediaContainer: { Directory: [{ key: "1" }] } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ MediaContainer: { Metadata: [{ ratingKey: "1", title: "Big" }] } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ MediaContainer: { Metadata: items } }),
      }));

    const { searchCollections } = await import("@/lib/services/plex");
    const { results, hasMore } = await searchCollections("Big", 2);
    expect(results).toHaveLength(10);
    expect(results[0].title).toBe("Film 10");
    expect(hasMore).toBe(false);
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
    const { results } = await searchByTag("Action");
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("The Matrix");
  });

  it("uses the correct query parameter for each tagType", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          MediaContainer: { Directory: [{ key: "1", type: "movie" }] },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ MediaContainer: { Metadata: [MOVIE_ITEM] } }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const { searchByTag } = await import("@/lib/services/plex");
    await searchByTag("Canada", "country");

    // The second fetch call should use country= not genre=
    const secondCallUrl = (fetchMock.mock.calls[1][0] as string);
    expect(secondCallUrl).toContain("country=Canada");
    expect(secondCallUrl).not.toContain("genre=");
  });

  it("uses director= parameter when tagType is director", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          MediaContainer: { Directory: [{ key: "1", type: "movie" }] },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ MediaContainer: { Metadata: [MOVIE_ITEM] } }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const { searchByTag } = await import("@/lib/services/plex");
    await searchByTag("Christopher Nolan", "director");

    const secondCallUrl = (fetchMock.mock.calls[1][0] as string);
    expect(secondCallUrl).toContain("director=Christopher%20Nolan");
  });

  it("defaults to genre= when no tagType is provided", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          MediaContainer: { Directory: [{ key: "1", type: "movie" }] },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ MediaContainer: { Metadata: [MOVIE_ITEM] } }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const { searchByTag } = await import("@/lib/services/plex");
    await searchByTag("Horror");

    const secondCallUrl = (fetchMock.mock.calls[1][0] as string);
    expect(secondCallUrl).toContain("genre=Horror");
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
    const { results } = await searchByTag("Action");
    expect(results).toHaveLength(0);
  });
});

describe("searchByTag — issue #109: pagination", () => {
  it("returns hasMore=true when more than 10 items match", async () => {
    // 11 items → page 1 shows 0-9, hasMore=true
    const items = Array.from({ length: 11 }, (_, i) => ({ ...MOVIE_ITEM, title: `Film ${i}`, key: `/library/metadata/${i}` }));
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ MediaContainer: { Directory: [{ key: "1", type: "movie" }] } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ MediaContainer: { Metadata: items } }),
      }));

    const { searchByTag } = await import("@/lib/services/plex");
    const { results, hasMore } = await searchByTag("Action");
    expect(results).toHaveLength(10);
    expect(hasMore).toBe(true);
  });

  it("page 2 returns items 10-19 (second LLM page of first API batch)", async () => {
    // page=2: apiBatch=0, llmOffset=10; need 21 items to detect hasMore
    const items = Array.from({ length: 21 }, (_, i) => ({ ...MOVIE_ITEM, title: `Film ${i}`, key: `/library/metadata/${i}` }));
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ MediaContainer: { Directory: [{ key: "1", type: "movie" }] } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ MediaContainer: { Metadata: items } }),
      }));

    const { searchByTag } = await import("@/lib/services/plex");
    const { results, hasMore } = await searchByTag("Action", "genre", 2);
    expect(results[0].title).toBe("Film 10");
    expect(results).toHaveLength(10);
    expect(hasMore).toBe(true);
  });
});

describe("getOnDeck — issue #109: pagination", () => {
  it("returns hasMore=false when fewer than 11 items returned", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ MediaContainer: { Metadata: [MOVIE_ITEM] } }),
    }));

    const { getOnDeck } = await import("@/lib/services/plex");
    const { results, hasMore } = await getOnDeck();
    expect(results).toHaveLength(1);
    expect(hasMore).toBe(false);
  });

  it("returns hasMore=true and exactly 10 results when API returns 11 items", async () => {
    const items = Array.from({ length: 11 }, (_, i) => ({ ...MOVIE_ITEM, title: `Film ${i}`, key: `/library/metadata/${i}` }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ MediaContainer: { Metadata: items } }),
    }));

    const { getOnDeck } = await import("@/lib/services/plex");
    const { results, hasMore } = await getOnDeck();
    expect(results).toHaveLength(10);
    expect(hasMore).toBe(true);
  });
});

describe("getTagsForTitle — issue #99: season/episode keys should fetch parent show tags", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  const SHOW_METADATA = {
    title: "Breaking Bad",
    type: "show",
    Genre: [{ tag: "Drama" }, { tag: "Crime" }],
    Director: [],
    Role: [{ tag: "Bryan Cranston" }],
    Country: [{ tag: "United States" }],
    studio: "AMC",
    contentRating: "TV-MA",
    Label: [],
  };

  it("fetches tags from parent show when key points to a season", async () => {
    const seasonMetadata = {
      title: "Season 1",
      type: "season",
      parentKey: "/library/metadata/99",
      Genre: [],
      Director: [],
      Role: [],
      Country: [],
      Label: [],
    };

    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({
        // First fetch: season metadata
        ok: true,
        json: async () => ({ MediaContainer: { Metadata: [seasonMetadata] } }),
      })
      .mockResolvedValueOnce({
        // Second fetch: parent show metadata
        ok: true,
        json: async () => ({ MediaContainer: { Metadata: [SHOW_METADATA] } }),
      }));

    const { getTagsForTitle } = await import("@/lib/services/plex");
    const tags = await getTagsForTitle("/library/metadata/10");
    expect(tags.genres).toEqual(["Drama", "Crime"]);
    expect(tags.actors).toContain("Bryan Cranston");
    expect(tags.studio).toBe("AMC");
  });

  it("fetches tags from grandparent show when key points to an episode", async () => {
    const episodeMetadata = {
      title: "Pilot",
      type: "episode",
      grandparentKey: "/library/metadata/99",
      Genre: [],
      Director: [],
      Role: [],
      Country: [],
      Label: [],
    };

    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({
        // First fetch: episode metadata
        ok: true,
        json: async () => ({ MediaContainer: { Metadata: [episodeMetadata] } }),
      })
      .mockResolvedValueOnce({
        // Second fetch: grandparent show metadata
        ok: true,
        json: async () => ({ MediaContainer: { Metadata: [SHOW_METADATA] } }),
      }));

    const { getTagsForTitle } = await import("@/lib/services/plex");
    const tags = await getTagsForTitle("/library/metadata/11");
    expect(tags.genres).toEqual(["Drama", "Crime"]);
    expect(tags.studio).toBe("AMC");
  });

  it("falls back to season metadata when parent fetch fails", async () => {
    const seasonMetadata = {
      title: "Season 1",
      type: "season",
      parentKey: "/library/metadata/99",
      Genre: [{ tag: "Fallback Genre" }],
      Director: [],
      Role: [],
      Country: [],
      Label: [],
    };

    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ MediaContainer: { Metadata: [seasonMetadata] } }),
      })
      .mockRejectedValueOnce(new Error("Network error")));

    const { getTagsForTitle } = await import("@/lib/services/plex");
    // Should not throw; falls back to season metadata
    const tags = await getTagsForTitle("/library/metadata/10");
    expect(tags.genres).toEqual(["Fallback Genre"]);
  });
});

describe("getTagsForTitle — issue #15", () => {
  it("returns all tag categories for a title", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        MediaContainer: {
          Metadata: [{
            title: "Inception",
            Genre: [{ tag: "Action" }, { tag: "Sci-Fi" }],
            Director: [{ tag: "Christopher Nolan" }],
            Role: [{ tag: "Leonardo DiCaprio" }, { tag: "Tom Hardy" }],
            Country: [{ tag: "United States" }, { tag: "United Kingdom" }],
            studio: "Warner Bros.",
            contentRating: "PG-13",
            Label: [],
          }],
        },
      }),
    }));

    const { getTagsForTitle } = await import("@/lib/services/plex");
    const tags = await getTagsForTitle("/library/metadata/100");
    expect(tags.title).toBe("Inception");
    expect(tags.genres).toEqual(["Action", "Sci-Fi"]);
    expect(tags.directors).toEqual(["Christopher Nolan"]);
    expect(tags.actors).toEqual(["Leonardo DiCaprio", "Tom Hardy"]);
    expect(tags.countries).toEqual(["United States", "United Kingdom"]);
    expect(tags.studio).toBe("Warner Bros.");
    expect(tags.contentRating).toBe("PG-13");
    expect(tags.labels).toEqual([]);
  });

  it("returns empty arrays for missing tag fields", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        MediaContainer: {
          Metadata: [{ title: "Simple Movie" }],
        },
      }),
    }));

    const { getTagsForTitle } = await import("@/lib/services/plex");
    const tags = await getTagsForTitle("/library/metadata/200");
    expect(tags.genres).toEqual([]);
    expect(tags.directors).toEqual([]);
    expect(tags.actors).toEqual([]);
    expect(tags.countries).toEqual([]);
    expect(tags.labels).toEqual([]);
    expect(tags.studio).toBeUndefined();
    expect(tags.contentRating).toBeUndefined();
  });
});

describe("getSeriesEpisodes — issue #197", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  const SEASON_CHILDREN = [
    {
      type: "season",
      index: 1,
      ratingKey: "200",
      key: "/library/metadata/200/children",
      parentTitle: "Breaking Bad",
      title: "Season 1",
      leafCount: 7,
      viewedLeafCount: 3,
      thumb: "/thumb/200",
    },
    {
      type: "season",
      index: 2,
      ratingKey: "201",
      key: "/library/metadata/201/children",
      parentTitle: "Breaking Bad",
      title: "Season 2",
      leafCount: 13,
      viewedLeafCount: 0,
      thumb: "/thumb/201",
    },
  ];

  const SEASON1_EPISODES = [
    { type: "episode", index: 1, parentIndex: 1, ratingKey: "301", key: "/library/metadata/301", grandparentTitle: "Breaking Bad", title: "Pilot", thumb: "/thumb/301" },
    { type: "episode", index: 2, parentIndex: 1, ratingKey: "302", key: "/library/metadata/302", grandparentTitle: "Breaking Bad", title: "Cat's in the Bag", thumb: "/thumb/302" },
    { type: "episode", index: 3, parentIndex: 1, ratingKey: "303", key: "/library/metadata/303", grandparentTitle: "Breaking Bad", title: "And the Bag's in the River", thumb: "/thumb/303" },
  ];

  it("returns one card per season ordered by season number when no season given", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ MediaContainer: { Metadata: SEASON_CHILDREN } }),
    }));

    const { getSeriesEpisodes } = await import("@/lib/services/plex");
    const { results, hasMore } = await getSeriesEpisodes("/library/metadata/100");
    expect(results).toHaveLength(2);
    expect(results[0].seasonNumber).toBe(1);
    expect(results[1].seasonNumber).toBe(2);
    expect(results[0].totalEpisodes).toBe(7);
    expect(results[0].watchedEpisodes).toBe(3);
    expect(results[0].mediaType).toBe("tv");
    expect(hasMore).toBe(false);
  });

  it("excludes season 0 (specials) when no season given", async () => {
    const withSpecials = [
      { type: "season", index: 0, ratingKey: "199", key: "/library/metadata/199/children", parentTitle: "BB", title: "Specials", leafCount: 2, viewedLeafCount: 0 },
      ...SEASON_CHILDREN,
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ MediaContainer: { Metadata: withSpecials } }),
    }));

    const { getSeriesEpisodes } = await import("@/lib/services/plex");
    const { results } = await getSeriesEpisodes("/library/metadata/100");
    expect(results).toHaveLength(2);
    expect(results.every((r) => (r.seasonNumber ?? 0) > 0)).toBe(true);
  });

  it("returns episodes from the requested season ordered by episode number", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({
        // GET /library/metadata/100/children → seasons
        ok: true,
        json: async () => ({ MediaContainer: { Metadata: SEASON_CHILDREN } }),
      })
      .mockResolvedValueOnce({
        // GET /library/metadata/200/children → season 1 episodes
        ok: true,
        json: async () => ({ MediaContainer: { Metadata: SEASON1_EPISODES } }),
      }));

    const { getSeriesEpisodes } = await import("@/lib/services/plex");
    const { results } = await getSeriesEpisodes("/library/metadata/100", 1);
    expect(results).toHaveLength(3);
    expect(results[0].title).toBe("Pilot");
    expect(results[0].episodeNumber).toBe(1);
    expect(results[1].episodeNumber).toBe(2);
    expect(results[2].episodeNumber).toBe(3);
    expect(results[0].mediaType).toBe("episode");
    expect(results[0].showTitle).toBe("Breaking Bad");
    expect(results[0].seasonNumber).toBe(1);
  });

  it("returns a single episode when both season and episode are given", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ MediaContainer: { Metadata: SEASON_CHILDREN } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ MediaContainer: { Metadata: SEASON1_EPISODES } }),
      }));

    const { getSeriesEpisodes } = await import("@/lib/services/plex");
    const { results } = await getSeriesEpisodes("/library/metadata/100", 1, 2);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Cat's in the Bag");
    expect(results[0].episodeNumber).toBe(2);
  });

  it("returns empty array when episode number not found", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ MediaContainer: { Metadata: SEASON_CHILDREN } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ MediaContainer: { Metadata: SEASON1_EPISODES } }),
      }));

    const { getSeriesEpisodes } = await import("@/lib/services/plex");
    const { results } = await getSeriesEpisodes("/library/metadata/100", 1, 99);
    expect(results).toHaveLength(0);
  });

  it("returns empty array when requested season not found", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ MediaContainer: { Metadata: SEASON_CHILDREN } }),
    }));

    const { getSeriesEpisodes } = await import("@/lib/services/plex");
    const { results } = await getSeriesEpisodes("/library/metadata/100", 5);
    expect(results).toHaveLength(0);
  });

  it("uses ratingKey to fetch season episodes", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ MediaContainer: { Metadata: SEASON_CHILDREN } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ MediaContainer: { Metadata: SEASON1_EPISODES } }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const { getSeriesEpisodes } = await import("@/lib/services/plex");
    await getSeriesEpisodes("/library/metadata/100", 1);

    // Second fetch should use ratingKey=200 to get episodes
    const secondUrl = fetchMock.mock.calls[1][0] as string;
    expect(secondUrl).toContain("/library/metadata/200/children");
  });
});
