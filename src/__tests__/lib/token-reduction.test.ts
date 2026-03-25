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

  it("strips summary, thumbPath, seasons, totalEpisodes, watchedEpisodes, dateAdded from history", async () => {
    const { registerPlexTools } = await import("@/lib/tools/plex-tools");
    const { defineTool, getToolLlmContent } = await import("@/lib/tools/registry");

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

    // Fields that should be PRESENT
    expect(item.title).toBe("The Matrix");
    expect(item.year).toBe(1999);
    expect(item.mediaType).toBe("movie");
    expect(item.plexKey).toBe("/library/metadata/42");
    expect(item.rating).toBe(8.7);
    expect(item.cast).toEqual(["Keanu Reeves"]);

    // Fields that should be STRIPPED
    expect(item).not.toHaveProperty("summary");
    expect(item).not.toHaveProperty("thumbPath");
    expect(item).not.toHaveProperty("seasons");
    expect(item).not.toHaveProperty("totalEpisodes");
    expect(item).not.toHaveProperty("watchedEpisodes");
    expect(item).not.toHaveProperty("dateAdded");
  });

  it("plex_check_availability llmSummary preserves available flag and strips bulky fields", async () => {
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
    expect(item).not.toHaveProperty("summary");
    expect(item).not.toHaveProperty("thumbPath");
    expect(item).not.toHaveProperty("dateAdded");
  });
});

// ---------------------------------------------------------------------------
// 3. Overseerr tool llmSummary — strips summary and thumbPath from history
// ---------------------------------------------------------------------------
describe("overseerr_search llmSummary", () => {
  beforeEach(() => { vi.resetModules(); });

  it("strips summary and thumbPath, keeps identity and status fields", async () => {
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
    expect(item).not.toHaveProperty("summary");
    expect(item).not.toHaveProperty("thumbPath");
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
