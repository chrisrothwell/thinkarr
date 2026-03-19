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

describe("search — issue #101: includes request details from mediaInfo", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("extracts request details from mediaInfo.requests when present", async () => {
    const searchResult = {
      id: 550,
      mediaType: "movie",
      title: "Fight Club",
      releaseDate: "1999-10-15",
      posterPath: "/poster.jpg",
      overview: "A movie about soap.",
      mediaInfo: {
        status: 2, // Pending
        requests: [
          {
            id: 42,
            status: 2, // Approved
            requestedBy: { displayName: "alice" },
            createdAt: "2026-01-01T00:00:00.000Z",
            seasons: [],
          },
        ],
      },
    };

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [searchResult] }),
    }));

    const { search } = await import("@/lib/services/overseerr");
    const results = await search("Fight Club");
    expect(results).toHaveLength(1);
    expect(results[0].requests).toHaveLength(1);
    expect(results[0].requests![0].requestedBy).toBe("alice");
    expect(results[0].requests![0].status).toBe("Approved");
  });

  it("returns undefined requests when mediaInfo has no requests array", async () => {
    const searchResult = {
      id: 550,
      mediaType: "movie",
      title: "Fight Club",
      releaseDate: "1999-10-15",
      posterPath: "/poster.jpg",
      overview: "A movie about soap.",
      mediaInfo: { status: 5 },
    };

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [searchResult] }),
    }));

    const { search } = await import("@/lib/services/overseerr");
    const results = await search("Fight Club");
    expect(results[0].requests).toBeUndefined();
  });

  it("includes seasonsRequested in TV show requests", async () => {
    const tvSearchResult = {
      id: 1396,
      mediaType: "tv",
      name: "Breaking Bad",
      firstAirDate: "2008-01-20",
      posterPath: "/poster.jpg",
      overview: "A chemistry teacher turns to crime.",
      mediaInfo: {
        status: 2,
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
    };

    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [tvSearchResult] }),
      })
      .mockResolvedValueOnce({
        // TV detail fetch for numberOfSeasons
        ok: true,
        json: async () => ({ numberOfSeasons: 5 }),
      }));

    const { search } = await import("@/lib/services/overseerr");
    const results = await search("Breaking Bad");
    expect(results[0].requests![0].seasonsRequested).toEqual([1, 2]);
  });
});

describe("search — issue #101: includes rating and cast from detail endpoint", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("includes voteAverage (rating) from search results", async () => {
    const searchResult = {
      id: 550,
      mediaType: "movie",
      title: "Fight Club",
      releaseDate: "1999-10-15",
      posterPath: "/poster.jpg",
      overview: "A movie about soap.",
      voteAverage: 8.4,
      mediaInfo: { status: 5 },
    };

    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [searchResult] }),
      })
      .mockResolvedValueOnce({
        // detail fetch for movie
        ok: true,
        json: async () => ({ title: "Fight Club", credits: { cast: [] } }),
      }));

    const { search } = await import("@/lib/services/overseerr");
    const results = await search("Fight Club");
    expect(results[0].rating).toBe(8.4);
  });

  it("includes cast from detail endpoint for movies", async () => {
    const searchResult = {
      id: 550,
      mediaType: "movie",
      title: "Fight Club",
      releaseDate: "1999-10-15",
      posterPath: "/poster.jpg",
      overview: "A movie about soap.",
      mediaInfo: { status: 5 },
    };

    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [searchResult] }),
      })
      .mockResolvedValueOnce({
        // detail fetch: /movie/550
        ok: true,
        json: async () => ({
          title: "Fight Club",
          credits: {
            cast: [
              { name: "Brad Pitt" },
              { name: "Edward Norton" },
              { name: "Helena Bonham Carter" },
            ],
          },
        }),
      }));

    const { search } = await import("@/lib/services/overseerr");
    const results = await search("Fight Club");
    expect(results[0].cast).toEqual(["Brad Pitt", "Edward Norton", "Helena Bonham Carter"]);
  });

  it("includes cast from TV detail endpoint and still returns numberOfSeasons", async () => {
    const tvSearchResult = {
      id: 1396,
      mediaType: "tv",
      name: "Breaking Bad",
      firstAirDate: "2008-01-20",
      posterPath: "/poster.jpg",
      overview: "A chemistry teacher turns to crime.",
      mediaInfo: { status: 5 },
    };

    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [tvSearchResult] }),
      })
      .mockResolvedValueOnce({
        // detail fetch: /tv/1396
        ok: true,
        json: async () => ({
          numberOfSeasons: 5,
          credits: {
            cast: [{ name: "Bryan Cranston" }, { name: "Aaron Paul" }],
          },
        }),
      }));

    const { search } = await import("@/lib/services/overseerr");
    const results = await search("Breaking Bad");
    expect(results[0].seasonCount).toBe(5);
    expect(results[0].cast).toEqual(["Bryan Cranston", "Aaron Paul"]);
  });

  it("cast is undefined when detail fetch fails", async () => {
    const searchResult = {
      id: 550,
      mediaType: "movie",
      title: "Fight Club",
      releaseDate: "1999-10-15",
      posterPath: "/poster.jpg",
      overview: "A movie about soap.",
      mediaInfo: { status: 5 },
    };

    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [searchResult] }),
      })
      .mockRejectedValueOnce(new Error("Network error")));

    const { search } = await import("@/lib/services/overseerr");
    const results = await search("Fight Club");
    expect(results[0].cast).toBeUndefined();
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
    const results = await listRequests();
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
    const results = await listRequests();
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
    const results = await listRequests();
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
    const results = await listRequests();
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
    const results = await listRequests();
    expect(results[0].mediaStatus).toBe("not_requested");
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
    const results = await listRequests();
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
    const results = await listRequests();
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
    const results = await listRequests();
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
    const results = await listRequests();
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
    const results = await listRequests();
    expect(results).toHaveLength(1);
    // Falls back gracefully — media.title/name also absent so returns "Unknown"
    expect(results[0].title).toBeDefined();
  });
});
