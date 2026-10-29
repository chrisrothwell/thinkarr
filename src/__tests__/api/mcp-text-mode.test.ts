/**
 * Integration tests for /api/mcp?mode=text covering:
 * - Unregistered channel user → returns registration URL
 * - display_titles interception → markdown text + pendingKey
 * - confirm_request happy path → Overseerr request submitted
 * - confirm_request blocked outside text mode
 * - overseerr_request_movie/tv blocked in text mode
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// --- shared mock state ---
let channelIdentityRow: { userId: number } | undefined;
let insertedRegToken: { token: string; channelType: string; channelUserId: string; expiresAt: number } | null = null;

const mockDbSelect = vi.fn();
const mockDbInsert = vi.fn();
const mockDbDelete = vi.fn();
const mockDbUpdate = vi.fn();

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: mockDbSelect,
    insert: mockDbInsert,
    delete: mockDbDelete,
    update: mockDbUpdate,
  }),
  schema: {
    users: { id: "id", plexId: "plex_id" },
    mcpChannelIdentities: { channelType: "channel_type", channelUserId: "channel_user_id", userId: "user_id" },
    mcpRegistrationTokens: { token: "token", channelType: "channel_type", channelUserId: "channel_user_id", expiresAt: "expires_at" },
    mcpPendingBaskets: { token: "token", itemsJson: "items_json", userId: "user_id", expiresAt: "expires_at" },
  },
}));

vi.mock("@/lib/config", () => ({
  getConfig: (key: string) => {
    if (key === "mcp.bearerToken") return "test-bearer";
    return null;
  },
  getUserIdByMcpToken: () => null,
}));

vi.mock("@/lib/tools/init", () => ({ initializeTools: vi.fn() }));
vi.mock("@/lib/tools/registry", () => ({
  hasTools: () => true,
  getOpenAITools: () => [],
  executeTool: vi.fn().mockImplementation(async (name: string) => {
    if (name === "display_titles") {
      return JSON.stringify({
        displayTitles: [
          { title: "Alien", year: 2024, mediaType: "movie", mediaStatus: "available" },
          { title: "Prometheus", year: 2012, mediaType: "movie", mediaStatus: "not_requested", overseerrId: 42, overseerrMediaType: "movie" },
        ],
      });
    }
    return JSON.stringify({ ok: true });
  }),
}));

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/auth/rate-limit", () => ({ getClientIp: () => "127.0.0.1" }));

vi.mock("@/lib/services/overseerr", () => ({
  requestMovie: vi.fn().mockResolvedValue({ success: true, message: "Movie request submitted successfully" }),
  requestTv: vi.fn().mockResolvedValue({ success: true, message: "TV show request submitted successfully" }),
}));

vi.mock("@/lib/tools/pending-basket", () => ({
  createBasket: vi.fn().mockImplementation((items: unknown[], userId: number) => {
    return "basket-token";
  }),
  resolveBasket: vi.fn().mockImplementation((token: string, selection: number, userId: number) => {
    if (token !== "basket-token" || userId !== 7) return null;
    return { overseerrId: 42, mediaType: "movie" as const, title: "Prometheus" };
  }),
}));

function makeRequest(opts: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Request {
  return new Request(opts.url ?? "http://localhost/api/mcp?mode=text", {
    method: opts.method ?? "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-bearer",
      ...opts.headers,
    },
    body: opts.body != null ? JSON.stringify(opts.body) : undefined,
  });
}

describe("/api/mcp?mode=text", () => {
  beforeEach(() => {
    insertedRegToken = null;
    vi.clearAllMocks();

    // Default DB mock: no identity, chain support
    mockDbSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          get: () => channelIdentityRow,
          orderBy: () => ({ get: () => insertedRegToken }),
        }),
      }),
    });
    mockDbInsert.mockReturnValue({
      values: (v: typeof insertedRegToken) => {
        insertedRegToken = v as typeof insertedRegToken;
        return { run: vi.fn() };
      },
    });
    mockDbDelete.mockReturnValue({ where: () => ({ run: vi.fn() }) });
  });

  it("returns registration URL when channel user is unregistered", async () => {
    channelIdentityRow = undefined;
    const { POST } = await import("@/app/api/mcp/route");
    const res = await POST(makeRequest({
      headers: { "x-channel-type": "whatsapp", "x-channel-user-id": "+447700900000" },
      body: { tool: "plex_get_on_deck", arguments: {} },
    }));
    const data = await res.json();
    expect(data.error).toBe("unregistered");
    expect(data.registrationUrl).toContain("/mcp/link?token=");
  });

  it("intercepts display_titles and returns markdown text with pendingKey", async () => {
    channelIdentityRow = { userId: 7 };
    mockDbSelect.mockReturnValue({
      from: () => ({
        where: () => ({ get: () => channelIdentityRow }),
      }),
    });
    // Second call for user lookup
    let callCount = 0;
    mockDbSelect.mockImplementation(() => ({
      from: () => ({
        where: () => ({
          get: () => {
            callCount++;
            if (callCount === 1) return channelIdentityRow;
            return { id: 7, isAdmin: false, plexUsername: "testuser" };
          },
        }),
      }),
    }));

    const { POST } = await import("@/app/api/mcp/route");
    const res = await POST(makeRequest({
      headers: { "x-channel-type": "whatsapp", "x-channel-user-id": "+447700900000" },
      body: { tool: "display_titles", arguments: { titles: [] } },
    }));
    const data = await res.json();
    expect(data.tool).toBe("display_titles");
    expect(data.result.text).toContain("✓ Available in Plex");
    expect(data.result.text).toContain("[1] *Prometheus*");
    expect(data.result.pendingKey).toBe("basket-token");
  });

  it("confirm_request submits an Overseerr request for the selected item", async () => {
    channelIdentityRow = { userId: 7 };
    let callCount = 0;
    mockDbSelect.mockImplementation(() => ({
      from: () => ({
        where: () => ({
          get: () => {
            callCount++;
            if (callCount === 1) return channelIdentityRow;
            return { id: 7, isAdmin: false, plexUsername: "testuser" };
          },
        }),
      }),
    }));

    const { POST } = await import("@/app/api/mcp/route");
    const res = await POST(makeRequest({
      headers: { "x-channel-type": "whatsapp", "x-channel-user-id": "+447700900000" },
      body: { tool: "confirm_request", arguments: { pendingKey: "basket-token", selection: 1 } },
    }));
    const data = await res.json();
    expect(data.result.success).toBe(true);
    expect(data.result.message).toContain("Prometheus");

    const { requestMovie } = await import("@/lib/services/overseerr");
    expect(requestMovie).toHaveBeenCalledWith(42);
  });

  it("confirm_request returns error for invalid/expired basket", async () => {
    channelIdentityRow = { userId: 7 };
    let callCount = 0;
    mockDbSelect.mockImplementation(() => ({
      from: () => ({
        where: () => ({
          get: () => {
            callCount++;
            if (callCount === 1) return channelIdentityRow;
            return { id: 7, isAdmin: false, plexUsername: "testuser" };
          },
        }),
      }),
    }));

    const { POST } = await import("@/app/api/mcp/route");
    const res = await POST(makeRequest({
      headers: { "x-channel-type": "whatsapp", "x-channel-user-id": "+447700900000" },
      body: { tool: "confirm_request", arguments: { pendingKey: "wrong-token", selection: 1 } },
    }));
    const data = await res.json();
    expect(data.result.success).toBe(false);
    expect(data.result.message).toContain("no longer valid");
  });

  it("blocks confirm_request outside text mode", async () => {
    const { POST } = await import("@/app/api/mcp/route");
    const res = await POST(makeRequest({
      url: "http://localhost/api/mcp",
      body: { tool: "confirm_request", arguments: { pendingKey: "x", selection: 1 } },
    }));
    expect(res.status).toBe(403);
  });

  it("blocks overseerr_request_movie in text mode", async () => {
    const { POST } = await import("@/app/api/mcp/route");
    const res = await POST(makeRequest({
      body: { tool: "overseerr_request_movie", arguments: { tmdbId: 1 } },
    }));
    expect(res.status).toBe(403);
  });

  it("blocks overseerr_request_tv in text mode", async () => {
    const { POST } = await import("@/app/api/mcp/route");
    const res = await POST(makeRequest({
      body: { tool: "overseerr_request_tv", arguments: { tvdbId: 1 } },
    }));
    expect(res.status).toBe(403);
  });
});
