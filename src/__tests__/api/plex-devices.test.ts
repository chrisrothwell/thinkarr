/**
 * Unit tests for GET /api/settings/plex-devices (#457).
 *
 * Covers the success-path logging added after investigating a report of
 * "0 connections" in Discover Servers: plex.tv can return a server resource
 * with an empty connection array even when the server itself is reachable
 * (usually because it isn't publishing itself on plex.tv). This logging
 * makes that diagnosable from /beta-logs without needing a live repro.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(async () => ({ user: { id: 1, isAdmin: true } })),
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ where: () => ({ get: () => ({ plexToken: "account-token" }) }) }) }),
  }),
  schema: { users: { id: "id", plexToken: "plex_token" } },
}));

const { logInfoSpy } = vi.hoisted(() => ({ logInfoSpy: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { info: logInfoSpy, warn: vi.fn(), error: vi.fn() } }));

vi.mock("@/lib/services/plex-auth", () => ({
  getPlexDevices: vi.fn(async () => [
    { name: "Unpublished Server", clientIdentifier: "abc", accessToken: "tok", owned: true, connections: [] },
  ]),
}));

import { GET } from "@/app/api/settings/plex-devices/route";

describe("GET /api/settings/plex-devices", () => {
  beforeEach(() => {
    logInfoSpy.mockClear();
  });

  it("logs a per-server connection-count summary without leaking tokens", async () => {
    const res = await GET();
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].connections).toEqual([]);

    expect(logInfoSpy).toHaveBeenCalledWith(
      "Plex device discovery",
      expect.objectContaining({
        servers: [
          expect.objectContaining({ name: "Unpublished Server", clientIdentifier: "abc", connectionCount: 0 }),
        ],
      }),
    );

    const loggedPayload = JSON.stringify(logInfoSpy.mock.calls[0]);
    expect(loggedPayload).not.toContain("tok");
    expect(loggedPayload).not.toContain("account-token");
  });
});
