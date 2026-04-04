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
