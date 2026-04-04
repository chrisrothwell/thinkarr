/**
 * Regression test: every tool whose llmSummary is called with a result that
 * contains thumbPath must preserve thumbPath in the summary output.
 *
 * This acts as an automated lint rule to prevent the recurring "thumbnail
 * stripped by llmSummary" bug (issues #291, previously seen in #258).
 * When a new tool is added with an llmSummary, add a case here.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/config", () => ({
  getConfig: (key: string) => {
    if (key === "overseerr.url") return "http://overseerr.local:5055";
    if (key === "overseerr.apiKey") return "test-key";
    if (key === "sonarr.url") return null;
    if (key === "radarr.url") return null;
    if (key === "plex.url") return null;
    return null;
  },
}));
vi.mock("@/lib/services/plex", () => ({
  searchLibrary: vi.fn().mockResolvedValue({ results: [] }),
  findShowPlexKey: vi.fn().mockResolvedValue(undefined),
  buildThumbUrl: vi.fn((p: string) => `http://plex/thumb?path=${p}`),
  getPlexMachineId: vi.fn().mockResolvedValue("machine-id"),
}));

const THUMB = "https://image.tmdb.org/t/p/w300/poster.jpg";

/** Invoke a tool's llmSummary function by calling executeTool and extracting the
 *  summary via getToolLlmContent (same path the orchestrator uses). */
async function getSummary(toolName: string, fullResult: unknown): Promise<unknown> {
  const { getToolLlmContent } = await import("@/lib/tools/registry");
  const summary = getToolLlmContent(toolName, JSON.stringify(fullResult));
  return JSON.parse(summary);
}

// ---------------------------------------------------------------------------
// overseerr_search
// ---------------------------------------------------------------------------
describe("overseerr_search llmSummary preserves thumbPath", () => {
  beforeEach(() => { vi.resetModules(); });

  it("includes thumbPath when present in each result", async () => {
    const { registerOverseerrTools } = await import("@/lib/tools/overseerr-tools");
    const { defineTool } = await import("@/lib/tools/registry");
    (defineTool as unknown as { _registry?: Map<string, unknown> })._registry?.clear?.();
    registerOverseerrTools();

    const fullResult = {
      results: [{
        overseerrId: 550, overseerrMediaType: "movie", title: "Fight Club",
        year: 1999, rating: 8.4, mediaStatus: "available", seasonCount: undefined,
        thumbPath: THUMB, cast: ["Brad Pitt"], imdbId: "tt0137523", seasons: undefined,
      }],
      hasMore: false,
    };
    const summary = await getSummary("overseerr_search", fullResult) as { results: Array<{ thumbPath?: string }> };
    expect(summary.results[0].thumbPath).toBe(THUMB);
  });
});

// ---------------------------------------------------------------------------
// overseerr_get_details
// ---------------------------------------------------------------------------
describe("overseerr_get_details llmSummary preserves thumbPath", () => {
  beforeEach(() => { vi.resetModules(); });

  it("includes thumbPath when present in the details result", async () => {
    const { registerOverseerrTools } = await import("@/lib/tools/overseerr-tools");
    const { defineTool } = await import("@/lib/tools/registry");
    (defineTool as unknown as { _registry?: Map<string, unknown> })._registry?.clear?.();
    registerOverseerrTools();

    const fullResult = {
      overseerrId: 550, overseerrMediaType: "movie", title: "Fight Club",
      year: 1999, imdbId: "tt0137523", cast: ["Brad Pitt", "Edward Norton"],
      genres: ["Drama"], runtime: 139, episodeRuntime: undefined,
      seasonCount: undefined, seasons: undefined, thumbPath: THUMB, requests: [],
    };
    const summary = await getSummary("overseerr_get_details", fullResult) as { thumbPath?: string };
    expect(summary.thumbPath).toBe(THUMB);
  });

  it("omits thumbPath key when not present in result (no undefined noise)", async () => {
    const { registerOverseerrTools } = await import("@/lib/tools/overseerr-tools");
    const { defineTool } = await import("@/lib/tools/registry");
    (defineTool as unknown as { _registry?: Map<string, unknown> })._registry?.clear?.();
    registerOverseerrTools();

    const fullResult = {
      overseerrId: 550, overseerrMediaType: "movie", title: "Fight Club",
      year: 1999, imdbId: "tt0137523", cast: [], genres: [], runtime: 139,
      seasonCount: undefined, seasons: undefined, thumbPath: undefined, requests: [],
    };
    const summary = await getSummary("overseerr_get_details", fullResult) as Record<string, unknown>;
    expect(summary).not.toHaveProperty("thumbPath");
  });
});

