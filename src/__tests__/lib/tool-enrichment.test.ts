/**
 * Unit tests for the enrichment logic added in issue #253:
 *  - overseerr_search / overseerr_discover auto-call getDetails for each result
 *  - overseerr_list_requests enriches with getDetails for thumbPath and seasons (#258)
 *  - sonarr_search_series enriches with Plex (primary) then Overseerr (fallback)
 *  - radarr_search_movie enriches with Plex (primary) then Overseerr via tmdbId (fallback)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Shared service mocks
// ---------------------------------------------------------------------------
const mockOverseerrSearch = vi.fn();
const mockOverseerrGetDetails = vi.fn();
const mockOverseerrDiscover = vi.fn();
const mockOverseerrListRequests = vi.fn();
vi.mock("@/lib/services/overseerr", () => ({
  search: (...a: unknown[]) => mockOverseerrSearch(...a),
  getDetails: (...a: unknown[]) => mockOverseerrGetDetails(...a),
  discover: (...a: unknown[]) => mockOverseerrDiscover(...a),
  listRequests: (...a: unknown[]) => mockOverseerrListRequests(...a),
  normalizeMediaStatus: vi.fn((s: string) => {
    switch (s) {
      case "Available": return "available";
      case "Partially Available": return "partial";
      case "Pending":
      case "Processing": return "pending";
      default: return "not_requested";
    }
  }),
}));

const mockPlexSearchLibrary = vi.fn();
const mockPlexBuildThumbUrl = vi.fn((p: string) => `/api/plex/thumb?path=${encodeURIComponent(p)}`);
vi.mock("@/lib/services/plex", () => ({
  searchLibrary: (...a: unknown[]) => mockPlexSearchLibrary(...a),
  buildThumbUrl: (p: string) => mockPlexBuildThumbUrl(p),
  getPlexMachineId: vi.fn(),
}));

const mockSonarrSearchSeries = vi.fn();
vi.mock("@/lib/services/sonarr", () => ({
  searchSeries: (...a: unknown[]) => mockSonarrSearchSeries(...a),
  getSeriesStatus: vi.fn(),
  getCalendar: vi.fn(),
  getQueue: vi.fn(),
}));

const mockRadarrSearchMovie = vi.fn();
vi.mock("@/lib/services/radarr", () => ({
  searchMovie: (...a: unknown[]) => mockRadarrSearchMovie(...a),
  getMovieStatus: vi.fn(),
  getQueue: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/config", () => ({ getConfig: vi.fn(() => "http://example.com") }));

// ---------------------------------------------------------------------------
// Default mock responses
// ---------------------------------------------------------------------------
const BASE_SEARCH_RESULT = {
  overseerrId: 550,
  overseerrMediaType: "movie",
  title: "Fight Club",
  year: 1999,
  summary: "A soap salesman.",
  rating: 8.4,
  mediaStatus: "Available",
  thumbPath: "https://image.tmdb.org/t/p/w300/poster.jpg",
  seasonCount: undefined,
};

const BASE_DETAIL = {
  overseerrId: 550,
  overseerrMediaType: "movie",
  title: "Fight Club",
  year: 1999,
  imdbId: "tt0137523",
  thumbPath: "https://image.tmdb.org/t/p/w300/poster.jpg",
  cast: ["Brad Pitt", "Edward Norton"],
  genres: ["Drama"],
  runtime: 139,
};

const TV_SEARCH_RESULT = {
  overseerrId: 1396,
  overseerrMediaType: "tv",
  title: "Breaking Bad",
  year: 2008,
  mediaStatus: "Available",
  thumbPath: "https://image.tmdb.org/t/p/w300/bb.jpg",
  seasonCount: 5,
};

const TV_DETAIL = {
  overseerrId: 1396,
  overseerrMediaType: "tv",
  title: "Breaking Bad",
  year: 2008,
  imdbId: "tt0903747",
  thumbPath: "https://image.tmdb.org/t/p/w300/bb.jpg",
  cast: ["Bryan Cranston", "Aaron Paul"],
  seasonCount: 5,
  seasons: [
    { seasonNumber: 1, status: "Available" },
    { seasonNumber: 2, status: "Available" },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockOverseerrSearch.mockResolvedValue({ results: [BASE_SEARCH_RESULT], hasMore: false });
  mockOverseerrGetDetails.mockResolvedValue(BASE_DETAIL);
  mockOverseerrDiscover.mockResolvedValue({ results: [BASE_SEARCH_RESULT], hasMore: false });
  mockOverseerrListRequests.mockResolvedValue({ results: [], hasMore: false });
  mockPlexSearchLibrary.mockResolvedValue({ results: [], hasMore: false });
  mockSonarrSearchSeries.mockResolvedValue([]);
  mockRadarrSearchMovie.mockResolvedValue([]);
});

// ===========================================================================
// overseerr_search enrichment
// ===========================================================================
describe("overseerr_search — enrichment (#253)", () => {
  it("calls getDetails for each search result and merges cast and imdbId", async () => {
    const { registerOverseerrTools } = await import("@/lib/tools/overseerr-tools");
    const { defineTool, executeTool } = await import("@/lib/tools/registry");
    // Ensure a fresh registry
    (defineTool as unknown as { _registry?: Map<string, unknown> })._registry?.clear?.();
    registerOverseerrTools();

    const raw = await executeTool("overseerr_search", JSON.stringify({ query: "Fight Club" }));
    const { results } = JSON.parse(raw) as { results: Record<string, unknown>[] };

    expect(mockOverseerrGetDetails).toHaveBeenCalledWith(550, "movie");
    expect(results[0].cast).toEqual(["Brad Pitt", "Edward Norton"]);
    expect(results[0].imdbId).toBe("tt0137523");
  });

  it("merges accurate seasonCount and seasons for TV results", async () => {
    mockOverseerrSearch.mockResolvedValueOnce({ results: [TV_SEARCH_RESULT], hasMore: false });
    mockOverseerrGetDetails.mockResolvedValueOnce(TV_DETAIL);

    const { registerOverseerrTools } = await import("@/lib/tools/overseerr-tools");
    const { defineTool, executeTool } = await import("@/lib/tools/registry");
    (defineTool as unknown as { _registry?: Map<string, unknown> })._registry?.clear?.();
    registerOverseerrTools();

    const raw = await executeTool("overseerr_search", JSON.stringify({ query: "Breaking Bad" }));
    const { results } = JSON.parse(raw) as { results: Record<string, unknown>[] };

    expect(mockOverseerrGetDetails).toHaveBeenCalledWith(1396, "tv");
    expect(results[0].seasonCount).toBe(5);
    expect((results[0].seasons as unknown[]).length).toBe(2);
  });

  it("returns base result without enrichment if getDetails throws", async () => {
    mockOverseerrGetDetails.mockRejectedValueOnce(new Error("Overseerr down"));

    const { registerOverseerrTools } = await import("@/lib/tools/overseerr-tools");
    const { defineTool, executeTool } = await import("@/lib/tools/registry");
    (defineTool as unknown as { _registry?: Map<string, unknown> })._registry?.clear?.();
    registerOverseerrTools();

    const raw = await executeTool("overseerr_search", JSON.stringify({ query: "Fight Club" }));
    const { results } = JSON.parse(raw) as { results: Record<string, unknown>[] };

    // Base result still returned
    expect(results[0].title).toBe("Fight Club");
    expect(results[0].cast).toBeUndefined();
  });
});

// ===========================================================================
// sonarr_search_series enrichment
// ===========================================================================
describe("sonarr_search_series — Plex-first enrichment (#253)", () => {
  const SONARR_SERIES = { id: 10, title: "Breaking Bad", year: 2008, seasonCount: 5, monitored: true, tvdbId: 81189 };

  it("uses Plex data when the show is found in Plex", async () => {
    const PLEX_RESULT = {
      title: "Breaking Bad", year: 2008, mediaType: "tv",
      plexKey: "/library/metadata/77", thumbPath: "/library/metadata/77/thumb",
      cast: ["Bryan Cranston"],
    };
    mockSonarrSearchSeries.mockResolvedValueOnce([SONARR_SERIES]);
    mockPlexSearchLibrary.mockResolvedValueOnce({ results: [PLEX_RESULT], hasMore: false });

    const { registerSonarrTools } = await import("@/lib/tools/sonarr-tools");
    const { defineTool, executeTool } = await import("@/lib/tools/registry");
    (defineTool as unknown as { _registry?: Map<string, unknown> })._registry?.clear?.();
    registerSonarrTools();

    const raw = await executeTool("sonarr_search_series", JSON.stringify({ term: "Breaking Bad" }));
    const results = JSON.parse(raw) as Record<string, unknown>[];

    expect(results[0].plexKey).toBe("/library/metadata/77");
    expect(results[0].cast).toEqual(["Bryan Cranston"]);
    // Overseerr should NOT be called when Plex matched
    expect(mockOverseerrSearch).not.toHaveBeenCalled();
    expect(mockOverseerrGetDetails).not.toHaveBeenCalled();
  });

  it("falls back to Overseerr when not found in Plex", async () => {
    mockSonarrSearchSeries.mockResolvedValueOnce([SONARR_SERIES]);
    mockPlexSearchLibrary.mockResolvedValueOnce({ results: [], hasMore: false });
    mockOverseerrSearch.mockResolvedValueOnce({ results: [TV_SEARCH_RESULT], hasMore: false });
    mockOverseerrGetDetails.mockResolvedValueOnce(TV_DETAIL);

    const { registerSonarrTools } = await import("@/lib/tools/sonarr-tools");
    const { defineTool, executeTool } = await import("@/lib/tools/registry");
    (defineTool as unknown as { _registry?: Map<string, unknown> })._registry?.clear?.();
    registerSonarrTools();

    const raw = await executeTool("sonarr_search_series", JSON.stringify({ term: "Breaking Bad" }));
    const results = JSON.parse(raw) as Record<string, unknown>[];

    expect(results[0].overseerrId).toBe(1396);
    expect(results[0].cast).toEqual(["Bryan Cranston", "Aaron Paul"]);
    expect(results[0].imdbId).toBe("tt0903747");
  });

  it("returns unmodified result if both Plex and Overseerr are unavailable", async () => {
    mockSonarrSearchSeries.mockResolvedValueOnce([SONARR_SERIES]);
    mockPlexSearchLibrary.mockRejectedValueOnce(new Error("Plex not configured"));
    mockOverseerrSearch.mockRejectedValueOnce(new Error("Overseerr not configured"));

    const { registerSonarrTools } = await import("@/lib/tools/sonarr-tools");
    const { defineTool, executeTool } = await import("@/lib/tools/registry");
    (defineTool as unknown as { _registry?: Map<string, unknown> })._registry?.clear?.();
    registerSonarrTools();

    const raw = await executeTool("sonarr_search_series", JSON.stringify({ term: "Breaking Bad" }));
    const results = JSON.parse(raw) as Record<string, unknown>[];

    expect(results[0].title).toBe("Breaking Bad");
    expect(results[0].thumbPath).toBeUndefined();
  });
});

// ===========================================================================
// radarr_search_movie enrichment
// ===========================================================================
describe("radarr_search_movie — Plex-first enrichment (#253)", () => {
  const RADARR_MOVIE = { id: 20, title: "Fight Club", year: 1999, hasFile: false, monitored: true, tmdbId: 550 };

  it("uses Plex data when the movie is found in Plex", async () => {
    const PLEX_RESULT = {
      title: "Fight Club", year: 1999, mediaType: "movie",
      plexKey: "/library/metadata/42", thumbPath: "/library/metadata/42/thumb",
      cast: ["Brad Pitt"],
    };
    mockRadarrSearchMovie.mockResolvedValueOnce([RADARR_MOVIE]);
    mockPlexSearchLibrary.mockResolvedValueOnce({ results: [PLEX_RESULT], hasMore: false });

    const { registerRadarrTools } = await import("@/lib/tools/radarr-tools");
    const { defineTool, executeTool } = await import("@/lib/tools/registry");
    (defineTool as unknown as { _registry?: Map<string, unknown> })._registry?.clear?.();
    registerRadarrTools();

    const raw = await executeTool("radarr_search_movie", JSON.stringify({ term: "Fight Club" }));
    const results = JSON.parse(raw) as Record<string, unknown>[];

    expect(results[0].plexKey).toBe("/library/metadata/42");
    expect(results[0].cast).toEqual(["Brad Pitt"]);
    expect(mockOverseerrGetDetails).not.toHaveBeenCalled();
  });

  it("uses Overseerr getDetails via tmdbId when not in Plex", async () => {
    mockRadarrSearchMovie.mockResolvedValueOnce([RADARR_MOVIE]);
    mockPlexSearchLibrary.mockResolvedValueOnce({ results: [], hasMore: false });
    mockOverseerrGetDetails.mockResolvedValueOnce(BASE_DETAIL);

    const { registerRadarrTools } = await import("@/lib/tools/radarr-tools");
    const { defineTool, executeTool } = await import("@/lib/tools/registry");
    (defineTool as unknown as { _registry?: Map<string, unknown> })._registry?.clear?.();
    registerRadarrTools();

    const raw = await executeTool("radarr_search_movie", JSON.stringify({ term: "Fight Club" }));
    const results = JSON.parse(raw) as Record<string, unknown>[];

    // Should call getDetails with tmdbId directly (not via search)
    expect(mockOverseerrGetDetails).toHaveBeenCalledWith(550, "movie");
    expect(mockOverseerrSearch).not.toHaveBeenCalled();
    expect(results[0].overseerrId).toBe(550);
    expect(results[0].cast).toEqual(["Brad Pitt", "Edward Norton"]);
    expect(results[0].imdbId).toBe("tt0137523");
  });

  it("falls back to Overseerr title search when tmdbId is absent", async () => {
    const movieNoTmdb = { ...RADARR_MOVIE, tmdbId: undefined };
    mockRadarrSearchMovie.mockResolvedValueOnce([movieNoTmdb]);
    mockPlexSearchLibrary.mockResolvedValueOnce({ results: [], hasMore: false });
    mockOverseerrSearch.mockResolvedValueOnce({ results: [BASE_SEARCH_RESULT], hasMore: false });
    mockOverseerrGetDetails.mockResolvedValueOnce(BASE_DETAIL);

    const { registerRadarrTools } = await import("@/lib/tools/radarr-tools");
    const { defineTool, executeTool } = await import("@/lib/tools/registry");
    (defineTool as unknown as { _registry?: Map<string, unknown> })._registry?.clear?.();
    registerRadarrTools();

    const raw = await executeTool("radarr_search_movie", JSON.stringify({ term: "Fight Club" }));
    const results = JSON.parse(raw) as Record<string, unknown>[];

    expect(mockOverseerrSearch).toHaveBeenCalled();
    expect(results[0].overseerrId).toBe(550);
    expect(results[0].imdbId).toBe("tt0137523");
  });
});

// ===========================================================================
// overseerr_list_requests enrichment (#258)
// ===========================================================================
describe("overseerr_list_requests — enrichment with getDetails (#258)", () => {
  const MOVIE_REQUEST = {
    id: 706,
    mediaType: "movie",
    title: "Fight Club",
    year: 1999,
    status: "Approved",
    mediaStatus: "pending",
    requestedBy: "alice",
    requestedAt: "2026-01-01T00:00:00.000Z",
    overseerrId: 550,
    tmdbId: 550,
  };

  const TV_REQUEST = {
    id: 707,
    mediaType: "tv",
    title: "Breaking Bad",
    year: 2008,
    status: "Approved",
    mediaStatus: "pending",
    requestedBy: "bob",
    requestedAt: "2026-01-02T00:00:00.000Z",
    overseerrId: 1396,
    tmdbId: 1396,
    seasonsRequested: [1],
  };

  it("calls getDetails for each request result and merges thumbPath", async () => {
    mockOverseerrListRequests.mockResolvedValueOnce({ results: [MOVIE_REQUEST], hasMore: false });
    mockOverseerrGetDetails.mockResolvedValueOnce(BASE_DETAIL);

    const { registerOverseerrTools } = await import("@/lib/tools/overseerr-tools");
    const { defineTool, executeTool } = await import("@/lib/tools/registry");
    (defineTool as unknown as { _registry?: Map<string, unknown> })._registry?.clear?.();
    registerOverseerrTools();

    const raw = await executeTool("overseerr_list_requests", JSON.stringify({}));
    const { results } = JSON.parse(raw) as { results: Record<string, unknown>[] };

    expect(mockOverseerrGetDetails).toHaveBeenCalledWith(550, "movie");
    expect(results[0].thumbPath).toBe("https://image.tmdb.org/t/p/w300/poster.jpg");
  });

  it("merges seasons and seasonCount for TV request results", async () => {
    mockOverseerrListRequests.mockResolvedValueOnce({ results: [TV_REQUEST], hasMore: false });
    mockOverseerrGetDetails.mockResolvedValueOnce(TV_DETAIL);

    const { registerOverseerrTools } = await import("@/lib/tools/overseerr-tools");
    const { defineTool, executeTool } = await import("@/lib/tools/registry");
    (defineTool as unknown as { _registry?: Map<string, unknown> })._registry?.clear?.();
    registerOverseerrTools();

    const raw = await executeTool("overseerr_list_requests", JSON.stringify({}));
    const { results } = JSON.parse(raw) as { results: Record<string, unknown>[] };

    expect(mockOverseerrGetDetails).toHaveBeenCalledWith(1396, "tv");
    expect(results[0].seasonCount).toBe(5);
    expect((results[0].seasons as unknown[]).length).toBe(2);
  });

  it("skips enrichment for requests with no overseerrId", async () => {
    const requestNoId = { ...MOVIE_REQUEST, overseerrId: undefined };
    mockOverseerrListRequests.mockResolvedValueOnce({ results: [requestNoId], hasMore: false });

    const { registerOverseerrTools } = await import("@/lib/tools/overseerr-tools");
    const { defineTool, executeTool } = await import("@/lib/tools/registry");
    (defineTool as unknown as { _registry?: Map<string, unknown> })._registry?.clear?.();
    registerOverseerrTools();

    await executeTool("overseerr_list_requests", JSON.stringify({}));
    expect(mockOverseerrGetDetails).not.toHaveBeenCalled();
  });

  it("returns base result without enrichment if getDetails throws", async () => {
    mockOverseerrListRequests.mockResolvedValueOnce({ results: [MOVIE_REQUEST], hasMore: false });
    mockOverseerrGetDetails.mockRejectedValueOnce(new Error("Overseerr down"));

    const { registerOverseerrTools } = await import("@/lib/tools/overseerr-tools");
    const { defineTool, executeTool } = await import("@/lib/tools/registry");
    (defineTool as unknown as { _registry?: Map<string, unknown> })._registry?.clear?.();
    registerOverseerrTools();

    const raw = await executeTool("overseerr_list_requests", JSON.stringify({}));
    const { results } = JSON.parse(raw) as { results: Record<string, unknown>[] };

    expect(results[0].title).toBe("Fight Club");
    expect(results[0].thumbPath).toBeUndefined();
  });
});

// ===========================================================================
// overseerr_search mediaStatus normalization (issues #281, #282)
// ===========================================================================
describe("overseerr_search — mediaStatus normalization (#281 #282)", () => {
  it("normalizes 'Processing' from Overseerr to 'pending' before returning to LLM", async () => {
    // Simulate Overseerr returning "Processing" (title-cased) — display_titles rejects this.
    // The tool must normalize it to "pending" so the LLM can pass it directly to display_titles.
    mockOverseerrSearch.mockResolvedValueOnce({
      results: [{ ...BASE_SEARCH_RESULT, mediaStatus: "Processing" }],
      hasMore: false,
    });

    const { registerOverseerrTools } = await import("@/lib/tools/overseerr-tools");
    const { defineTool, executeTool } = await import("@/lib/tools/registry");
    (defineTool as unknown as { _registry?: Map<string, unknown> })._registry?.clear?.();
    registerOverseerrTools();

    const raw = await executeTool("overseerr_search", JSON.stringify({ query: "Star City" }));
    const { results } = JSON.parse(raw) as { results: Record<string, unknown>[] };
    expect(results[0].mediaStatus).toBe("pending");
  });

  it("normalizes 'Not Requested' to 'not_requested'", async () => {
    mockOverseerrSearch.mockResolvedValueOnce({
      results: [{ ...BASE_SEARCH_RESULT, mediaStatus: "Not Requested" }],
      hasMore: false,
    });

    const { registerOverseerrTools } = await import("@/lib/tools/overseerr-tools");
    const { defineTool, executeTool } = await import("@/lib/tools/registry");
    (defineTool as unknown as { _registry?: Map<string, unknown> })._registry?.clear?.();
    registerOverseerrTools();

    const raw = await executeTool("overseerr_search", JSON.stringify({ query: "Some Movie" }));
    const { results } = JSON.parse(raw) as { results: Record<string, unknown>[] };
    expect(results[0].mediaStatus).toBe("not_requested");
  });
});

// ===========================================================================
// sonarr_search_series pre-computed mediaStatus (issue #280)
// ===========================================================================
describe("sonarr_search_series — pre-computed mediaStatus (#280)", () => {
  const SONARR_SERIES = { id: 10, title: "Breaking Bad", year: 2008, seasonCount: 5, monitored: true, tvdbId: 81189 };

  it("sets mediaStatus 'available' and no seasons array when Plex has all seasons", async () => {
    const PLEX_RESULT = {
      title: "Breaking Bad", year: 2008, mediaType: "tv",
      plexKey: "/library/metadata/77", thumbPath: "/library/metadata/77/thumb",
      cast: ["Bryan Cranston"],
      seasons: 5, // matches SONARR_SERIES.seasonCount
    };
    mockSonarrSearchSeries.mockResolvedValueOnce([SONARR_SERIES]);
    mockPlexSearchLibrary.mockResolvedValueOnce({ results: [PLEX_RESULT], hasMore: false });

    const { registerSonarrTools } = await import("@/lib/tools/sonarr-tools");
    const { defineTool, executeTool } = await import("@/lib/tools/registry");
    (defineTool as unknown as { _registry?: Map<string, unknown> })._registry?.clear?.();
    registerSonarrTools();

    const raw = await executeTool("sonarr_search_series", JSON.stringify({ term: "Breaking Bad" }));
    const results = JSON.parse(raw) as Record<string, unknown>[];
    expect(results[0].mediaStatus).toBe("available");
    expect(results[0].seasons).toBeUndefined(); // only set when partial
  });

  it("sets mediaStatus 'partial' and seasons[] derived from Sonarr episode counts when Plex has fewer seasons (issues #364, #367)", async () => {
    const PLEX_RESULT = {
      title: "Breaking Bad", year: 2008, mediaType: "tv",
      plexKey: "/library/metadata/77", thumbPath: "/library/metadata/77/thumb",
      cast: ["Bryan Cranston"],
      seasons: 1, // Plex only has S1; Sonarr knows about 2 seasons
    };
    // sonarrSeasons: S1 downloaded (episodeCount>0), S2 monitored but not downloaded
    const SONARR_PARTIAL = {
      ...SONARR_SERIES,
      seasonCount: 2,
      sonarrSeasons: [
        { seasonNumber: 1, episodeCount: 13, monitored: true },
        { seasonNumber: 2, episodeCount: 0, monitored: true },
      ],
    };
    mockSonarrSearchSeries.mockResolvedValueOnce([SONARR_PARTIAL]);
    mockPlexSearchLibrary.mockResolvedValueOnce({ results: [PLEX_RESULT], hasMore: false });

    const { registerSonarrTools } = await import("@/lib/tools/sonarr-tools");
    const { defineTool, executeTool } = await import("@/lib/tools/registry");
    (defineTool as unknown as { _registry?: Map<string, unknown> })._registry?.clear?.();
    registerSonarrTools();

    const raw = await executeTool("sonarr_search_series", JSON.stringify({ term: "Breaking Bad" }));
    const results = JSON.parse(raw) as Record<string, unknown>[];
    expect(results[0].mediaStatus).toBe("partial");
    // seasons[] uses Sonarr episode counts — no Plex lookup needed for per-season status
    const seasons = results[0].seasons as Array<{ seasonNumber: number; mediaStatus: string }>;
    expect(seasons).toEqual([
      { seasonNumber: 1, mediaStatus: "available" },
      { seasonNumber: 2, mediaStatus: "partial" },
    ]);
    expect(mockOverseerrSearch).not.toHaveBeenCalled();
  });

  it("sets mediaStatus from Overseerr (normalized) when not in Plex", async () => {
    mockSonarrSearchSeries.mockResolvedValueOnce([SONARR_SERIES]);
    mockPlexSearchLibrary.mockResolvedValueOnce({ results: [], hasMore: false });
    mockOverseerrSearch.mockResolvedValueOnce({
      results: [{ ...TV_SEARCH_RESULT, mediaStatus: "Processing" }],
      hasMore: false,
    });
    mockOverseerrGetDetails.mockResolvedValueOnce(TV_DETAIL);

    const { registerSonarrTools } = await import("@/lib/tools/sonarr-tools");
    const { defineTool, executeTool } = await import("@/lib/tools/registry");
    (defineTool as unknown as { _registry?: Map<string, unknown> })._registry?.clear?.();
    registerSonarrTools();

    const raw = await executeTool("sonarr_search_series", JSON.stringify({ term: "Breaking Bad" }));
    const results = JSON.parse(raw) as Record<string, unknown>[];
    // normalizeMediaStatus is mocked as s.toLowerCase().replace(/ /g, "_")
    // so "Processing" → "processing" — confirms normalization is called, not raw value passed through.
    expect(results[0].mediaStatus).not.toBe("Processing");
  });

  it("sets mediaStatus 'partial' for monitored show not found in Plex or Overseerr (being managed by Sonarr, no request button)", async () => {
    mockSonarrSearchSeries.mockResolvedValueOnce([{ ...SONARR_SERIES, monitored: true }]);
    mockPlexSearchLibrary.mockRejectedValueOnce(new Error("Plex unavailable"));
    mockOverseerrSearch.mockRejectedValueOnce(new Error("Overseerr unavailable"));

    const { registerSonarrTools } = await import("@/lib/tools/sonarr-tools");
    const { defineTool, executeTool } = await import("@/lib/tools/registry");
    (defineTool as unknown as { _registry?: Map<string, unknown> })._registry?.clear?.();
    registerSonarrTools();

    const raw = await executeTool("sonarr_search_series", JSON.stringify({ term: "Breaking Bad" }));
    const results = JSON.parse(raw) as Record<string, unknown>[];
    expect(results[0].mediaStatus).toBe("partial");
  });

  it("sets mediaStatus 'not_requested' for unmonitored show not found in Plex or Overseerr", async () => {
    mockSonarrSearchSeries.mockResolvedValueOnce([{ ...SONARR_SERIES, monitored: false }]);
    mockPlexSearchLibrary.mockRejectedValueOnce(new Error("Plex unavailable"));
    mockOverseerrSearch.mockRejectedValueOnce(new Error("Overseerr unavailable"));

    const { registerSonarrTools } = await import("@/lib/tools/sonarr-tools");
    const { defineTool, executeTool } = await import("@/lib/tools/registry");
    (defineTool as unknown as { _registry?: Map<string, unknown> })._registry?.clear?.();
    registerSonarrTools();

    const raw = await executeTool("sonarr_search_series", JSON.stringify({ term: "Breaking Bad" }));
    const results = JSON.parse(raw) as Record<string, unknown>[];
    expect(results[0].mediaStatus).toBe("not_requested");
  });
});
