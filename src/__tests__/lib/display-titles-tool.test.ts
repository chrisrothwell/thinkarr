/**
 * Unit tests for display-titles-tool.ts — issue #117:
 * When an Overseerr result is "available" but has no plexKey, the tool should
 * perform a side-query to Plex and inject the matching plexKey so the Watch Now
 * button can be rendered. For TV series this requires findShowPlexKey which
 * searches all hubs (not just first 10) and returns the show-level key.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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

const PLEX_HUB_RESPONSE = (key: string, title: string, year: number) => ({
  MediaContainer: {
    Hub: [{
      type: "movie",
      Metadata: [{ title, year, type: "movie", key, thumb: "/thumb", addedAt: 1700000000 }],
    }],
  },
});

describe("display_titles — issue #117: Plex side-query for available titles without plexKey", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("injects plexKey for an available title that has no plexKey", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if ((url as string).includes("/hubs/search")) {
        return Promise.resolve({ ok: true, json: async () => PLEX_HUB_RESPONSE("/library/metadata/42", "Fight Club", 1999) });
      }
      // machineId call
      return Promise.resolve({ ok: true, json: async () => ({ MediaContainer: { machineIdentifier: "abc123" } }) });
    }));

    const { registerDisplayTitlesTool } = await import("@/lib/tools/display-titles-tool");
    const { executeTool } = await import("@/lib/tools/registry");
    registerDisplayTitlesTool();

    const raw = await executeTool("display_titles", JSON.stringify({
      titles: [{ mediaType: "movie", title: "Fight Club", year: 1999, mediaStatus: "available" }],
    }));
    const { displayTitles } = JSON.parse(raw) as { displayTitles: Array<{ plexKey?: string }> };
    expect(displayTitles[0].plexKey).toBe("/library/metadata/42");
  });

  it("does not overwrite an existing plexKey with the side-query result", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if ((url as string).includes("/hubs/search")) {
        return Promise.resolve({ ok: true, json: async () => PLEX_HUB_RESPONSE("/library/metadata/99", "Fight Club", 1999) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ MediaContainer: { machineIdentifier: "abc123" } }) });
    }));

    const { registerDisplayTitlesTool } = await import("@/lib/tools/display-titles-tool");
    const { executeTool } = await import("@/lib/tools/registry");
    registerDisplayTitlesTool();

    const raw = await executeTool("display_titles", JSON.stringify({
      titles: [{ mediaType: "movie", title: "Fight Club", year: 1999, mediaStatus: "available", plexKey: "/library/metadata/1" }],
    }));
    const { displayTitles } = JSON.parse(raw) as { displayTitles: Array<{ plexKey?: string }> };
    expect(displayTitles[0].plexKey).toBe("/library/metadata/1");
  });

  it("leaves plexKey undefined when Plex search returns no title match", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if ((url as string).includes("/hubs/search")) {
        return Promise.resolve({ ok: true, json: async () => ({ MediaContainer: { Hub: [] } }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ MediaContainer: { machineIdentifier: "abc123" } }) });
    }));

    const { registerDisplayTitlesTool } = await import("@/lib/tools/display-titles-tool");
    const { executeTool } = await import("@/lib/tools/registry");
    registerDisplayTitlesTool();

    const raw = await executeTool("display_titles", JSON.stringify({
      titles: [{ mediaType: "movie", title: "Fight Club", year: 1999, mediaStatus: "available" }],
    }));
    const { displayTitles } = JSON.parse(raw) as { displayTitles: Array<{ plexKey?: string }> };
    expect(displayTitles[0].plexKey).toBeUndefined();
  });

  it("does not run the side-query for not_requested titles", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ MediaContainer: { machineIdentifier: "abc123" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { registerDisplayTitlesTool } = await import("@/lib/tools/display-titles-tool");
    const { executeTool } = await import("@/lib/tools/registry");
    registerDisplayTitlesTool();

    await executeTool("display_titles", JSON.stringify({
      titles: [{ mediaType: "movie", title: "Fight Club", year: 1999, mediaStatus: "not_requested", overseerrId: 550, overseerrMediaType: "movie" }],
    }));

    const hubsCalls = fetchMock.mock.calls.filter((c) => (c[0] as string).includes("/hubs/search"));
    expect(hubsCalls).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // TV series — issue #117 comment: "works for movies but not for TV series"
  // ---------------------------------------------------------------------------

  it("injects the show-level plexKey for an available TV series entry", async () => {
    // Hub search returns: 3 episode hubs first, then the show hub.
    // searchLibrary's first-10 limit would miss the show; findShowPlexKey must not.
    const TV_HUB_RESPONSE = {
      MediaContainer: {
        Hub: [
          // Episode hub (comes first in real Plex responses)
          {
            type: "episode",
            Metadata: [
              {
                type: "episode",
                title: "Pilot",
                grandparentTitle: "Breaking Bad",
                grandparentKey: "/library/metadata/100",
                key: "/library/metadata/200",
                parentIndex: 1,
                index: 1,
              },
            ],
          },
          // Season hub
          {
            type: "season",
            Metadata: [
              {
                type: "season",
                title: "Season 1",
                parentTitle: "Breaking Bad",
                parentKey: "/library/metadata/100",
                key: "/library/metadata/150",
                index: 1,
              },
            ],
          },
          // Show hub — buried after episodes and seasons
          {
            type: "show",
            Metadata: [
              {
                type: "show",
                title: "Breaking Bad",
                year: 2008,
                key: "/library/metadata/100",
                thumb: "/thumb",
                addedAt: 1700000000,
              },
            ],
          },
        ],
      },
    };

    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if ((url as string).includes("/hubs/search")) {
        return Promise.resolve({ ok: true, json: async () => TV_HUB_RESPONSE });
      }
      return Promise.resolve({ ok: true, json: async () => ({ MediaContainer: { machineIdentifier: "server1" } }) });
    }));

    const { registerDisplayTitlesTool } = await import("@/lib/tools/display-titles-tool");
    const { executeTool } = await import("@/lib/tools/registry");
    registerDisplayTitlesTool();

    const raw = await executeTool("display_titles", JSON.stringify({
      titles: [
        { mediaType: "tv", title: "Breaking Bad", year: 2008, mediaStatus: "available", seasonNumber: 1 },
        { mediaType: "tv", title: "Breaking Bad", year: 2008, mediaStatus: "available", seasonNumber: 2 },
      ],
    }));
    const { displayTitles } = JSON.parse(raw) as { displayTitles: Array<{ plexKey?: string }> };
    // Both season entries should share the show-level key
    expect(displayTitles[0].plexKey).toBe("/library/metadata/100");
    expect(displayTitles[1].plexKey).toBe("/library/metadata/100");
  });

  it("falls back to season's parentKey when no show hub is returned", async () => {
    const SEASON_ONLY_RESPONSE = {
      MediaContainer: {
        Hub: [
          {
            type: "season",
            Metadata: [
              {
                type: "season",
                title: "Season 1",
                parentTitle: "Stranger Things",
                parentKey: "/library/metadata/300",
                key: "/library/metadata/350",
                index: 1,
              },
            ],
          },
        ],
      },
    };

    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if ((url as string).includes("/hubs/search")) {
        return Promise.resolve({ ok: true, json: async () => SEASON_ONLY_RESPONSE });
      }
      return Promise.resolve({ ok: true, json: async () => ({ MediaContainer: { machineIdentifier: "server2" } }) });
    }));

    const { registerDisplayTitlesTool } = await import("@/lib/tools/display-titles-tool");
    const { executeTool } = await import("@/lib/tools/registry");
    registerDisplayTitlesTool();

    const raw = await executeTool("display_titles", JSON.stringify({
      titles: [{ mediaType: "tv", title: "Stranger Things", mediaStatus: "available", seasonNumber: 1 }],
    }));
    const { displayTitles } = JSON.parse(raw) as { displayTitles: Array<{ plexKey?: string }> };
    expect(displayTitles[0].plexKey).toBe("/library/metadata/300");
  });
});

describe("display_titles — overseerrMediaType inference", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  const noPlexFetch = vi.fn().mockResolvedValue({
    ok: true, json: async () => ({ MediaContainer: { machineIdentifier: "server1" } }),
  });

  it("infers overseerrMediaType 'movie' from mediaType when not provided", async () => {
    vi.stubGlobal("fetch", noPlexFetch);
    const { registerDisplayTitlesTool } = await import("@/lib/tools/display-titles-tool");
    const { executeTool } = await import("@/lib/tools/registry");
    registerDisplayTitlesTool();

    const raw = await executeTool("display_titles", JSON.stringify({
      titles: [{ mediaType: "movie", title: "Inception", mediaStatus: "not_requested", overseerrId: 27205 }],
    }));
    const { displayTitles } = JSON.parse(raw) as { displayTitles: Array<{ overseerrMediaType?: string }> };
    expect(displayTitles[0].overseerrMediaType).toBe("movie");
  });

  it("infers overseerrMediaType 'tv' from mediaType 'tv' when not provided", async () => {
    vi.stubGlobal("fetch", noPlexFetch);
    const { registerDisplayTitlesTool } = await import("@/lib/tools/display-titles-tool");
    const { executeTool } = await import("@/lib/tools/registry");
    registerDisplayTitlesTool();

    const raw = await executeTool("display_titles", JSON.stringify({
      titles: [{ mediaType: "tv", title: "Severance", mediaStatus: "not_requested", overseerrId: 88329 }],
    }));
    const { displayTitles } = JSON.parse(raw) as { displayTitles: Array<{ overseerrMediaType?: string }> };
    expect(displayTitles[0].overseerrMediaType).toBe("tv");
  });

  it("infers overseerrMediaType 'tv' from mediaType 'episode' when not provided", async () => {
    vi.stubGlobal("fetch", noPlexFetch);
    const { registerDisplayTitlesTool } = await import("@/lib/tools/display-titles-tool");
    const { executeTool } = await import("@/lib/tools/registry");
    registerDisplayTitlesTool();

    const raw = await executeTool("display_titles", JSON.stringify({
      titles: [{ mediaType: "episode", title: "Pilot", mediaStatus: "available", overseerrId: 88329 }],
    }));
    const { displayTitles } = JSON.parse(raw) as { displayTitles: Array<{ overseerrMediaType?: string }> };
    expect(displayTitles[0].overseerrMediaType).toBe("tv");
  });

  it("does not set overseerrMediaType when overseerrId is absent", async () => {
    vi.stubGlobal("fetch", noPlexFetch);
    const { registerDisplayTitlesTool } = await import("@/lib/tools/display-titles-tool");
    const { executeTool } = await import("@/lib/tools/registry");
    registerDisplayTitlesTool();

    const raw = await executeTool("display_titles", JSON.stringify({
      titles: [{ mediaType: "movie", title: "Fight Club", mediaStatus: "available" }],
    }));
    const { displayTitles } = JSON.parse(raw) as { displayTitles: Array<{ overseerrMediaType?: string }> };
    expect(displayTitles[0].overseerrMediaType).toBeUndefined();
  });

  it("does not override an explicitly provided overseerrMediaType", async () => {
    vi.stubGlobal("fetch", noPlexFetch);
    const { registerDisplayTitlesTool } = await import("@/lib/tools/display-titles-tool");
    const { executeTool } = await import("@/lib/tools/registry");
    registerDisplayTitlesTool();

    const raw = await executeTool("display_titles", JSON.stringify({
      titles: [{ mediaType: "tv", title: "The Office", mediaStatus: "available", overseerrId: 2316, overseerrMediaType: "tv" }],
    }));
    const { displayTitles } = JSON.parse(raw) as { displayTitles: Array<{ overseerrMediaType?: string }> };
    expect(displayTitles[0].overseerrMediaType).toBe("tv");
  });
});

describe("display_titles — issue #294: Overseerr thumbPath recovery when LLM omits it", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("fetches thumbPath from Overseerr when overseerrId present but thumbPath missing", async () => {
    const POSTER = "https://image.tmdb.org/t/p/w300/bPsxOpHVpVCX3hFz2fxnF1Vz3Dj.jpg";
    vi.doMock("@/lib/services/overseerr", () => ({
      getDetails: vi.fn().mockResolvedValue({ thumbPath: POSTER }),
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ MediaContainer: { machineIdentifier: "server1" } }),
    }));

    const { registerDisplayTitlesTool } = await import("@/lib/tools/display-titles-tool");
    const { executeTool } = await import("@/lib/tools/registry");
    registerDisplayTitlesTool();

    const raw = await executeTool("display_titles", JSON.stringify({
      titles: [{ mediaType: "tv", title: "Star Trek", year: 1966, mediaStatus: "not_requested", overseerrId: 253, overseerrMediaType: "tv" }],
    }));
    const { displayTitles } = JSON.parse(raw) as { displayTitles: Array<{ thumbUrl?: string }> };
    expect(displayTitles[0].thumbUrl).toContain("bPsxOpHVpVCX3hFz2fxnF1Vz3Dj.jpg");
  });

  it("deduplicates Overseerr lookups: multiple season cards with same overseerrId fire one request", async () => {
    const POSTER = "https://image.tmdb.org/t/p/w300/poster.jpg";
    const getDetailsMock = vi.fn().mockResolvedValue({ thumbPath: POSTER });
    vi.doMock("@/lib/services/overseerr", () => ({ getDetails: getDetailsMock }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ MediaContainer: { machineIdentifier: "server1" } }),
    }));

    const { registerDisplayTitlesTool } = await import("@/lib/tools/display-titles-tool");
    const { executeTool } = await import("@/lib/tools/registry");
    registerDisplayTitlesTool();

    const raw = await executeTool("display_titles", JSON.stringify({
      titles: [
        { mediaType: "tv", title: "The Office — Season 1", year: 2005, mediaStatus: "not_requested", overseerrId: 2316, seasonNumber: 1 },
        { mediaType: "tv", title: "The Office — Season 2", year: 2005, mediaStatus: "not_requested", overseerrId: 2316, seasonNumber: 2 },
        { mediaType: "tv", title: "The Office — Season 3", year: 2005, mediaStatus: "not_requested", overseerrId: 2316, seasonNumber: 3 },
      ],
    }));
    const { displayTitles } = JSON.parse(raw) as { displayTitles: Array<{ thumbUrl?: string }> };

    // One network call for all three season cards sharing the same overseerrId
    expect(getDetailsMock).toHaveBeenCalledTimes(1);
    // All three cards get the poster
    expect(displayTitles[0].thumbUrl).toContain("poster.jpg");
    expect(displayTitles[1].thumbUrl).toContain("poster.jpg");
    expect(displayTitles[2].thumbUrl).toContain("poster.jpg");
  });

  it("does not call Overseerr when thumbPath is already provided by the LLM", async () => {
    const getDetailsMock = vi.fn();
    vi.doMock("@/lib/services/overseerr", () => ({ getDetails: getDetailsMock }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ MediaContainer: { machineIdentifier: "server1" } }),
    }));

    const { registerDisplayTitlesTool } = await import("@/lib/tools/display-titles-tool");
    const { executeTool } = await import("@/lib/tools/registry");
    registerDisplayTitlesTool();

    await executeTool("display_titles", JSON.stringify({
      titles: [{ mediaType: "movie", title: "Inception", year: 2010, mediaStatus: "not_requested",
        overseerrId: 27205, overseerrMediaType: "movie",
        thumbPath: "https://image.tmdb.org/t/p/w300/already.jpg" }],
    }));
    expect(getDetailsMock).not.toHaveBeenCalled();
  });

  it("is non-fatal when Overseerr lookup fails", async () => {
    vi.doMock("@/lib/services/overseerr", () => ({
      getDetails: vi.fn().mockRejectedValue(new Error("Overseerr unavailable")),
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ MediaContainer: { machineIdentifier: "server1" } }),
    }));

    const { registerDisplayTitlesTool } = await import("@/lib/tools/display-titles-tool");
    const { executeTool } = await import("@/lib/tools/registry");
    registerDisplayTitlesTool();

    const raw = await executeTool("display_titles", JSON.stringify({
      titles: [{ mediaType: "movie", title: "Inception", year: 2010, mediaStatus: "not_requested", overseerrId: 27205 }],
    }));
    const { displayTitles } = JSON.parse(raw) as { displayTitles: Array<{ thumbUrl?: string }> };
    // thumbUrl is undefined but no error thrown
    expect(displayTitles[0].thumbUrl).toBeUndefined();
  });
});

describe("display_titles — seasonNumber recovery from title", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  const noOpFetch = vi.fn().mockResolvedValue({
    ok: true, json: async () => ({ MediaContainer: { machineIdentifier: "server1" } }),
  });

  it("recovers seasonNumber from 'Show — Season N' title when LLM omits it", async () => {
    vi.doMock("@/lib/services/overseerr", () => ({ getDetails: vi.fn().mockResolvedValue({ thumbPath: undefined }) }));
    vi.stubGlobal("fetch", noOpFetch);
    const { registerDisplayTitlesTool } = await import("@/lib/tools/display-titles-tool");
    const { executeTool } = await import("@/lib/tools/registry");
    registerDisplayTitlesTool();

    const raw = await executeTool("display_titles", JSON.stringify({
      titles: [{ mediaType: "tv", title: "Breaking Bad — Season 3", mediaStatus: "not_requested", overseerrId: 1396 }],
    }));
    const { displayTitles } = JSON.parse(raw) as { displayTitles: Array<{ seasonNumber?: number }> };
    expect(displayTitles[0].seasonNumber).toBe(3);
  });

  it("handles em-dash, en-dash, and hyphen variants in title", async () => {
    vi.doMock("@/lib/services/overseerr", () => ({ getDetails: vi.fn().mockResolvedValue({ thumbPath: undefined }) }));
    vi.stubGlobal("fetch", noOpFetch);
    const { registerDisplayTitlesTool } = await import("@/lib/tools/display-titles-tool");
    const { executeTool } = await import("@/lib/tools/registry");
    registerDisplayTitlesTool();

    for (const sep of ["—", "–", "-"]) {
      vi.resetModules();
      vi.doMock("@/lib/services/overseerr", () => ({ getDetails: vi.fn().mockResolvedValue({ thumbPath: undefined }) }));
      const { registerDisplayTitlesTool: reg } = await import("@/lib/tools/display-titles-tool");
      const { executeTool: exec } = await import("@/lib/tools/registry");
      reg();
      const raw = await exec("display_titles", JSON.stringify({
        titles: [{ mediaType: "tv", title: `The Office ${sep} Season 2`, mediaStatus: "not_requested" }],
      }));
      const { displayTitles } = JSON.parse(raw) as { displayTitles: Array<{ seasonNumber?: number }> };
      expect(displayTitles[0].seasonNumber).toBe(2);
    }
  });

  it("does not override an explicitly provided seasonNumber", async () => {
    vi.doMock("@/lib/services/overseerr", () => ({ getDetails: vi.fn().mockResolvedValue({ thumbPath: undefined }) }));
    vi.stubGlobal("fetch", noOpFetch);
    const { registerDisplayTitlesTool } = await import("@/lib/tools/display-titles-tool");
    const { executeTool } = await import("@/lib/tools/registry");
    registerDisplayTitlesTool();

    const raw = await executeTool("display_titles", JSON.stringify({
      titles: [{ mediaType: "tv", title: "Severance — Season 1", mediaStatus: "not_requested", seasonNumber: 1 }],
    }));
    const { displayTitles } = JSON.parse(raw) as { displayTitles: Array<{ seasonNumber?: number }> };
    expect(displayTitles[0].seasonNumber).toBe(1);
  });
});

describe("display_titles — issue #351: imdbId side-query from Plex Guid", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("injects imdbId for an available Plex title when LLM omits it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if ((url as string).includes("/library/metadata/7938")) {
        // Season metadata — has parentKey
        return Promise.resolve({
          ok: true,
          json: async () => ({
            MediaContainer: {
              Metadata: [{
                type: "season",
                title: "Season 3",
                parentKey: "/library/metadata/500",
              }],
            },
          }),
        });
      }
      if ((url as string).includes("/library/metadata/500")) {
        // Show metadata — has Guid with imdbId
        return Promise.resolve({
          ok: true,
          json: async () => ({
            MediaContainer: {
              Metadata: [{
                type: "show",
                title: "Euphoria (US)",
                Guid: [{ id: "imdb://tt8772296" }, { id: "tmdb://85552" }],
              }],
            },
          }),
        });
      }
      // machineId call
      return Promise.resolve({ ok: true, json: async () => ({ MediaContainer: { machineIdentifier: "abc123" } }) });
    }));

    const { registerDisplayTitlesTool } = await import("@/lib/tools/display-titles-tool");
    const { executeTool } = await import("@/lib/tools/registry");
    registerDisplayTitlesTool();

    const raw = await executeTool("display_titles", JSON.stringify({
      titles: [{
        mediaType: "tv",
        title: "Euphoria (US) — Season 3",
        showTitle: "Euphoria (US)",
        seasonNumber: 3,
        mediaStatus: "available",
        plexKey: "/library/metadata/7938/children",
        // no imdbId — LLM dropped it
      }],
    }));
    const { displayTitles } = JSON.parse(raw) as { displayTitles: Array<{ imdbId?: string }> };
    expect(displayTitles[0].imdbId).toBe("tt8772296");
  });

  it("does not override an explicitly provided imdbId", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ MediaContainer: { machineIdentifier: "abc123" } }),
    }));

    const { registerDisplayTitlesTool } = await import("@/lib/tools/display-titles-tool");
    const { executeTool } = await import("@/lib/tools/registry");
    registerDisplayTitlesTool();

    const raw = await executeTool("display_titles", JSON.stringify({
      titles: [{
        mediaType: "movie",
        title: "The Matrix",
        mediaStatus: "available",
        plexKey: "/library/metadata/1",
        imdbId: "tt0133093",
      }],
    }));
    const { displayTitles } = JSON.parse(raw) as { displayTitles: Array<{ imdbId?: string }> };
    expect(displayTitles[0].imdbId).toBe("tt0133093");
  });

  it("does not run the side-query for not_requested titles", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ MediaContainer: { machineIdentifier: "abc123" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { registerDisplayTitlesTool } = await import("@/lib/tools/display-titles-tool");
    const { executeTool } = await import("@/lib/tools/registry");
    registerDisplayTitlesTool();

    await executeTool("display_titles", JSON.stringify({
      titles: [{
        mediaType: "movie",
        title: "Inception",
        mediaStatus: "not_requested",
        overseerrId: 27205,
        overseerrMediaType: "movie",
      }],
    }));

    const metadataCalls = fetchMock.mock.calls.filter(
      (c) => (c[0] as string).includes("/library/metadata/"),
    );
    expect(metadataCalls).toHaveLength(0);
  });

  it("deduplicates: two season cards sharing the same normalized plexKey fire one metadata fetch", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if ((url as string).includes("/library/metadata/100")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            MediaContainer: {
              Metadata: [{
                type: "show",
                title: "Breaking Bad",
                Guid: [{ id: "imdb://tt0903747" }],
              }],
            },
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ MediaContainer: { machineIdentifier: "s1" } }) });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { registerDisplayTitlesTool } = await import("@/lib/tools/display-titles-tool");
    const { executeTool } = await import("@/lib/tools/registry");
    registerDisplayTitlesTool();

    const raw = await executeTool("display_titles", JSON.stringify({
      titles: [
        { mediaType: "tv", title: "Breaking Bad — Season 1", seasonNumber: 1, mediaStatus: "available", plexKey: "/library/metadata/100" },
        { mediaType: "tv", title: "Breaking Bad — Season 2", seasonNumber: 2, mediaStatus: "available", plexKey: "/library/metadata/100" },
      ],
    }));
    const { displayTitles } = JSON.parse(raw) as { displayTitles: Array<{ imdbId?: string }> };

    expect(displayTitles[0].imdbId).toBe("tt0903747");
    expect(displayTitles[1].imdbId).toBe("tt0903747");

    const metadataCalls = fetchMock.mock.calls.filter(
      (c) => (c[0] as string).includes("/library/metadata/100"),
    );
    // Both cards share the same normalized key — only one metadata fetch
    expect(metadataCalls).toHaveLength(1);
  });

  it("is non-fatal when Plex metadata fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if ((url as string).includes("/library/metadata/")) {
        return Promise.reject(new Error("Plex unreachable"));
      }
      return Promise.resolve({ ok: true, json: async () => ({ MediaContainer: { machineIdentifier: "abc123" } }) });
    }));

    const { registerDisplayTitlesTool } = await import("@/lib/tools/display-titles-tool");
    const { executeTool } = await import("@/lib/tools/registry");
    registerDisplayTitlesTool();

    const raw = await executeTool("display_titles", JSON.stringify({
      titles: [{
        mediaType: "movie",
        title: "Fight Club",
        mediaStatus: "available",
        plexKey: "/library/metadata/1",
      }],
    }));
    const { displayTitles } = JSON.parse(raw) as { displayTitles: Array<{ imdbId?: string }> };
    // No imdbId but no error thrown
    expect(displayTitles[0].imdbId).toBeUndefined();
  });

  it("recovers thumbPath from Plex metadata when LLM drops it (issue #364)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if ((url as string).includes("/library/metadata/77")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            MediaContainer: {
              Metadata: [{
                type: "show",
                title: "Starfleet Academy",
                thumb: "/library/metadata/77/thumb/1234567890",
                Guid: [{ id: "imdb://tt1234567" }],
              }],
            },
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ MediaContainer: { machineIdentifier: "abc123" } }) });
    }));

    const { registerDisplayTitlesTool } = await import("@/lib/tools/display-titles-tool");
    const { executeTool } = await import("@/lib/tools/registry");
    registerDisplayTitlesTool();

    const raw = await executeTool("display_titles", JSON.stringify({
      titles: [{
        mediaType: "tv",
        title: "Starfleet Academy — Season 1",
        seasonNumber: 1,
        mediaStatus: "available",
        plexKey: "/library/metadata/77",
        // thumbPath intentionally absent — LLM dropped it
      }],
    }));
    const { displayTitles } = JSON.parse(raw) as { displayTitles: Array<{ thumbUrl?: string; imdbId?: string }> };
    // thumbPath recovered from Plex metadata and proxied through /api/plex/thumb
    expect(displayTitles[0].thumbUrl).toContain("/api/plex/thumb");
    expect(displayTitles[0].thumbUrl).toContain("1234567890");
    // imdbId also recovered in the same fetch
    expect(displayTitles[0].imdbId).toBe("tt1234567");
  });
});
