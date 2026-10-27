import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import * as schema from "@/lib/db/schema";
import { createTestDb, seedUser, type TestDb } from "../helpers/db";
import { delegatedLinkFixture } from "../helpers/delegated-link";

let db: TestDb;
let sqlite: Database.Database;
let adminId: number;
vi.mock("@/lib/db", () => ({ getDb: () => db, schema }));
vi.mock("@/lib/tools/init", () => ({ initializeTools: vi.fn() }));
vi.mock("@/lib/tools/registry", () => ({
  getOpenAITools: vi.fn(() => []), hasTools: () => true,
  executeTool: vi.fn(async () => JSON.stringify({ unexpected: true })),
}));

import { GET, POST } from "@/app/api/mcp/route";
import { initializeTools } from "@/lib/tools/init";
import { executeTool, getOpenAITools } from "@/lib/tools/registry";
import { setConfig } from "@/lib/config";
import { prepareAccountLink, resolveServiceActor } from "@/lib/mcp/account-linking";
import { revokeServiceCredential, revokeServiceKey } from "@/lib/mcp/service-principals";

const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
const call = (name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
beforeEach(() => {
  ({ db, sqlite } = createTestDb());
  adminId = seedUser(db, { isAdmin: true });
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-20T08:00:00Z"));
  vi.clearAllMocks();
});
afterEach(() => { sqlite.close(); vi.useRealTimers(); });

function expectNoRawTools() {
  expect(initializeTools).not.toHaveBeenCalled();
  expect(getOpenAITools).not.toHaveBeenCalled();
  expect(executeTool).not.toHaveBeenCalled();
}

describe("linking-only delegated MCP", () => {
  it("returns a bounded operation-grant reason only for a verified, well-shaped linking call and reuses existing enrollment after repair", async () => {
    const f = await delegatedLinkFixture(db, adminId);
    db.update(schema.mcpServicePrincipals).set({ allowedOperations: "[]" }).where(eq(schema.mcpServicePrincipals.id, f.principal.id)).run();
    const denied = await POST(await f.signedRequest(call("account_link_start")));
    expect(denied.status).toBe(403); expect(denied.headers.get("X-Thinkarr-Error-Code")).toBe("operation_not_allowed");
    expect(denied.headers.get("Cache-Control")).toBe("no-store");
    expect(await denied.json()).toEqual({ error: "Delegated MCP operation is not permitted.", code: "operation_not_allowed" });
    expect(db.select().from(schema.mcpLinkChallenges).all()).toHaveLength(0);
    for (const body of [call("account_link_start", { userId: adminId }), call("account_link_confirm", { code: "a".repeat(64) }), call("unknown_tool")]) {
      const invalid = await POST(await f.signedRequest(body));
      expect(invalid.status).toBe(403); expect(invalid.headers.get("X-Thinkarr-Error-Code")).toBeNull();
      expect(await invalid.json()).toEqual({ error: "Delegated MCP operation is not permitted." });
    }
    const unsigned = await f.signedRequest(call("account_link_start")); unsigned.headers.delete("Thinkarr-Delegation");
    const invalidProof = await POST(unsigned); expect(invalidProof.status).toBe(403);
    expect(invalidProof.headers.get("X-Thinkarr-Error-Code")).toBeNull();
    db.update(schema.mcpServicePrincipals).set({ allowedOperations: JSON.stringify(["account_link_start", "account_link_confirm"]) }).where(eq(schema.mcpServicePrincipals.id, f.principal.id)).run();
    expect((await POST(await f.signedRequest(call("account_link_start")))).status).toBe(200);
    expect(db.select().from(schema.mcpLinkChallenges).all()).toHaveLength(1);
    expectNoRawTools();
  });
  it("preserves the pending challenge when completion permission is missing and completes with the same enrollment after the grant is repaired", async () => {
    const f = await delegatedLinkFixture(db, adminId);
    const started = await (await POST(await f.signedRequest(call("account_link_start")))).json();
    const token = new URL(started.result._meta["thinkarr/private-delivery"].url).hash.replace("#token=", "");
    const code = prepareAccountLink(token, f.sessionA, f.userA).completionCode;
    const claims = { source: "message" as const, kind: "direct" as const, conversation: "private-A", intent: `link-confirm:${code}`, eventId: randomUUID(), eventTime: Date.now() };
    db.update(schema.mcpServicePrincipals).set({ allowedOperations: JSON.stringify(["account_link_start"]) }).where(eq(schema.mcpServicePrincipals.id, f.principal.id)).run();
    const denied = await POST(await f.signedRequest(call("account_link_confirm", { code }), claims));
    expect(denied.status).toBe(403); expect(denied.headers.get("X-Thinkarr-Error-Code")).toBe("operation_not_allowed");
    expect(db.select().from(schema.mcpActorBindings).all()).toHaveLength(0); expect(db.select().from(schema.mcpDelegationEvents).all()).toHaveLength(0);
    db.update(schema.mcpServicePrincipals).set({ allowedOperations: JSON.stringify(["account_link_start", "account_link_confirm"]) }).where(eq(schema.mcpServicePrincipals.id, f.principal.id)).run();
    expect((await POST(await f.signedRequest(call("account_link_confirm", { code }), claims))).status).toBe(200);
    expect(resolveServiceActor(await f.context()).actorUserId).toBe(f.userA);
    expect(db.select().from(schema.mcpLinkChallenges).all()).toHaveLength(1); expectNoRawTools();
  });
  it("performs real SDK initialization/list/call with no private URL in model-facing content", async () => {
    const f = await delegatedLinkFixture(db, adminId);
    const client = new Client({ name: "trusted-connector-fixture", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL("https://thinkarr.invalid/api/mcp"), {
      fetch: async (input, init) => {
        const original = new Request(input, init);
        const signed = await f.signedRequest(await original.text());
        const headers = new Headers(original.headers);
        for (const [name, value] of signed.headers) headers.set(name, value);
        return POST(new Request(signed, { headers }));
      },
    });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["account_link_start"]);
      const result = CallToolResultSchema.parse(await client.callTool({ name: "account_link_start", arguments: {} }));
      expect(JSON.parse(result.content[0].type === "text" ? result.content[0].text : "null")).toEqual({ linked: false, privateDeliveryRequired: true });
      const delivery = result._meta?.["thinkarr/private-delivery"] as { channel: string; account: string; recipient: string; url: string; expiresAt: string };
      expect(delivery).toMatchObject({ channel: "whatsapp", account: "account-A", recipient: "sender-A" });
      const url = new URL(delivery.url);
      expect(url.origin).toBe("https://thinkarr.invalid");
      expect(url.pathname).toBe("/mcp/connect");
      expect(url.search).toBe("");
      expect(url.hash).toMatch(/^#token=[a-f0-9]{64}$/);
      const model = JSON.stringify({ content: result.content, structuredContent: result.structuredContent });
      for (const value of [delivery.url, "sender-A", "account-A", "private message sent"]) expect(model).not.toContain(value);
      expect(db.select().from(schema.mcpLinkChallenges).all()).toHaveLength(1);
      expectNoRawTools();
    } finally { await client.close(); }
  });

  it("only advertises and executes completion for matching signed private-message intent", async () => {
    const f = await delegatedLinkFixture(db, adminId);
    const started = await (await POST(await f.signedRequest(call("account_link_start")))).json();
    const token = new URL(started.result._meta["thinkarr/private-delivery"].url).hash.replace("#token=", "");
    const code = prepareAccountLink(token, f.sessionA, f.userA).completionCode;
    const privateClaims = { source: "message" as const, kind: "direct" as const, conversation: "private-A", intent: `link-confirm:${code}`, eventId: randomUUID(), eventTime: Date.now() };
    const listed = await (await POST(await f.signedRequest(list, privateClaims))).json();
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["account_link_confirm"]);
    const completed = await POST(await f.signedRequest(call("account_link_confirm", { code }), privateClaims));
    expect(completed.status).toBe(200);
    const result = (await completed.json()).result;
    expect(result._meta).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ linked: true });
    expect(resolveServiceActor(await f.context()).actorUserId).toBe(f.userA);
    // A new HTTP nonce cannot reuse the provider event for a new challenge.
    const binding = db.select().from(schema.mcpActorBindings).get()!;
    db.update(schema.mcpActorBindings).set({ revokedAt: new Date() }).where(eq(schema.mcpActorBindings.id, binding.id)).run();
    const restarted = await (await POST(await f.signedRequest(call("account_link_start")))).json();
    const nextToken = new URL(restarted.result._meta["thinkarr/private-delivery"].url).hash.replace("#token=", "");
    const nextCode = prepareAccountLink(nextToken, f.sessionA, f.userA).completionCode;
    const replay = await POST(await f.signedRequest(call("account_link_confirm", { code: nextCode }), { ...privateClaims, intent: `link-confirm:${nextCode}` }));
    expect(replay.status).toBe(403);
    expect(db.select().from(schema.mcpActorBindings).get()!.revokedAt).not.toBeNull();
    expect(db.select().from(schema.mcpDelegationEvents).all()).toHaveLength(1);
    expectNoRawTools();
  });

  it.each([false, true])("rejects direct raw/media/finance/issue calls and mangled names regardless of stored allowlist (text %s)", async (text) => {
    const f = await delegatedLinkFixture(db, adminId);
    db.update(schema.mcpServicePrincipals).set({ allowedOperations: JSON.stringify(["account_link_start", "account_link_confirm", "media_search", "media_confirm_request"]) }).where(eq(schema.mcpServicePrincipals.id, f.principal.id)).run();
    for (const name of ["media_search", "media_confirm_request", "confirm_request", "plex_get_on_deck", "overseerr_list_requests", "sonarr_get_queue", "overseerr_report_issue", "splitwise_add_expense", "AccountLinkStart", "account_link_start_admin"]) {
      const response = await POST(await f.signedRequest(call(name), {}, `/api/mcp${text ? "?mode=text" : ""}`));
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain(name);
    }
    expect(db.select().from(schema.mcpLinkChallenges).all()).toHaveLength(0);
    expectNoRawTools();
  });

  it("ignores legacy/admin impersonation headers and rejects identity/recipient selectors in arguments", async () => {
    const f = await delegatedLinkFixture(db, adminId);
    setConfig("mcp.bearerToken", f.credential.token);
    for (const args of [{ userId: adminId }, { requestedBy: adminId }, { recipient: "someone-else" }, { groupId: "other-group" }]) {
      const request = await f.signedRequest(call("account_link_start", args));
      request.headers.set("X-User-Id", String(adminId));
      request.headers.set("X-Channel-Type", "whatsapp"); request.headers.set("X-Channel-User-Id", "forged-sender");
      expect((await POST(request)).status).toBe(403);
    }
    expect(db.select().from(schema.mcpRegistrationTokens).all()).toHaveLength(0);
    expect(db.select().from(schema.mcpLinkChallenges).all()).toHaveLength(0);
    expectNoRawTools();
  });

  it("requires authenticated per-call metadata and never accepts legacy/batch/notification writes", async () => {
    const f = await delegatedLinkFixture(db, adminId);
    const request = await f.signedRequest(call("account_link_start")); request.headers.delete("Thinkarr-Delegation");
    expect((await POST(request)).status).toBe(403);
    for (const body of [
      { tool: "account_link_start", arguments: {} }, [call("account_link_start")],
      { jsonrpc: "2.0", method: "tools/call", params: { name: "account_link_start", arguments: {} } },
      { jsonrpc: "2.0", id: 3, method: "resources/list" },
    ]) expect((await POST(await f.signedRequest(body))).status).toBe(403);
    expect((await GET(new Request("https://thinkarr.invalid/api/mcp", { headers: { Authorization: `Bearer ${f.credential.token}` } }))).status).toBe(403);
    expect(db.select().from(schema.mcpLinkChallenges).all()).toHaveLength(0);
    expectNoRawTools();
  });

  it("rejects absent/wrong-source completion and a valid proof belonging to another sender with HTTP 403", async () => {
    const f = await delegatedLinkFixture(db, adminId);
    const started = await (await POST(await f.signedRequest(call("account_link_start")))).json();
    const token = new URL(started.result._meta["thinkarr/private-delivery"].url).hash.replace("#token=", "");
    const code = prepareAccountLink(token, f.sessionA, f.userA).completionCode;
    expect((await POST(await f.signedRequest(call("account_link_confirm", { code })))).status).toBe(403);
    const claims = { source: "message" as const, kind: "direct" as const, conversation: "private-A", intent: `link-confirm:${code}`, eventId: randomUUID(), eventTime: Date.now() };
    expect((await POST(await f.signedRequest(call("account_link_confirm", { code: "a".repeat(64) }), claims))).status).toBe(403);
    expect((await POST(await f.signedRequest(call("account_link_confirm", { code }), { ...claims, sender: "sender-B" }))).status).toBe(403);
    expect(db.select().from(schema.mcpActorBindings).all()).toHaveLength(0);
    expect(db.select().from(schema.mcpDelegationEvents).all()).toHaveLength(0);
  });

  it.each(["credential", "key", "principal"] as const)("checks %s revocation and does not fall back to a global token", async (target) => {
    const f = await delegatedLinkFixture(db, adminId);
    const request = await f.signedRequest(call("account_link_start"));
    setConfig("mcp.bearerToken", f.credential.token);
    if (target === "credential") revokeServiceCredential(f.principal.id, f.credential.id, adminId);
    if (target === "key") revokeServiceKey(f.principal.id, f.key.id, adminId);
    if (target === "principal") db.update(schema.mcpServicePrincipals).set({ enabled: false }).where(eq(schema.mcpServicePrincipals.id, f.principal.id)).run();
    expect([401, 403]).toContain((await POST(request)).status);
    expect(db.select().from(schema.mcpLinkChallenges).all()).toHaveLength(0);
    expectNoRawTools();
  });

  it("uses current service scope for both discovery and direct calls", async () => {
    const f = await delegatedLinkFixture(db, adminId);
    db.update(schema.mcpServicePrincipals).set({ allowedOperations: "[]" }).where(eq(schema.mcpServicePrincipals.id, f.principal.id)).run();
    expect((await (await POST(await f.signedRequest(list))).json()).result.tools).toEqual([]);
    expect((await POST(await f.signedRequest(call("account_link_start")))).status).toBe(403);
    expectNoRawTools();
  });

  it("rejects replayed and altered signed requests without creating another challenge", async () => {
    const f = await delegatedLinkFixture(db, adminId);
    const first = await f.signedRequest(call("account_link_start")); const replay = first.clone();
    expect((await POST(first)).status).toBe(200);
    expect((await POST(replay)).status).toBe(403);
    const request = await f.signedRequest(call("account_link_start"));
    const altered = new Request(request.url + "?mode=text", { method: "POST", headers: request.headers, body: await request.text() });
    expect((await POST(altered)).status).toBe(403);
    expect(db.select().from(schema.mcpLinkChallenges).all()).toHaveLength(1);
  });

  it("lets the official SDK reject bad HTTP negotiation before any link side effect", async () => {
    const f = await delegatedLinkFixture(db, adminId);
    const request = await f.signedRequest(call("account_link_start")); request.headers.set("Accept", "text/html");
    expect((await POST(request)).status).toBe(406);
    expect(db.select().from(schema.mcpLinkChallenges).all()).toHaveLength(0);
    expectNoRawTools();
  });

  it("allows only the launch channel and exact command intent, with bounded request bodies", async () => {
    const f = await delegatedLinkFixture(db, adminId);
    for (const claims of [
      { channel: "telegram" },
      { source: "command" as const, intent: "link-start-other" },
      { source: "message" as const, eventId: randomUUID(), eventTime: Date.now() },
    ]) expect((await POST(await f.signedRequest(call("account_link_start"), claims))).status).toBe(403);
    expect((await POST(await f.signedRequest(" ".repeat(65537)))).status).toBe(413);
    expect(db.select().from(schema.mcpLinkChallenges).all()).toHaveLength(0);
    expect((await POST(await f.signedRequest(call("account_link_start"), { source: "command", intent: "link-start" }))).status).toBe(200);
    expect(db.select().from(schema.mcpLinkChallenges).all()).toHaveLength(1);
    expectNoRawTools();
  });
});
