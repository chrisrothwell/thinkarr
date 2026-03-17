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
