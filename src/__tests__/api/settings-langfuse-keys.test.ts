/**
 * Unit tests for GET /api/settings/langfuse-keys
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAdminSession = {
  sessionId: "test-session",
  user: { id: 1, plexId: "plex1", plexUsername: "admin", plexEmail: "a@b.com", plexAvatarUrl: null, isAdmin: true },
};
const mockUserSession = {
  sessionId: "test-session-2",
  user: { id: 2, plexId: "plex2", plexUsername: "user", plexEmail: "u@b.com", plexAvatarUrl: null, isAdmin: false },
};

const mockGetSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({ getSession: () => mockGetSession() }));

const mockGetConfig = vi.fn();
vi.mock("@/lib/config", () => ({ getConfig: (key: string) => mockGetConfig(key) }));

async function getRoute() {
  vi.resetModules();
  const mod = await import("@/app/api/settings/langfuse-keys/route");
  return mod.GET;
}

describe("GET /api/settings/langfuse-keys", () => {
  beforeEach(() => {
    mockGetSession.mockResolvedValue(mockAdminSession);
    mockGetConfig.mockReturnValue("");
  });

  it("returns 403 when not authenticated", async () => {
    mockGetSession.mockResolvedValue(null);
    const GET = await getRoute();
    const res = await GET();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("returns 403 for non-admin users", async () => {
    mockGetSession.mockResolvedValue(mockUserSession);
    const GET = await getRoute();
    const res = await GET();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("returns the real (unmasked) public and secret keys for admins", async () => {
    mockGetConfig.mockImplementation((key: string) => {
      if (key === "langfuse.publicKey") return "pk-lf-real-public-key";
      if (key === "langfuse.secretKey") return "sk-lf-real-secret-key";
      return "";
    });
    const GET = await getRoute();
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.publicKey).toBe("pk-lf-real-public-key");
    expect(body.data.secretKey).toBe("sk-lf-real-secret-key");
  });

  it("returns empty strings when no keys are configured", async () => {
    mockGetConfig.mockReturnValue("");
    const GET = await getRoute();
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.publicKey).toBe("");
    expect(body.data.secretKey).toBe("");
  });
});
