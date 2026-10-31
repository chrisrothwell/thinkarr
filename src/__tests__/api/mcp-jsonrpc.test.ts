/** JSON-RPC remains supported only through the signed service dispatcher.
 * These formerly accepted generic exchanges must now fail before dispatch;
 * the real SDK's signed handshake/list/call coverage lives in mcp-link-dispatch.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config", () => ({
  getConfig: vi.fn(() => "test-bearer"),
  getUserIdByMcpToken: vi.fn(() => 7),
}));
vi.mock("@/lib/tools/init", () => ({ initializeTools: vi.fn() }));
vi.mock("@/lib/tools/registry", () => ({ executeTool: vi.fn() }));
import { POST } from "@/app/api/mcp/route";
import { getConfig, getUserIdByMcpToken } from "@/lib/config";
import { initializeTools } from "@/lib/tools/init";
import { executeTool } from "@/lib/tools/registry";

describe("generic JSON-RPC cannot bypass registered MCP authentication", () => {
  beforeEach(() => vi.clearAllMocks());
  const exchanges = [
    { jsonrpc: "2.0", method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "generic", version: "1" } }, id: 1 },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", method: "tools/list", id: 2 },
    { jsonrpc: "2.0", method: "tools/call", params: { name: "plex_search_library", arguments: { query: "matrix" } }, id: 3 },
    { jsonrpc: "2.0", method: "tools/call", params: {}, id: 4 },
    { jsonrpc: "2.0", method: "resources/list", id: 5 },
    { jsonrpc: "2.0", method: "some/unknown/notification" },
    { method: "tools/list" },
  ];

  it.each(exchanges)("rejects $method before protocol or legacy token lookup", async (body) => {
    for (const mode of ["", "?mode=text"]) {
      for (const bearer of ["test-bearer", "user-token"]) {
        const response = await POST(new Request(`http://localhost/api/mcp${mode}`, {
          method: "POST", headers: {
            "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${bearer}`,
          }, body: JSON.stringify(body),
        }));
        expect(response.status).toBe(401);
        const payload = await response.json();
        expect(payload.result).toBeUndefined();
        expect(payload.tools).toBeUndefined();
      }
    }
    expect(getConfig).not.toHaveBeenCalled();
    expect(getUserIdByMcpToken).not.toHaveBeenCalled();
    expect(initializeTools).not.toHaveBeenCalled();
    expect(executeTool).not.toHaveBeenCalled();
  });
});
