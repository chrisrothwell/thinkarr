import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { z } from "zod";
import * as schema from "@/lib/db/schema";
import { createTestDb, seedUser, type TestDb } from "../helpers/db";

let db: TestDb;
let sqlite: Database.Database;
let adminId: number;
let userId: number;
const handler = vi.fn();
vi.mock("@/lib/db", () => ({ getDb: () => db, schema }));
vi.mock("@/lib/tools/init", () => ({ initializeTools: vi.fn() }));

import { GET, POST } from "@/app/api/mcp/route";
import { setConfig } from "@/lib/config";
import { defineTool } from "@/lib/tools/registry";
import { initializeTools } from "@/lib/tools/init";
import { createIntegration, issueServiceCredential, revokeServiceCredential } from "@/lib/mcp/service-principals";

function request(token: string, body?: unknown, options: { text?: boolean; headers?: Record<string, string> } = {}) {
  return new Request(`http://localhost/api/mcp${options.text ? "?mode=text" : ""}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token}`, "Content-Type": "application/json",
      Accept: "application/json, text/event-stream", ...options.headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function service() {
  const principal = createIntegration({ name: "Helga" }, adminId);
  const credential = issueServiceCredential(principal.id, {}, adminId);
  return { principal, credential };
}

beforeEach(() => {
  ({ db, sqlite } = createTestDb());
  adminId = seedUser(db, { isAdmin: true });
  userId = seedUser(db, { isAdmin: false });
  setConfig("mcp.bearerToken", "admin-fixture");
  setConfig(`user.${userId}.mcpToken`, "personal-fixture");
  handler.mockReset();
  handler.mockImplementation(async (args, context) => ({ args, context }));
  vi.mocked(initializeTools).mockClear();
  defineTool({ name: "plex_search_library", description: "Fixture", schema: z.object({ query: z.string().optional() }), handler });
});
afterEach(() => sqlite.close());

describe("service credentials cannot enter personal/admin MCP paths", () => {
  it.each([false, true])("blocks discovery and execution before any tool/channel dispatch (text mode %s)", async (text) => {
    const { credential } = service();
    const headers = {
      "X-User-Id": String(adminId), "X-Channel-Type": "whatsapp", "X-Channel-User-Id": "forged-sender",
      "Thinkarr-Delegation": "forged-assertion",
    };
    const bodies = [
      { method: "list" },
      { method: "tools/list" },
      { tool: "plex_get_on_deck", arguments: {} },
      { tool: "confirm_request", arguments: { userId: adminId, pendingKey: "fake", selection: 1 } },
      { jsonrpc: "2.0", method: "initialize", id: 1, params: {} },
      { jsonrpc: "2.0", method: "tools/list", id: 2 },
      { jsonrpc: "2.0", method: "tools/call", id: 3, params: { name: "plex_search_library", arguments: {} } },
    ];
    expect((await GET(request(credential.token, undefined, { text, headers }))).status).toBe(403);
    for (const body of bodies) {
      const response = await POST(request(credential.token, body, { text, headers }));
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain("plex_search_library");
    }
    expect(initializeTools).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(db.select().from(schema.mcpRegistrationTokens).all()).toHaveLength(0);
    const denials = db.select().from(schema.mcpServiceAudit).all().filter((row) => row.action === "service_access_denied");
    expect(denials).toHaveLength(bodies.length + 1);
    expect(denials.every((row) => row.actorUserId === null)).toBe(true);
  });

  it("cannot enable access by changing a stored flag before the delegated boundary exists", async () => {
    const { principal, credential } = service();
    db.update(schema.mcpServicePrincipals).set({ enabled: true }).where(eq(schema.mcpServicePrincipals.id, principal.id)).run();
    expect((await POST(request(credential.token, { tool: "plex_search_library" }))).status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it("never falls back to the global token when a reserved service token is copied into that config", async () => {
    const { principal, credential } = service();
    setConfig("mcp.bearerToken", credential.token);
    expect((await GET(request(credential.token))).status).toBe(403);
    revokeServiceCredential(principal.id, credential.id, adminId);
    expect((await GET(request(credential.token))).status).toBe(401);
    setConfig("mcp.bearerToken", "thk_svc_unknown");
    expect((await GET(request("thk_svc_unknown"))).status).toBe(401);
    expect(initializeTools).not.toHaveBeenCalled();
  });
});

describe("legacy personal/admin MCP access is retired", () => {
  it.each(["admin-fixture", "personal-fixture"])("rejects stored token %s in every mode, including existing channel identities", async (token) => {
    db.insert(schema.mcpChannelIdentities).values({ channelType: "whatsapp", channelUserId: "existing-sender", userId }).run();
    for (const text of [false, true]) {
      const headerVariants: Record<string, string>[] = [{}, {
        "X-User-Id": String(adminId), "X-Channel-Type": "whatsapp", "X-Channel-User-Id": "existing-sender",
        "Thinkarr-Delegation": "forged-assertion",
      }];
      for (const headers of headerVariants) {
        expect((await GET(request(token, undefined, { text, headers }))).status).toBe(401);
        for (const body of [
          { method: "list" },
          { method: "execute", tool: "plex_search_library", arguments: { userId: adminId } },
          { tool: "confirm_request", arguments: { pendingKey: "old-basket", selection: 1 } },
          { jsonrpc: "2.0", method: "initialize", id: 1, params: {} },
          { jsonrpc: "2.0", method: "tools/list", id: 2 },
          { jsonrpc: "2.0", method: "tools/call", id: 3, params: { name: "plex_search_library", arguments: {} } },
        ]) {
          const response = await POST(request(token, body, { text, headers }));
          expect(response.status).toBe(401);
          expect(response.headers.get("Cache-Control")).toBe("no-store");
          expect(await response.text()).not.toContain("plex_search_library");
        }
      }
    }
    expect(initializeTools).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(db.select().from(schema.mcpRegistrationTokens).all()).toHaveLength(0);
    expect(db.select().from(schema.mcpServiceAudit).all()).toHaveLength(0);
  });

  it("rejects a web session and forged delegation without a registered service bearer", async () => {
    const response = await POST(new Request("http://localhost/api/mcp", {
      method: "POST", headers: { Cookie: "thinkarr_session=fixture", "Thinkarr-Delegation": "forged-assertion" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }));
    expect(response.status).toBe(401);
    expect(initializeTools).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });
});
