/**
 * Unit tests for GET /api/tmdb/thumb
 *
 * Covers:
 *   - Requires authentication
 *   - Rejects missing or invalid URL parameters
 *   - Rejects non-TMDB hostnames (open-proxy prevention)
 *   - Rejects non-HTTPS URLs
 *   - Proxies valid image.tmdb.org URLs successfully
 *   - Returns 502 on upstream fetch failure
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSession = {
  sessionId: "test-session",
  user: { id: 1, plexId: "p1", plexUsername: "user", plexEmail: null, plexAvatarUrl: null, isAdmin: false },
};
const mockGetSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({ getSession: () => mockGetSession() }));

function makeRequest(url: string): Request {
  return new Request(url);
}

describe("GET /api/tmdb/thumb", () => {
  beforeEach(() => {
    vi.resetModules();
    mockGetSession.mockResolvedValue(mockSession);
  });

  it("returns 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const { GET } = await import("@/app/api/tmdb/thumb/route");
    const res = await GET(makeRequest("http://localhost/api/tmdb/thumb?url=https://image.tmdb.org/t/p/w300/poster.jpg"));
    expect(res.status).toBe(401);
  });

  it("returns 400 when url parameter is missing", async () => {
    const { GET } = await import("@/app/api/tmdb/thumb/route");
    const res = await GET(makeRequest("http://localhost/api/tmdb/thumb"));
    expect(res.status).toBe(400);
  });

  it("returns 400 for a non-TMDB hostname", async () => {
    const { GET } = await import("@/app/api/tmdb/thumb/route");
    const res = await GET(makeRequest("http://localhost/api/tmdb/thumb?url=https://evil.com/image.jpg"));
    expect(res.status).toBe(400);
  });

  it("returns 400 for an HTTP (non-HTTPS) TMDB URL", async () => {
    const { GET } = await import("@/app/api/tmdb/thumb/route");
    const res = await GET(makeRequest("http://localhost/api/tmdb/thumb?url=http://image.tmdb.org/t/p/w300/poster.jpg"));
    expect(res.status).toBe(400);
  });

  it("returns 400 for a malformed URL", async () => {
    const { GET } = await import("@/app/api/tmdb/thumb/route");
    const res = await GET(makeRequest("http://localhost/api/tmdb/thumb?url=not-a-url"));
    expect(res.status).toBe(400);
  });

  it("proxies a valid image.tmdb.org URL and returns image data", async () => {
    const fakeImageData = new Uint8Array([0xff, 0xd8, 0xff]).buffer; // fake JPEG bytes
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => "image/jpeg" },
      arrayBuffer: async () => fakeImageData,
    }));

    const { GET } = await import("@/app/api/tmdb/thumb/route");
    const encodedUrl = encodeURIComponent("https://image.tmdb.org/t/p/w300/poster.jpg");
    const res = await GET(makeRequest(`http://localhost/api/tmdb/thumb?url=${encodedUrl}`));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toContain("max-age=86400");
  });

  it("returns 502 when upstream fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    const { GET } = await import("@/app/api/tmdb/thumb/route");
    const encodedUrl = encodeURIComponent("https://image.tmdb.org/t/p/w300/poster.jpg");
    const res = await GET(makeRequest(`http://localhost/api/tmdb/thumb?url=${encodedUrl}`));

    expect(res.status).toBe(502);
  });

  it("returns upstream status when TMDB returns an error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: { get: () => null },
    }));

    const { GET } = await import("@/app/api/tmdb/thumb/route");
    const encodedUrl = encodeURIComponent("https://image.tmdb.org/t/p/w300/not-found.jpg");
    const res = await GET(makeRequest(`http://localhost/api/tmdb/thumb?url=${encodedUrl}`));

    expect(res.status).toBe(404);
  });
});
