/**
 * Unit tests for overseerr.ts — focuses on the listRequests title resolution fix (issue #89).
 * The /request endpoint returns media objects with IDs but not titles; listRequests must
 * fetch titles in parallel from /movie/{tmdbId} or /tv/{tmdbId}.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/config", () => ({
  getConfig: (key: string) => {
    if (key === "overseerr.url") return "http://overseerr.local:5055";
    if (key === "overseerr.apiKey") return "test-api-key";
    return null;
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const MOVIE_REQUEST = {
  id: 706,
  type: "movie",
  status: 2,
  media: { id: 1, mediaType: "movie", tmdbId: 550 },
  requestedBy: { displayName: "alice" },
  createdAt: "2026-01-01T00:00:00.000Z",
  seasons: [],
};

const TV_REQUEST = {
  id: 707,
  type: "tv",
  status: 2,
  media: { id: 2, mediaType: "tv", tmdbId: 1396 },
  requestedBy: { displayName: "bob" },
  createdAt: "2026-01-02T00:00:00.000Z",
  seasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }],
};

describe("search — no per-result detail fetches", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("makes exactly one fetch (the search call) regardless of result count", async () => {
    const makeResult = (id: number) => ({
      id, mediaType: "movie", title: `Film ${id}`,
      releaseDate: "2020-01-01", posterPath: "/poster.jpg",
      overview: "A film.", voteAverage: 7.0, mediaInfo: { status: 5 },
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: Array.from({ length: 5 }, (_, i) => makeResult(i + 1)) }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { search } = await import("@/lib/services/overseerr");
    await search("action film");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not include cast or imdbId in search results", async () => {
    const searchResult = {
      id: 550, mediaType: "movie", title: "Fight Club",
      releaseDate: "1999-10-15", posterPath: "/poster.jpg",
      overview: "A movie about soap.", voteAverage: 8.4,
      mediaInfo: { status: 5 },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [searchResult] }),
    }));

    const { search } = await import("@/lib/services/overseerr");
    const { results } = await search("Fight Club");
    expect(results[0]).not.toHaveProperty("cast");
    expect(results[0]).not.toHaveProperty("imdbId");
  });

  it("includes mediaStatus, summary, rating, and thumbPath from search payload", async () => {
    const searchResult = {
      id: 550, mediaType: "movie", title: "Fight Club",
      releaseDate: "1999-10-15", posterPath: "/poster.jpg",
      overview: "A movie about soap.", voteAverage: 8.4,
      mediaInfo: { status: 5 }, // Available
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [searchResult] }),
    }));

    const { search } = await import("@/lib/services/overseerr");
    const { results } = await search("Fight Club");
    expect(results[0].mediaStatus).toBe("Available");
    expect(results[0].summary).toBe("A movie about soap.");
    expect(results[0].rating).toBe(8.4);
    expect(results[0].thumbPath).toBe("https://image.tmdb.org/t/p/w300/poster.jpg");
  });

  it("includes seasonCount for TV shows from search payload (no detail fetch needed)", async () => {
    const tvSearchResult = {
      id: 1396, mediaType: "tv", name: "Breaking Bad",
      firstAirDate: "2008-01-20", posterPath: "/poster.jpg",
      overview: "A chemistry teacher turns to crime.",
      numberOfSeasons: 5, mediaInfo: { status: 5 },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [tvSearchResult] }),
    }));

    const { search } = await import("@/lib/services/overseerr");
    const { results } = await search("Breaking Bad");
    expect(results[0].seasonCount).toBe(5);
  });
});

describe("getDetails — returns cast, imdbId, genres, runtime, seasons, requests", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns cast (top 10) from movie detail endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        title: "Fight Club",
        releaseDate: "1999-10-15",
        runtime: 139,
        credits: {
          cast: [
            { name: "Brad Pitt" },
            { name: "Edward Norton" },
            { name: "Helena Bonham Carter" },
          ],
        },
        genres: [{ name: "Drama" }, { name: "Thriller" }],
        externalIds: { imdbId: "tt0137523" },
        mediaInfo: { status: 5, requests: [], seasons: [] },
      }),
    }));

    const { getDetails } = await import("@/lib/services/overseerr");
    const detail = await getDetails(550, "movie");
    expect(detail.cast).toEqual(["Brad Pitt", "Edward Norton", "Helena Bonham Carter"]);
    expect(detail.imdbId).toBe("tt0137523");
    expect(detail.genres).toEqual(["Drama", "Thriller"]);
    expect(detail.runtime).toBe(139);
  });

  it("returns cast, seasonCount, episodeRuntime, and per-season status for TV", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        name: "Breaking Bad",
        firstAirDate: "2008-01-20",
        numberOfSeasons: 5,
        episodeRunTime: [47],
        credits: {
          cast: [{ name: "Bryan Cranston" }, { name: "Aaron Paul" }],
        },
        externalIds: { imdbId: "tt0903747" },
        mediaInfo: {
          status: 5,
          seasons: [
            { seasonNumber: 1, status: 5 },
            { seasonNumber: 2, status: 5 },
          ],
          requests: [],
        },
      }),
    }));

    const { getDetails } = await import("@/lib/services/overseerr");
    const detail = await getDetails(1396, "tv");
    expect(detail.cast).toEqual(["Bryan Cranston", "Aaron Paul"]);
    expect(detail.seasonCount).toBe(5);
    expect(detail.episodeRuntime).toBe(47);
    expect(detail.seasons).toHaveLength(2);
    expect(detail.seasons![0]).toEqual({ seasonNumber: 1, status: "Available" });
  });

  it("includes request history with seasonsRequested for TV", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        name: "Breaking Bad",
        firstAirDate: "2008-01-20",
        numberOfSeasons: 5,
        credits: { cast: [] },
        externalIds: {},
        mediaInfo: {
          status: 2,
          seasons: [],
          requests: [
            {
              id: 43,
              status: 2,
              requestedBy: { displayName: "bob" },
              createdAt: "2026-01-02T00:00:00.000Z",
              seasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }],
            },
          ],
        },
      }),
    }));

    const { getDetails } = await import("@/lib/services/overseerr");
    const detail = await getDetails(1396, "tv");
    expect(detail.requests).toHaveLength(1);
    expect(detail.requests![0].requestedBy).toBe("bob");
    expect(detail.requests![0].seasonsRequested).toEqual([1, 2]);
  });
});

describe("search — issue #128: query URL encoding", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("percent-encodes spaces in the query as %20, not as raw spaces or +", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [], totalPages: 1 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { search } = await import("@/lib/services/overseerr");
    await search("Slow Horses");

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    // Must not contain a raw space or a + (URLSearchParams encodes spaces as +
    // which some servers do not decode as space).
    expect(calledUrl).not.toContain("Slow Horses");
    expect(calledUrl).not.toContain("Slow+Horses");
    expect(calledUrl).toContain("Slow%20Horses");
  });

  it("percent-encodes reserved characters in the query", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [], totalPages: 1 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { search } = await import("@/lib/services/overseerr");
    await search("Top Gun: Maverick");

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    // Colon must be percent-encoded
    expect(calledUrl).not.toContain("Top Gun: Maverick");
    expect(calledUrl).toContain("Top%20Gun%3A%20Maverick");
  });

  it("strips parentheses from query so Overseerr does not return HTTP 400", async () => {
    // Overseerr validates the decoded query value and rejects RFC 3986 reserved
    // characters such as '(' and ')' with HTTP 400. Queries like "Star Trek (2009)"
    // must have parentheses removed before being sent to the API.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [], totalPages: 1 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { search } = await import("@/lib/services/overseerr");
    await search("Star Trek (2009)");

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).not.toContain("(");
    expect(calledUrl).not.toContain(")");
    expect(calledUrl).toContain("Star%20Trek%202009");
  });
});

describe("search — issue #109: pagination and hasMore", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("passes page parameter to the Overseerr API", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [], totalPages: 3 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { search } = await import("@/lib/services/overseerr");
    await search("test", 2);

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("page=2");
  });

  it("returns hasMore=true when more pages exist", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ id: 1, mediaType: "movie", title: "Film", releaseDate: "2020-01-01", mediaInfo: { status: 5 } }], totalPages: 3 }),
    }));

    const { search } = await import("@/lib/services/overseerr");
    const { hasMore } = await search("test", 1);
    expect(hasMore).toBe(true);
  });

  it("returns hasMore=false on the last page", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [], totalPages: 1 }),
    }));

    const { search } = await import("@/lib/services/overseerr");
    const { hasMore } = await search("test", 1);
    expect(hasMore).toBe(false);
  });
});

describe("listRequests — issue #101: includes thumbPath, overseerrId, tmdbId and mediaStatus", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("includes thumbPath, overseerrId, and tmdbId from media object", async () => {
    const requestWithMedia = {
      id: 706,
      type: "movie",
      status: 2,
      media: { id: 1, mediaType: "movie", tmdbId: 550, title: "Fight Club", posterPath: "/poster.jpg" },
      requestedBy: { displayName: "alice" },
      createdAt: "2026-01-01T00:00:00.000Z",
      seasons: [],
    };

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [requestWithMedia] }),
    }));

    const { listRequests } = await import("@/lib/services/overseerr");
    const { results } = await listRequests();
    expect(results[0].thumbPath).toBe("https://image.tmdb.org/t/p/w300/poster.jpg");
    expect(results[0].tmdbId).toBe(550);
    expect(results[0].overseerrId).toBe(550);
  });

  it("thumbPath is undefined when media has no posterPath", async () => {
    const requestWithoutPoster = {
      id: 707,
      type: "movie",
      status: 2,
      media: { id: 1, mediaType: "movie", tmdbId: 551, title: "Some Movie" },
      requestedBy: { displayName: "charlie" },
      createdAt: "2026-01-03T00:00:00.000Z",
      seasons: [],
    };

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [requestWithoutPoster] }),
    }));

    const { listRequests } = await import("@/lib/services/overseerr");
    const { results } = await listRequests();
    expect(results[0].thumbPath).toBeUndefined();
    expect(results[0].tmdbId).toBe(551);
  });

  it("returns mediaStatus 'pending' for an approved request (status 2)", async () => {
    const approvedRequest = {
      id: 706,
      type: "movie",
      status: 2, // Approved
      media: { id: 1, mediaType: "movie", tmdbId: 550, title: "Fight Club" },
      requestedBy: { displayName: "alice" },
      createdAt: "2026-01-01T00:00:00.000Z",
      seasons: [],
    };

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [approvedRequest] }),
    }));

    const { listRequests } = await import("@/lib/services/overseerr");
    const { results } = await listRequests();
    expect(results[0].mediaStatus).toBe("pending");
  });

  it("returns mediaStatus 'pending' for a pending-approval request (status 1)", async () => {
    const pendingRequest = {
      id: 708,
      type: "tv",
      status: 1, // Pending Approval
      media: { id: 2, mediaType: "tv", tmdbId: 1396, title: "Breaking Bad" },
      requestedBy: { displayName: "bob" },
      createdAt: "2026-01-02T00:00:00.000Z",
      seasons: [{ seasonNumber: 1 }],
    };

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [pendingRequest] }),
    }));

    const { listRequests } = await import("@/lib/services/overseerr");
    const { results } = await listRequests();
    expect(results[0].mediaStatus).toBe("pending");
  });

  it("returns mediaStatus 'not_requested' for a declined request (status 3)", async () => {
    const declinedRequest = {
      id: 709,
      type: "movie",
      status: 3, // Declined
      media: { id: 3, mediaType: "movie", tmdbId: 680, title: "Pulp Fiction" },
      requestedBy: { displayName: "dave" },
      createdAt: "2026-01-03T00:00:00.000Z",
      seasons: [],
    };

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [declinedRequest] }),
    }));

    const { listRequests } = await import("@/lib/services/overseerr");
    const { results } = await listRequests();
    expect(results[0].mediaStatus).toBe("not_requested");
  });
});

describe("listRequests — issue #109: pagination and hasMore", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("uses skip=0 for page 1", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [], pageInfo: { results: 0 } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { listRequests } = await import("@/lib/services/overseerr");
    await listRequests(1);
    expect(fetchMock.mock.calls[0][0]).toContain("skip=0");
    expect(fetchMock.mock.calls[0][0]).toContain("take=50");
  });

  it("uses skip=50 for LLM page 6 (second API batch)", async () => {
    // Pages 1-5 use apiBatch=0 (skip=0); page 6 is the first page of apiBatch=1 (skip=50).
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [], pageInfo: { results: 0 } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { listRequests } = await import("@/lib/services/overseerr");
    await listRequests(6);
    expect(fetchMock.mock.calls[0][0]).toContain("skip=50");
  });

  it("LLM pages 1-5 all use skip=0 (same API batch)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [], pageInfo: { results: 0 } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { listRequests } = await import("@/lib/services/overseerr");
    await listRequests(5);
    expect(fetchMock.mock.calls[0][0]).toContain("skip=0");
  });

  it("returns hasMore=true when API batch has more than 10 items at current LLM offset", async () => {
    // 11 results returned → LLM page 1 shows 0-9, hasMore=true (item 10 exists)
    const makeRequest = (id: number) => ({
      id, type: "movie", status: 2,
      media: { tmdbId: id, title: `Film ${id}` },
      requestedBy: { displayName: "alice" },
      createdAt: "2026-01-01T00:00:00.000Z", seasons: [],
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: Array.from({ length: 11 }, (_, i) => makeRequest(i + 1)),
        pageInfo: { results: 11 },
      }),
    }));

    const { listRequests } = await import("@/lib/services/overseerr");
    const { results, hasMore } = await listRequests(1);
    expect(results).toHaveLength(10);
    expect(hasMore).toBe(true);
  });

  it("returns hasMore=false when exactly 10 results fit on first LLM page", async () => {
    const makeRequest = (id: number) => ({
      id, type: "movie", status: 2,
      media: { tmdbId: id, title: `Film ${id}` },
      requestedBy: { displayName: "alice" },
      createdAt: "2026-01-01T00:00:00.000Z", seasons: [],
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: Array.from({ length: 10 }, (_, i) => makeRequest(i + 1)),
        pageInfo: { results: 10 },
      }),
    }));

    const { listRequests } = await import("@/lib/services/overseerr");
    const { results, hasMore } = await listRequests(1);
    expect(results).toHaveLength(10);
    expect(hasMore).toBe(false);
  });
});

describe("listRequests — issue #89: titles should not return Unknown", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("uses title already in media object (Jellyseerr/enriched response) without extra fetch", async () => {
    const enrichedRequest = {
      ...MOVIE_REQUEST,
      media: { ...MOVIE_REQUEST.media, title: "Fight Club" },
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [enrichedRequest] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { listRequests } = await import("@/lib/services/overseerr");
    const { results } = await listRequests();
    expect(results[0].title).toBe("Fight Club");
    // Only one fetch (the /request call) — no extra TMDB lookup needed
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resolves movie title from /movie/{tmdbId} when media object lacks title", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockImplementation((url: string) => {
        if (url.includes("/request")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ results: [MOVIE_REQUEST] }),
          });
        }
        if (url.includes("/movie/550")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ title: "Fight Club", originalTitle: "Fight Club" }),
          });
        }
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }));

    const { listRequests } = await import("@/lib/services/overseerr");
    const { results } = await listRequests();
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Fight Club");
    expect(results[0].title).not.toBe("Unknown");
  });

  it("resolves TV show title from /tv/{tmdbId}", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockImplementation((url: string) => {
        if (url.includes("/request")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ results: [TV_REQUEST] }),
          });
        }
        if (url.includes("/tv/1396")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ name: "Breaking Bad", originalName: "Breaking Bad" }),
          });
        }
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }));

    const { listRequests } = await import("@/lib/services/overseerr");
    const { results } = await listRequests();
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Breaking Bad");
    expect(results[0].title).not.toBe("Unknown");
  });

  it("includes seasonsRequested for TV requests", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockImplementation((url: string) => {
        if (url.includes("/request")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ results: [TV_REQUEST] }),
          });
        }
        if (url.includes("/tv/")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ name: "Breaking Bad" }),
          });
        }
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }));

    const { listRequests } = await import("@/lib/services/overseerr");
    const { results } = await listRequests();
    expect(results[0].seasonsRequested).toEqual([1, 2]);
  });

  it("falls back to Unknown when title fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockImplementation((url: string) => {
        if (url.includes("/request")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ results: [MOVIE_REQUEST] }),
          });
        }
        // Simulate title fetch failure
        return Promise.reject(new Error("Network error"));
      }));

    const { listRequests } = await import("@/lib/services/overseerr");
    const { results } = await listRequests();
    expect(results).toHaveLength(1);
    // Falls back gracefully — media.title/name also absent so returns "Unknown"
    expect(results[0].title).toBeDefined();
  });
});

describe("getSeasonEpisodes — issue #272: episode air dates for pending shows", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns episode list with air dates and runtimes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        seasonNumber: 1,
        episodes: [
          { episodeNumber: 1, name: "Pilot", airDate: "2026-03-15", overview: "The beginning.", runtime: 60 },
          { episodeNumber: 2, name: "Episode Two", airDate: "2026-03-22", overview: "Things escalate.", runtime: 55 },
        ],
      }),
    }));

    const { getSeasonEpisodes } = await import("@/lib/services/overseerr");
    const result = await getSeasonEpisodes(252107, 1);
    expect(result.seasonNumber).toBe(1);
    expect(result.episodes).toHaveLength(2);
    expect(result.episodes[0]).toMatchObject({ episodeNumber: 1, name: "Pilot", airDate: "2026-03-15", runtime: 60 });
    expect(result.episodes[1]).toMatchObject({ episodeNumber: 2, name: "Episode Two", airDate: "2026-03-22" });
  });

  it("omits undefined fields (no airDate or runtime)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        seasonNumber: 1,
        episodes: [
          { episodeNumber: 1, name: "TBA", airDate: null, overview: null, runtime: 0 },
        ],
      }),
    }));

    const { getSeasonEpisodes } = await import("@/lib/services/overseerr");
    const result = await getSeasonEpisodes(252107, 1);
    expect(result.episodes[0].airDate).toBeUndefined();
    expect(result.episodes[0].runtime).toBeUndefined();
    expect(result.episodes[0].overview).toBeUndefined();
  });

  it("returns empty episodes array when API returns no episodes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ seasonNumber: 1 }),
    }));

    const { getSeasonEpisodes } = await import("@/lib/services/overseerr");
    const result = await getSeasonEpisodes(252107, 1);
    expect(result.episodes).toHaveLength(0);
  });

  it("calls the correct Overseerr endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ seasonNumber: 2, episodes: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getSeasonEpisodes } = await import("@/lib/services/overseerr");
    await getSeasonEpisodes(252107, 2);
    expect(fetchMock.mock.calls[0][0]).toContain("/tv/252107/season/2");
  });
});

describe("discover — issue #207", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  const TRENDING_MOVIES = [
    { id: 1, mediaType: "movie", title: "Film A", releaseDate: "2024-05-01", posterPath: "/a.jpg", overview: "A film.", voteAverage: 7.5, mediaInfo: { status: 5 } },
    { id: 2, mediaType: "movie", title: "Film B", releaseDate: "2024-06-01", posterPath: "/b.jpg", overview: "B film.", voteAverage: 6.0, mediaInfo: undefined },
  ];

  it("returns trending movies from /discover/movies", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: TRENDING_MOVIES, totalPages: 1 }),
    }));

    const { discover } = await import("@/lib/services/overseerr");
    const { results, hasMore } = await discover("movie");
    expect(results).toHaveLength(2);
    expect(results[0].title).toBe("Film A");
    expect(results[0].mediaStatus).toBe("Available");
    expect(results[1].mediaStatus).toBe("Not Requested");
    expect(hasMore).toBe(false);
  });

  it("includes genreIds param when genre resolves to a known ID", async () => {
    const fetchMock = vi.fn()
      // First call: genre list
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ([{ id: 28, name: "Action" }, { id: 35, name: "Comedy" }]),
      })
      // Second call: discover results
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ results: TRENDING_MOVIES, totalPages: 1 }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const { discover } = await import("@/lib/services/overseerr");
    await discover("movie", "Action");

    const discoverUrl = fetchMock.mock.calls[1][0] as string;
    expect(discoverUrl).toContain("genreIds=28");
  });

  it("skips genreIds when genre name not found in genre list", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ([{ id: 28, name: "Action" }]),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ results: TRENDING_MOVIES, totalPages: 1 }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const { discover } = await import("@/lib/services/overseerr");
    await discover("movie", "UnknownGenre");

    const discoverUrl = fetchMock.mock.calls[1][0] as string;
    expect(discoverUrl).not.toContain("genreIds");
  });

  it("uses /discover/movies/upcoming for upcoming category", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: TRENDING_MOVIES, totalPages: 1 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { discover } = await import("@/lib/services/overseerr");
    await discover("movie", undefined, "upcoming");

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/discover/movies/upcoming");
  });

  it("calls /genres/movie (not /discover/genres/movie) when resolving genre ID", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ([{ id: 28, name: "Action" }]),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ results: [], totalPages: 1 }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const { discover } = await import("@/lib/services/overseerr");
    await discover("movie", "Action");

    const genreUrl = fetchMock.mock.calls[0][0] as string;
    expect(genreUrl).toContain("/genres/movie");
    expect(genreUrl).not.toContain("/discover/genres");
  });

  it("calls /genres/tv (not /discover/genres/tv) when resolving genre ID for TV", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ([{ id: 10765, name: "Sci-Fi & Fantasy" }]),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ results: [], totalPages: 1 }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const { discover } = await import("@/lib/services/overseerr");
    await discover("tv", "Sci-Fi & Fantasy");

    const genreUrl = fetchMock.mock.calls[0][0] as string;
    expect(genreUrl).toContain("/genres/tv");
    expect(genreUrl).not.toContain("/discover/genres");
  });
});

describe("similar — returns titles like a given movie or TV show", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  const SIMILAR_RESULTS = [
    { id: 11, mediaType: "movie", title: "Similar Film A", releaseDate: "2023-01-01", posterPath: "/a.jpg", overview: "A similar film.", voteAverage: 7.0, mediaInfo: { status: 5 } },
    { id: 12, mediaType: "movie", title: "Similar Film B", releaseDate: "2023-06-01", posterPath: "/b.jpg", overview: "Another similar film.", voteAverage: 6.5 },
  ];

  it("calls /movie/{id}/similar for movies", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: SIMILAR_RESULTS, totalPages: 1 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { similar } = await import("@/lib/services/overseerr");
    const { results, hasMore } = await similar(550, "movie");

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/movie/550/similar");
    expect(results).toHaveLength(2);
    expect(results[0].title).toBe("Similar Film A");
    expect(results[0].mediaStatus).toBe("Available");
    expect(results[1].mediaStatus).toBe("Not Requested");
    expect(hasMore).toBe(false);
  });

  it("calls /tv/{id}/similar for TV shows", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: [], totalPages: 1 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { similar } = await import("@/lib/services/overseerr");
    await similar(1396, "tv");

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/tv/1396/similar");
  });

  it("passes page param to the API", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: [], totalPages: 3 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { similar } = await import("@/lib/services/overseerr");
    await similar(550, "movie", 2);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("page=2");
  });

  it("returns hasMore=true when more pages exist", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: SIMILAR_RESULTS, totalPages: 3 }),
    }));

    const { similar } = await import("@/lib/services/overseerr");
    const { hasMore } = await similar(550, "movie", 1);
    expect(hasMore).toBe(true);
  });

  it("includes thumbPath and rating from similar results", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: [SIMILAR_RESULTS[0]], totalPages: 1 }),
    }));

    const { similar } = await import("@/lib/services/overseerr");
    const { results } = await similar(550, "movie");
    expect(results[0].thumbPath).toBe("https://image.tmdb.org/t/p/w300/a.jpg");
    expect(results[0].rating).toBe(7.0);
  });
});

describe("createIssue — reports a playback issue to Seerr", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("POSTs to /issue with issueType, message, and mediaId", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: 42, issueType: 1, message: "Video stutters at 30 min" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { createIssue, IssueType } = await import("@/lib/services/overseerr");
    const result = await createIssue(99, IssueType.Video, "Video stutters at 30 min");

    expect(result.success).toBe(true);
    expect(result.issueId).toBe(42);

    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/issue");
    expect((opts as RequestInit).method).toBe("POST");
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body.mediaId).toBe(99);
    expect(body.issueType).toBe(1);
    expect(body.message).toBe("Video stutters at 30 min");
  });

  it("returns success=false with error message when API throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ message: "Forbidden" }),
    }));

    const { createIssue, IssueType } = await import("@/lib/services/overseerr");
    const result = await createIssue(99, IssueType.Audio, "Audio issue");

    expect(result.success).toBe(false);
    expect(result.message).toContain("403");
  });
});

describe("getDetails — exposes seerrMediaId from mediaInfo", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns seerrMediaId from mediaInfo.id for movies", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        title: "Inception",
        releaseDate: "2010-07-16",
        runtime: 148,
        credits: { cast: [] },
        genres: [],
        externalIds: {},
        mediaInfo: { id: 77, status: 5, requests: [], seasons: [] },
      }),
    }));

    const { getDetails } = await import("@/lib/services/overseerr");
    const detail = await getDetails(27205, "movie");
    expect(detail.seerrMediaId).toBe(77);
  });

  it("returns seerrMediaId undefined when mediaInfo is absent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        title: "Unknown Film",
        releaseDate: "2020-01-01",
        credits: { cast: [] },
        genres: [],
        externalIds: {},
        mediaInfo: undefined,
      }),
    }));

    const { getDetails } = await import("@/lib/services/overseerr");
    const detail = await getDetails(999, "movie");
    expect(detail.seerrMediaId).toBeUndefined();
  });
});

describe("normalizeMediaStatus — issues #281 #282: title-cased Overseerr values must map to display_titles enum", () => {
  it("normalizes 'Processing' to 'pending'", async () => {
    const { normalizeMediaStatus } = await import("@/lib/services/overseerr");
    expect(normalizeMediaStatus("Processing")).toBe("pending");
  });

  it("normalizes 'Pending' to 'pending'", async () => {
    const { normalizeMediaStatus } = await import("@/lib/services/overseerr");
    expect(normalizeMediaStatus("Pending")).toBe("pending");
  });

  it("normalizes 'Available' to 'available'", async () => {
    const { normalizeMediaStatus } = await import("@/lib/services/overseerr");
    expect(normalizeMediaStatus("Available")).toBe("available");
  });

  it("normalizes 'Partially Available' to 'partial'", async () => {
    const { normalizeMediaStatus } = await import("@/lib/services/overseerr");
    expect(normalizeMediaStatus("Partially Available")).toBe("partial");
  });

  it("normalizes 'Not Requested' to 'not_requested'", async () => {
    const { normalizeMediaStatus } = await import("@/lib/services/overseerr");
    expect(normalizeMediaStatus("Not Requested")).toBe("not_requested");
  });

  it("normalizes unknown values to 'not_requested'", async () => {
    const { normalizeMediaStatus } = await import("@/lib/services/overseerr");
    expect(normalizeMediaStatus("SomeUnknownStatus")).toBe("not_requested");
  });
});

describe("getSeasonEpisodes — issue #291: includes thumbPath from stillPath", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("maps stillPath to a full TMDB thumbPath URL for each episode", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        episodes: [
          {
            episodeNumber: 1,
            name: "Pilot",
            airDate: "2008-01-20",
            overview: "A chemistry teacher is diagnosed with cancer.",
            runtime: 58,
            stillPath: "/still1.jpg",
          },
          {
            episodeNumber: 2,
            name: "Cat's in the Bag",
            airDate: "2008-01-27",
            overview: null,
            runtime: 48,
            stillPath: null,
          },
        ],
      }),
    }));

    const { getSeasonEpisodes } = await import("@/lib/services/overseerr");
    const result = await getSeasonEpisodes(1396, 1);
    expect(result.seasonNumber).toBe(1);
    expect(result.episodes).toHaveLength(2);

    // Episode with stillPath → full TMDB URL
    expect(result.episodes[0].thumbPath).toBe("https://image.tmdb.org/t/p/w300/still1.jpg");
    expect(result.episodes[0].episodeNumber).toBe(1);
    expect(result.episodes[0].name).toBe("Pilot");
    expect(result.episodes[0].airDate).toBe("2008-01-20");
    expect(result.episodes[0].runtime).toBe(58);

    // Episode without stillPath → thumbPath is undefined
    expect(result.episodes[1].thumbPath).toBeUndefined();
  });

  it("returns thumbPath as undefined when stillPath is missing from episode data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        episodes: [
          { episodeNumber: 1, name: "Episode 1", airDate: "2024-01-01" },
        ],
      }),
    }));

    const { getSeasonEpisodes } = await import("@/lib/services/overseerr");
    const result = await getSeasonEpisodes(999, 2);
    expect(result.episodes[0].thumbPath).toBeUndefined();
  });
});

describe("getSeerrUserId — resolves Plex username to Seerr user ID", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns the Seerr user ID for a matching plexUsername", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          { id: 42, plexUsername: "alice" },
          { id: 7, plexUsername: "bob" },
        ],
      }),
    }));

    const { getSeerrUserId } = await import("@/lib/services/overseerr");
    const id = await getSeerrUserId("alice");
    expect(id).toBe(42);
  });

  it("is case-insensitive when matching plexUsername", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: [{ id: 99, plexUsername: "Alice" }] }),
    }));

    const { getSeerrUserId } = await import("@/lib/services/overseerr");
    const id = await getSeerrUserId("alice");
    expect(id).toBe(99);
  });

  it("returns null when plexUsername not found in Seerr user list", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: [{ id: 1, plexUsername: "other" }] }),
    }));

    const { getSeerrUserId } = await import("@/lib/services/overseerr");
    const id = await getSeerrUserId("unknown");
    expect(id).toBeNull();
  });

  it("returns null when the /user API call fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ message: "Internal server error" }),
    }));

    const { getSeerrUserId } = await import("@/lib/services/overseerr");
    const id = await getSeerrUserId("alice");
    expect(id).toBeNull();
  });
});

describe("listRequests — seerrUserId filter (issue #380)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  const makeRequest = (id: number, title: string) => ({
    id,
    type: "movie",
    status: 2,
    media: { id: id * 10, mediaType: "movie", tmdbId: id * 100, title },
    requestedBy: { displayName: "alice" },
    createdAt: "2026-01-01T00:00:00.000Z",
    seasons: [],
  });

  it("appends requestedBy param when seerrUserId is provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: [makeRequest(1, "Film A")], pageInfo: { results: 1 } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { listRequests } = await import("@/lib/services/overseerr");
    await listRequests(1, 42);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("requestedBy=42");
  });

  it("omits requestedBy param when seerrUserId is undefined (admin)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: [], pageInfo: { results: 0 } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { listRequests } = await import("@/lib/services/overseerr");
    await listRequests(1, undefined);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).not.toContain("requestedBy");
  });
});
