/**
 * Tests for token-reduction changes that prevent OpenAI TPM rate-limit exhaustion.
 *
 * Three sources of token bloat were addressed:
 * 1. overseerr.search() — summary was unbounded (now capped at 300 chars)
 * 2. Plex tool llmSummary — strips summary, thumbPath, and secondary metadata
 *    so old search results in conversation history are compact
 * 3. Overseerr tool llmSummary — strips summary and thumbPath from history
 * 4. Orchestrator in-round messages use the full result (not llmSummary) so
 *    the LLM still has all fields available when constructing display_titles args
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// 1. overseerr.search() — summary truncation
// ---------------------------------------------------------------------------
vi.mock("@/lib/config", () => ({
  getConfig: (key: string) => {
    if (key === "overseerr.url") return "http://overseerr.local:5055";
    if (key === "overseerr.apiKey") return "test-key";
    if (key === "plex.url") return "http://plex.local:32400";
    if (key === "plex.token") return "plex-token";
    return null;
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("overseerr.search — summary truncation", () => {
  beforeEach(() => { vi.resetModules(); });

  it("truncates a long TMDB overview to 300 chars", async () => {
    const longOverview = "A".repeat(600);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{
          id: 1, mediaType: "movie", title: "Long Description Movie",
          releaseDate: "2020-01-01", posterPath: "/p.jpg",
          overview: longOverview, voteAverage: 7.0, mediaInfo: { status: 5 },
        }],
        totalPages: 1,
      }),
    }));

    const { search } = await import("@/lib/services/overseerr");
    const { results } = await search("test");
    expect(results[0].summary).toHaveLength(300);
    expect(results[0].summary).toBe("A".repeat(300));
  });

  it("keeps short overviews unchanged", async () => {
    const shortOverview = "A short synopsis.";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{
          id: 2, mediaType: "movie", title: "Short Synopsis Movie",
          releaseDate: "2021-01-01", posterPath: "/p.jpg",
          overview: shortOverview, voteAverage: 6.5, mediaInfo: { status: 5 },
        }],
        totalPages: 1,
      }),
    }));

    const { search } = await import("@/lib/services/overseerr");
    const { results } = await search("test");
    expect(results[0].summary).toBe(shortOverview);
  });
});

// ---------------------------------------------------------------------------
// 2. Plex tool llmSummary — strips bulky fields from history
// ---------------------------------------------------------------------------
describe("plex tool llmSummary", () => {
  beforeEach(() => { vi.resetModules(); });

  it("strips summary/secondary metadata but keeps thumbPath and plexKey from history", async () => {
    const { registerPlexTools } = await import("@/lib/tools/plex-tools");
    const { getToolLlmContent } = await import("@/lib/tools/registry");

    // Need to clear registry between tests — re-importing with resetModules handles this
    registerPlexTools();

    const fullResult = JSON.stringify({
      results: [{
        title: "The Matrix",
        year: 1999,
        mediaType: "movie",
        plexKey: "/library/metadata/42",
        thumbPath: "/library/metadata/42/thumb",
        summary: "A computer hacker learns the truth about reality.",
        rating: 8.7,
        cast: ["Keanu Reeves"],
        seasons: 1,
        totalEpisodes: 10,
        watchedEpisodes: 5,
        dateAdded: "2024-01-01",
      }],
      hasMore: false,
    });

    const compact = JSON.parse(getToolLlmContent("plex_search_library", fullResult)) as Record<string, unknown>;
    const item = (compact.results as Record<string, unknown>[])[0];

    // Fields that should be PRESENT (including thumbPath — needed for follow-up display)
    expect(item.title).toBe("The Matrix");
    expect(item.year).toBe(1999);
    expect(item.mediaType).toBe("movie");
    expect(item.plexKey).toBe("/library/metadata/42");
    expect(item.thumbPath).toBe("/library/metadata/42/thumb");
    expect(item.rating).toBe(8.7);
    expect(item.cast).toEqual(["Keanu Reeves"]);

    // Fields that should be STRIPPED
    expect(item).not.toHaveProperty("summary");
    expect(item).not.toHaveProperty("seasons");
    expect(item).not.toHaveProperty("totalEpisodes");
    expect(item).not.toHaveProperty("watchedEpisodes");
    expect(item).not.toHaveProperty("dateAdded");
  });

  it("plex_check_availability llmSummary preserves available flag, thumbPath, and plexKey", async () => {
    const { registerPlexTools } = await import("@/lib/tools/plex-tools");
    const { getToolLlmContent } = await import("@/lib/tools/registry");

    registerPlexTools();

    const fullResult = JSON.stringify({
      available: true,
      results: [{
        title: "Inception",
        year: 2010,
        mediaType: "movie",
        plexKey: "/library/metadata/99",
        thumbPath: "/library/metadata/99/thumb",
        summary: "A thief who steals corporate secrets.",
        rating: 8.8,
        cast: ["Leonardo DiCaprio"],
        totalEpisodes: undefined,
        dateAdded: "2023-05-15",
      }],
    });

    const compact = JSON.parse(getToolLlmContent("plex_check_availability", fullResult)) as Record<string, unknown>;
    expect(compact.available).toBe(true);
    const item = (compact.results as Record<string, unknown>[])[0];
    expect(item.plexKey).toBe("/library/metadata/99");
    // thumbPath preserved for follow-up display_titles calls
    expect(item.thumbPath).toBe("/library/metadata/99/thumb");
    expect(item).not.toHaveProperty("summary");
    expect(item).not.toHaveProperty("dateAdded");
  });
});

// ---------------------------------------------------------------------------
// 3. Overseerr tool llmSummary — strips summary and thumbPath from history
// ---------------------------------------------------------------------------
describe("overseerr_search llmSummary", () => {
  beforeEach(() => { vi.resetModules(); });

  it("strips summary, keeps thumbPath and identity/status fields", async () => {
    const { registerOverseerrTools } = await import("@/lib/tools/overseerr-tools");
    const { getToolLlmContent } = await import("@/lib/tools/registry");

    registerOverseerrTools();

    const fullResult = JSON.stringify({
      results: [{
        overseerrId: 550,
        overseerrMediaType: "movie",
        title: "Fight Club",
        year: "1999",
        rating: 8.4,
        mediaStatus: "Available",
        seasonCount: undefined,
        summary: "A long synopsis that should be stripped from history.",
        thumbPath: "https://image.tmdb.org/t/p/w300/poster.jpg",
      }],
      hasMore: false,
    });

    const compact = JSON.parse(getToolLlmContent("overseerr_search", fullResult)) as Record<string, unknown>;
    const item = (compact.results as Record<string, unknown>[])[0];

    expect(item.overseerrId).toBe(550);
    expect(item.overseerrMediaType).toBe("movie");
    expect(item.title).toBe("Fight Club");
    expect(item.mediaStatus).toBe("Available");
    // thumbPath preserved — needed for follow-up display_titles calls without re-searching
    expect(item.thumbPath).toBe("https://image.tmdb.org/t/p/w300/poster.jpg");
    expect(item).not.toHaveProperty("summary");
  });
});

// ---------------------------------------------------------------------------
// 4. overseerr_get_details llmSummary — compact cast, no seasons list, no requests
// ---------------------------------------------------------------------------
describe("overseerr_get_details llmSummary", () => {
  beforeEach(() => { vi.resetModules(); });

  it("limits cast to 5, compacts seasons to status string, strips requests from history", async () => {
    const { registerOverseerrTools } = await import("@/lib/tools/overseerr-tools");
    const { getToolLlmContent } = await import("@/lib/tools/registry");
    registerOverseerrTools();

    const fullResult = JSON.stringify({
      overseerrId: 550,
      overseerrMediaType: "movie",
      title: "Fight Club",
      year: "1999",
      imdbId: "tt0137523",
      cast: ["Brad Pitt", "Edward Norton", "Helena Bonham Carter", "Meat Loaf", "Jared Leto",
             "Zach Grenier", "Holt McCallany", "Eion Bailey", "Bob"],
      genres: ["Drama", "Thriller"],
      runtime: 139,
      seasonCount: undefined,
      seasons: [
        { seasonNumber: 1, status: "Available" },
        { seasonNumber: 2, status: "Not Requested" },
      ],
      requests: [{ id: 1, status: "Approved", requestedBy: "alice", requestedAt: "2026-01-01" }],
    });

    const compact = JSON.parse(getToolLlmContent("overseerr_get_details", fullResult)) as Record<string, unknown>;

    expect(compact.overseerrId).toBe(550);
    expect(compact.title).toBe("Fight Club");
    expect(compact.imdbId).toBe("tt0137523");
    expect(compact.genres).toEqual(["Drama", "Thriller"]);
    expect(compact.runtime).toBe(139);

    // Cast capped at 5
    expect((compact.cast as string[]).length).toBe(5);
    expect((compact.cast as string[])[0]).toBe("Brad Pitt");

    // Seasons compacted to status string (all statuses preserved, not just available)
    expect(compact.seasons).toBe("S1:available S2:not_requested");
    // Requests stripped
    expect(compact).not.toHaveProperty("requests");
  });

  it("includes compact seasons string with all statuses (available, pending, not_requested)", async () => {
    const { registerOverseerrTools } = await import("@/lib/tools/overseerr-tools");
    const { getToolLlmContent } = await import("@/lib/tools/registry");
    registerOverseerrTools();

    const fullResult = JSON.stringify({
      overseerrId: 1399,
      overseerrMediaType: "tv",
      title: "Game of Thrones",
      year: "2011",
      seasonCount: 8,
      cast: ["Emilia Clarke", "Kit Harington"],
      genres: ["Drama", "Fantasy"],
      seasons: [
        { seasonNumber: 1, status: "Available" },
        { seasonNumber: 2, status: "Available" },
        { seasonNumber: 3, status: "Not Requested" },
      ],
      requests: [],
    });

    const compact = JSON.parse(getToolLlmContent("overseerr_get_details", fullResult)) as Record<string, unknown>;

    expect(compact.seasonCount).toBe(8);
    // Compact string preserves all season statuses so LLM sets correct mediaStatus per season
    expect(compact.seasons).toBe("S1:available S2:available S3:not_requested");
    expect(compact).not.toHaveProperty("availableSeasons");
    expect(compact).not.toHaveProperty("requests");
  });
});

// ---------------------------------------------------------------------------
// 5. plex_get_title_tags llmSummary — directors ≤3, actors ≤5
// ---------------------------------------------------------------------------
describe("plex_get_title_tags llmSummary", () => {
  beforeEach(() => { vi.resetModules(); });

  it("limits directors to 3 and actors to 5", async () => {
    const { registerPlexTools } = await import("@/lib/tools/plex-tools");
    const { getToolLlmContent } = await import("@/lib/tools/registry");
    registerPlexTools();

    const fullResult = JSON.stringify({
      key: "/library/metadata/42",
      title: "Inception",
      genres: ["Action", "Sci-Fi"],
      directors: ["Christopher Nolan", "Dir Two", "Dir Three", "Dir Four"],
      actors: ["Leonardo DiCaprio", "Joseph Gordon-Levitt", "Elliot Page", "Tom Hardy", "Ken Watanabe", "Cillian Murphy"],
      countries: ["United States"],
      studio: "Warner Bros.",
      contentRating: "PG-13",
      labels: [],
    });

    const compact = JSON.parse(getToolLlmContent("plex_get_title_tags", fullResult)) as Record<string, unknown>;

    expect((compact.directors as string[]).length).toBe(3);
    expect((compact.actors as string[]).length).toBe(5);
    expect(compact.genres).toEqual(["Action", "Sci-Fi"]);
    expect(compact.studio).toBe("Warner Bros.");
    expect(compact.contentRating).toBe("PG-13");
  });

  it("passes through short arrays unchanged", async () => {
    const { registerPlexTools } = await import("@/lib/tools/plex-tools");
    const { getToolLlmContent } = await import("@/lib/tools/registry");
    registerPlexTools();

    const fullResult = JSON.stringify({
      key: "/library/metadata/99",
      title: "Short Movie",
      genres: ["Comedy"],
      directors: ["Solo Director"],
      actors: ["Actor One", "Actor Two"],
      countries: [],
      labels: [],
    });

    const compact = JSON.parse(getToolLlmContent("plex_get_title_tags", fullResult)) as Record<string, unknown>;

    expect((compact.directors as string[])).toEqual(["Solo Director"]);
    expect((compact.actors as string[])).toEqual(["Actor One", "Actor Two"]);
  });
});

// ---------------------------------------------------------------------------
// 6. sonarr_search_series llmSummary — strips overview
// ---------------------------------------------------------------------------
describe("sonarr_search_series llmSummary", () => {
  beforeEach(() => { vi.resetModules(); });

  it("strips overview from history results", async () => {
    const { registerSonarrTools } = await import("@/lib/tools/sonarr-tools");
    const { getToolLlmContent } = await import("@/lib/tools/registry");
    registerSonarrTools();

    const fullResult = JSON.stringify([
      { id: 1, title: "Breaking Bad", year: 2008, overview: "A chemistry teacher becomes a drug lord.", status: "ended", seasonCount: 5, monitored: true, tvdbId: 81189 },
      { id: 2, title: "Better Call Saul", year: 2015, overview: "Prequel to Breaking Bad.", status: "ended", seasonCount: 6, monitored: false, tvdbId: 273181 },
    ]);

    const compact = JSON.parse(getToolLlmContent("sonarr_search_series", fullResult)) as Record<string, unknown>[];

    expect(compact[0].title).toBe("Breaking Bad");
    expect(compact[0].seasonCount).toBe(5);
    expect(compact[0]).not.toHaveProperty("overview");
    expect(compact[1]).not.toHaveProperty("overview");
  });
});

// ---------------------------------------------------------------------------
// 7. sonarr_get_series_status llmSummary — compact seasons string
// ---------------------------------------------------------------------------
describe("sonarr_get_series_status llmSummary", () => {
  beforeEach(() => { vi.resetModules(); });

  it("compacts per-season array to a summary string", async () => {
    const { registerSonarrTools } = await import("@/lib/tools/sonarr-tools");
    const { getToolLlmContent } = await import("@/lib/tools/registry");
    registerSonarrTools();

    const fullResult = JSON.stringify({
      title: "Breaking Bad",
      year: 2008,
      networkStatus: "ended",
      monitored: true,
      totalSeasons: 5,
      totalEpisodes: 62,
      downloadedEpisodes: 60,
      missingEpisodes: 2,
      nextAiring: undefined,
      seasons: [
        { seasonNumber: 1, totalEpisodes: 7, downloadedEpisodes: 7, monitored: true },
        { seasonNumber: 2, totalEpisodes: 13, downloadedEpisodes: 13, monitored: true },
        { seasonNumber: 3, totalEpisodes: 13, downloadedEpisodes: 11, monitored: true },
      ],
    });

    const compact = JSON.parse(getToolLlmContent("sonarr_get_series_status", fullResult)) as Record<string, unknown>;

    expect(compact.title).toBe("Breaking Bad");
    expect(compact.totalEpisodes).toBe(62);
    expect(compact.downloadedEpisodes).toBe(60);
    // seasons should be a compact string, not an array
    expect(typeof compact.seasons).toBe("string");
    expect(compact.seasons).toBe("S1:7/7 S2:13/13 S3:11/13");
    expect(compact).not.toHaveProperty("nextAiring");
  });

  it("returns null for null input", async () => {
    const { registerSonarrTools } = await import("@/lib/tools/sonarr-tools");
    const { getToolLlmContent } = await import("@/lib/tools/registry");
    registerSonarrTools();

    const compact = JSON.parse(getToolLlmContent("sonarr_get_series_status", "null"));
    expect(compact).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 8. radarr_search_movie llmSummary — strips overview
// ---------------------------------------------------------------------------
describe("radarr_search_movie llmSummary", () => {
  beforeEach(() => { vi.resetModules(); });

  it("strips overview from history results", async () => {
    const { registerRadarrTools } = await import("@/lib/tools/radarr-tools");
    const { getToolLlmContent } = await import("@/lib/tools/registry");
    registerRadarrTools();

    const fullResult = JSON.stringify([
      { id: 1, title: "Inception", year: 2010, overview: "A thief who steals corporate secrets.", status: "released", monitored: true, hasFile: true, tmdbId: 27205 },
      { id: 2, title: "Interstellar", year: 2014, overview: "A team of explorers travel through a wormhole.", status: "released", monitored: false, hasFile: false, tmdbId: 157336 },
    ]);

    const compact = JSON.parse(getToolLlmContent("radarr_search_movie", fullResult)) as Record<string, unknown>[];

    expect(compact[0].title).toBe("Inception");
    expect(compact[0].tmdbId).toBe(27205);
    expect(compact[0].hasFile).toBe(true);
    expect(compact[0]).not.toHaveProperty("overview");
    expect(compact[1]).not.toHaveProperty("overview");
  });
});

// ---------------------------------------------------------------------------
// 9. display_titles tool call arg compression in loadHistory
// ---------------------------------------------------------------------------
describe("display_titles tool call arg compression", () => {
  beforeEach(() => { vi.resetModules(); });

  it("strips summary and cast from display_titles tool call args in history, preserves thumbPath", async () => {
    // We test the compression logic directly by simulating what loadHistory does:
    // parse stored tool_calls JSON, apply the compaction, check the result.
    // thumbPath is preserved (needed for follow-up display_titles without re-searching).
    // Only summary and cast are stripped (bulk savings without losing poster URLs).
    type TitleArg = {
      title: string;
      mediaType: string;
      seasonNumber: number;
      summary?: string;
      thumbPath?: string;
      cast?: string[];
      overseerrId: number;
      overseerrMediaType: string;
      mediaStatus: string;
    };

    const storedToolCalls = JSON.stringify([{
      id: "call_abc",
      type: "function",
      function: {
        name: "display_titles",
        arguments: JSON.stringify({
          titles: [
            { title: "Game of Thrones — Season 1", mediaType: "tv", seasonNumber: 1, overseerrId: 1399, overseerrMediaType: "tv", mediaStatus: "available", summary: "In the mythical continent of Westeros...", thumbPath: "https://image.tmdb.org/t/p/w300/poster.jpg", cast: ["Emilia Clarke", "Kit Harington"], year: 2011 },
            { title: "Game of Thrones — Season 2", mediaType: "tv", seasonNumber: 2, overseerrId: 1399, overseerrMediaType: "tv", mediaStatus: "available", summary: "In the mythical continent of Westeros...", thumbPath: "https://image.tmdb.org/t/p/w300/poster.jpg", cast: ["Emilia Clarke", "Kit Harington"], year: 2012 },
            { title: "Game of Thrones — Season 3", mediaType: "tv", seasonNumber: 3, overseerrId: 1399, overseerrMediaType: "tv", mediaStatus: "not_requested", summary: "In the mythical continent of Westeros...", thumbPath: "https://image.tmdb.org/t/p/w300/poster.jpg", cast: ["Emilia Clarke", "Kit Harington"], year: 2013 },
          ],
        }),
      },
    }]);

    // Apply the same compaction logic used in loadHistory
    const toolCalls = JSON.parse(storedToolCalls) as { id: string; type: string; function: { name: string; arguments: string } }[];
    const compacted = toolCalls.map((tc) => {
      if (tc.type === "function" && tc.function.name === "display_titles") {
        const args = JSON.parse(tc.function.arguments) as { titles: TitleArg[] };
        const compactedArgs = {
          titles: args.titles.map(
            // Strip only decorative fields (summary, cast) — NOT thumbPath.
            // thumbPath is needed so the LLM can reuse the poster URL in
            // follow-up display_titles calls without re-searching.
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            ({ summary: _s, cast: _c, ...rest }) => rest,
          ),
        };
        return { ...tc, function: { ...tc.function, arguments: JSON.stringify(compactedArgs) } };
      }
      return tc;
    });

    const titles = JSON.parse(compacted[0].function.arguments).titles as TitleArg[];

    // Identity and display fields preserved
    expect(titles[0].title).toBe("Game of Thrones — Season 1");
    expect(titles[0].seasonNumber).toBe(1);
    expect(titles[0].overseerrId).toBe(1399);
    expect(titles[0].mediaStatus).toBe("available");
    expect(titles[2].mediaStatus).toBe("not_requested");

    // thumbPath preserved for follow-up display_titles calls
    for (const t of titles) {
      expect(t.thumbPath).toBe("https://image.tmdb.org/t/p/w300/poster.jpg");
    }

    // Bulky repeated fields stripped
    for (const t of titles) {
      expect(t).not.toHaveProperty("summary");
      expect(t).not.toHaveProperty("cast");
    }
  });
});

describe("overseerr_list_requests llmSummary", () => {
  beforeEach(() => { vi.resetModules(); });

  it("strips thumbPath, id, tmdbId, requestedAt; keeps display_titles-relevant fields", async () => {
    const { registerOverseerrTools } = await import("@/lib/tools/overseerr-tools");
    const { getToolLlmContent } = await import("@/lib/tools/registry");

    registerOverseerrTools();

    const fullResult = JSON.stringify({
      results: [{
        id: 706,
        mediaType: "movie",
        title: "Fight Club",
        year: "1999",
        status: "Approved",
        mediaStatus: "pending",
        requestedBy: "alice",
        requestedAt: "2026-01-01T00:00:00.000Z",
        tmdbId: 550,
        overseerrId: 550,
        thumbPath: "https://image.tmdb.org/t/p/w300/poster.jpg",
        seasonsRequested: undefined,
      }],
      hasMore: false,
    });

    const compact = JSON.parse(getToolLlmContent("overseerr_list_requests", fullResult)) as Record<string, unknown>;
    const item = (compact.results as Record<string, unknown>[])[0];

    expect(item.title).toBe("Fight Club");
    expect(item.status).toBe("Approved");
    expect(item.mediaStatus).toBe("pending");
    expect(item.requestedBy).toBe("alice");
    expect(item.overseerrId).toBe(550);
    expect(item).not.toHaveProperty("thumbPath");
    expect(item).not.toHaveProperty("requestedAt");
    expect(item).not.toHaveProperty("tmdbId");
    expect(item).not.toHaveProperty("id");
  });
});