// ---------------------------------------------------------------------------
// overseerr_list_requests
// ---------------------------------------------------------------------------
describe("overseerr_list_requests llmSummary preserves thumbPath", () => {
  beforeEach(() => { vi.resetModules(); });

  it("includes thumbPath when present in each request", async () => {
    const { registerOverseerrTools } = await import("@/lib/tools/overseerr-tools");
    const { defineTool } = await import("@/lib/tools/registry");
    (defineTool as unknown as { _registry?: Map<string, unknown> })._registry?.clear?.();
    registerOverseerrTools();

    const fullResult = {
      results: [{
        mediaType: "movie", title: "Fight Club", year: 1999,
        status: "Approved", mediaStatus: "pending", requestedBy: "alice",
        overseerrId: 550, seasonsRequested: undefined, thumbPath: THUMB, seasons: undefined,
      }],
      hasMore: false,
    };
    const summary = await getSummary("overseerr_list_requests", fullResult) as { results: Array<{ thumbPath?: string }> };
    expect(summary.results[0].thumbPath).toBe(THUMB);
  });
});

// ---------------------------------------------------------------------------
// overseerr_get_season_episodes
// ---------------------------------------------------------------------------
describe("overseerr_get_season_episodes llmSummary preserves thumbPath per episode", () => {
  beforeEach(() => { vi.resetModules(); });

  it("includes thumbPath for episodes that have it", async () => {
    const { registerOverseerrTools } = await import("@/lib/tools/overseerr-tools");
    const { defineTool } = await import("@/lib/tools/registry");
    (defineTool as unknown as { _registry?: Map<string, unknown> })._registry?.clear?.();
    registerOverseerrTools();

    const EPISODE_THUMB = "https://image.tmdb.org/t/p/w300/still1.jpg";
    const fullResult = {
      seasonNumber: 1,
      episodes: [
        { episodeNumber: 1, name: "Pilot", airDate: "2008-01-20", runtime: 58, thumbPath: EPISODE_THUMB },
        { episodeNumber: 2, name: "Ep 2", airDate: "2008-01-27", runtime: 48, thumbPath: undefined },
      ],
    };
    const summary = await getSummary("overseerr_get_season_episodes", fullResult) as {
      episodes: Array<{ thumbPath?: string }>
    };
    expect(summary.episodes[0].thumbPath).toBe(EPISODE_THUMB);
    expect(summary.episodes[1]).not.toHaveProperty("thumbPath");
  });
});

// ---------------------------------------------------------------------------
// overseerr_discover
// ---------------------------------------------------------------------------
describe("overseerr_discover llmSummary preserves thumbPath", () => {
  beforeEach(() => { vi.resetModules(); });

  it("includes thumbPath when present in each result", async () => {
    const { registerOverseerrTools } = await import("@/lib/tools/overseerr-tools");
    const { defineTool } = await import("@/lib/tools/registry");
    (defineTool as unknown as { _registry?: Map<string, unknown> })._registry?.clear?.();
    registerOverseerrTools();

    const fullResult = {
      results: [{
        overseerrId: 238, overseerrMediaType: "movie", title: "The Godfather",
        year: 1972, rating: 9.2, mediaStatus: "not_requested", seasonCount: undefined,
        thumbPath: THUMB, cast: ["Marlon Brando"], imdbId: "tt0068646", seasons: undefined,
      }],
      hasMore: false,
    };
    const summary = await getSummary("overseerr_discover", fullResult) as { results: Array<{ thumbPath?: string }> };
    expect(summary.results[0].thumbPath).toBe(THUMB);
  });
});
