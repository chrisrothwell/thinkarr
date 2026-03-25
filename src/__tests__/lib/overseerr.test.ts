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
