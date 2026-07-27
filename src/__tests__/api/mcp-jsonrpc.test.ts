/**
 * Unit tests for the spec-compliant MCP Streamable HTTP handling in
 * POST /api/mcp, implemented on top of the official @modelcontextprotocol/sdk
 * (#461): initialize handshake, tools/list, tools/call, and JSON-RPC
 * notification/error semantics — all via the real SDK `Server` +
 * `WebStandardStreamableHTTPServerTransport`, not a hand-rolled envelope.
 * Discriminated from the pre-existing legacy ad-hoc dispatch (still hand-rolled,
 * used by the OpenClaw text-channel adapter) by the presence of a
 * `jsonrpc: "2.0"` field on the request body.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({ get: () => ({ id: 7, isAdmin: false }) }),
      }),
    }),
    insert: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(),
  }),
  schema: {
    users: { id: "id" },
    mcpChannelIdentities: {},
    mcpRegistrationTokens: {},
    mcpPendingBaskets: {},
  },
}));

vi.mock("@/lib/config", () => ({
  getConfig: (key: string) => (key === "mcp.bearerToken" ? "test-bearer" : null),
  getUserIdByMcpToken: (token: string) => (token === "user-token" ? 7 : null),
}));

vi.mock("@/lib/tools/init", () => ({ initializeTools: vi.fn() }));

const SAMPLE_TOOL = {
  type: "function" as const,
  function: {
    name: "plex_search_library",
    description: "Search the Plex library.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
};

vi.mock("@/lib/tools/registry", () => ({
  hasTools: () => true,
  getOpenAITools: () => [SAMPLE_TOOL],
  executeTool: vi.fn().mockImplementation(async (name: string) => {
    if (name === "unknown_tool") return JSON.stringify({ error: 'Unknown tool: "unknown_tool".' });
    return JSON.stringify({ results: [{ title: "The Matrix" }] });
  }),
}));

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/auth/rate-limit", () => ({ getClientIp: () => "127.0.0.1" }));
vi.mock("@/lib/services/overseerr", () => ({ requestMovie: vi.fn(), requestTv: vi.fn() }));
vi.mock("@/lib/tools/pending-basket", () => ({ createBasket: vi.fn(), resolveBasket: vi.fn() }));
vi.mock("@/lib/tools/display-titles-text", () => ({ formatDisplayTitlesAsText: vi.fn() }));

function makeRequest(body: unknown, bearer = "test-bearer"): Request {
  return new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Required by the Streamable HTTP spec — the SDK's transport rejects
      // requests with 406 if this isn't present, same as any real MCP client sends.
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/mcp — JSON-RPC 2.0 envelope (#461)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("initialize returns server capabilities in a JSON-RPC envelope", async () => {
    const { POST } = await import("@/app/api/mcp/route");
    const res = await POST(makeRequest({
      jsonrpc: "2.0",
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client", version: "1.0" } },
      id: 1,
    }));
    const data = await res.json();

    expect(data.jsonrpc).toBe("2.0");
    expect(data.id).toBe(1);
    expect(data.result.protocolVersion).toBe("2025-06-18");
    expect(data.result.capabilities).toEqual({ tools: {} });
    expect(data.result.serverInfo.name).toBe("thinkarr");
  });

  it("notifications/initialized returns 202 with no body", async () => {
    const { POST } = await import("@/app/api/mcp/route");
    const res = await POST(makeRequest({ jsonrpc: "2.0", method: "notifications/initialized" }));

    expect(res.status).toBe(202);
    const text = await res.text();
    expect(text).toBe("");
  });

  it("tools/list returns MCP-shaped tool definitions in a JSON-RPC envelope", async () => {
    const { POST } = await import("@/app/api/mcp/route");
    const res = await POST(makeRequest({ jsonrpc: "2.0", method: "tools/list", id: 2 }));
    const data = await res.json();

    expect(data.jsonrpc).toBe("2.0");
    expect(data.id).toBe(2);
    expect(data.result.tools).toEqual([
      {
        name: "plex_search_library",
        description: "Search the Plex library.",
        inputSchema: SAMPLE_TOOL.function.parameters,
      },
    ]);
  });

  it("tools/call executes the tool and returns its result as text content", async () => {
    const { POST } = await import("@/app/api/mcp/route");
    const res = await POST(makeRequest({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "plex_search_library", arguments: { query: "matrix" } },
      id: 3,
    }));
    const data = await res.json();

    expect(data.jsonrpc).toBe("2.0");
    expect(data.id).toBe(3);
    expect(data.result.content[0].type).toBe("text");
    expect(JSON.parse(data.result.content[0].text)).toEqual({ results: [{ title: "The Matrix" }] });
    expect(data.result.isError).toBeUndefined();
  });

  it("tools/call with a missing name returns a JSON-RPC error, not a bare 400", async () => {
    const { POST } = await import("@/app/api/mcp/route");
    const res = await POST(makeRequest({ jsonrpc: "2.0", method: "tools/call", params: {}, id: 4 }));
    const data = await res.json();

    // The SDK validates params.name against its own schema before our handler
    // ever runs, and surfaces that failure as -32603 (not -32602) — verified
    // directly against the SDK rather than assumed.
    expect(data.jsonrpc).toBe("2.0");
    expect(data.id).toBe(4);
    expect(data.error.code).toBe(-32603);
  });

  it("tools/call denied by permission surfaces as a JSON-RPC InvalidParams error", async () => {
    const { POST } = await import("@/app/api/mcp/route");
    // "user-token" resolves (via the mocks above) to a non-admin user; any
    // tool name not on canExecuteTool's allowlist is admin-only.
    const res = await POST(
      makeRequest(
        { jsonrpc: "2.0", method: "tools/call", params: { name: "some_admin_only_tool", arguments: {} }, id: 6 },
        "user-token",
      ),
    );
    const data = await res.json();

    // Confirms runToolCall's "rejected" outcome surfaces as a clean McpError
    // (InvalidParams) via the SDK's own error handling, not as an uncaught
    // plain Error that would otherwise be swallowed into a generic -32603.
    expect(data.jsonrpc).toBe("2.0");
    expect(data.id).toBe(6);
    expect(data.error.code).toBe(-32602);
    expect(data.error.message).toMatch(/permission denied/i);
  });

  it("an unrecognized method with an id returns a JSON-RPC 'method not found' error", async () => {
    const { POST } = await import("@/app/api/mcp/route");
    const res = await POST(makeRequest({ jsonrpc: "2.0", method: "resources/list", id: 5 }));
    const data = await res.json();

    expect(data.error.code).toBe(-32601);
    expect(data.id).toBe(5);
  });

  it("an unrecognized notification (no id) is silently accepted with 202", async () => {
    const { POST } = await import("@/app/api/mcp/route");
    const res = await POST(makeRequest({ jsonrpc: "2.0", method: "some/unknown/notification" }));

    expect(res.status).toBe(202);
  });

  it("does not affect the legacy ad-hoc dispatch when jsonrpc field is absent", async () => {
    const { POST } = await import("@/app/api/mcp/route");
    const res = await POST(makeRequest({ method: "tools/list" }));
    const data = await res.json();

    // Legacy shape: bare { tools: [...] }, no jsonrpc/id envelope
    expect(data.jsonrpc).toBeUndefined();
    expect(Array.isArray(data.tools)).toBe(true);
  });
});
