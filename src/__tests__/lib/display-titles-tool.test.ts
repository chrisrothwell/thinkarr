/**
 * Unit tests for display-titles-tool.ts — issue #117:
 * When an Overseerr result is "available" but has no plexKey, the tool should
 * perform a side-query to Plex and inject the matching plexKey so the Watch Now
 * button can be rendered.
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
});
