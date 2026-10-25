import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { decodeJwt } from "jose";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import * as schema from "@/lib/db/schema";
import { createTestDb, seedUser, type TestDb } from "../helpers/db";
import { delegatedLinkFixture } from "../helpers/delegated-link";
import { createLinkingConnector } from "../../../connectors/delegated-mcp/linking";
import { createDiagnosticTrace } from "../../../connectors/delegated-mcp/diagnostics";
import { MCP_REQUEST_ID_HEADER, MCP_TIMING_DEBUG_HEADER, parseMcpRequestId, readMcpServerDuration } from "../../../connectors/delegated-mcp/http-diagnostics";

let db: TestDb; let sqlite: Database.Database; let adminId: number;
vi.mock("@/lib/db", () => ({ getDb: () => db, schema }));
vi.mock("@/lib/tools/init", () => ({ initializeTools: vi.fn() }));
vi.mock("@/lib/tools/registry", () => ({ getOpenAITools: vi.fn(() => []), hasTools: () => true, executeTool: vi.fn() }));
import { POST } from "@/app/api/mcp/route";
import { logger } from "@/lib/logger";
import { getDelegationAudience } from "@/lib/mcp/delegation";
const timings = () => (vi.mocked(logger.info).mock.calls as unknown[][])
  .flatMap(([event, fields]) => event === "MCP_HTTP_TIMING" && fields && typeof fields === "object" ? [fields as Record<string, unknown>] : []);
beforeEach(() => { ({ db, sqlite } = createTestDb()); adminId = seedUser(db, { isAdmin: true }); vi.clearAllMocks(); });
afterEach(() => { sqlite.close(); });
const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };

describe("correlated delegated MCP HTTP timings", () => {
  it("correlates the real signed handshake/tool exchanges and records both response boundaries without sensitive data", async () => {
    const f = await delegatedLinkFixture(db, adminId); const lines: string[] = []; const ids: string[] = []; const nonces: string[] = []; let privateUrl = "";
    const trace = createDiagnosticTrace({ info: (s) => lines.push(s), warn: (s) => lines.push(s), error: (s) => lines.push(s) }, true, "link_start");
    const connector = await createLinkingConnector({ endpoint: "https://thinkarr.invalid/api/mcp", publicLinkOrigin: "https://thinkarr.invalid",
      service: f.principal.id, issuer: f.key.issuer, audience: getDelegationAudience(), keyId: f.key.keyId,
      bearer: f.credential.token, privateKeyPem: f.privateKeyPem,
    }, { debugTimings: true, diagnostics: trace.log,
      sendPrivate: async (delivery) => { privateUrl = delivery.url; return { accepted: true, channel: "whatsapp", account: delivery.account, recipient: delivery.recipient, messageId: "private-receipt" }; },
      fetch: async (input, init) => {
        const request = new Request(input, init); const id = request.headers.get(MCP_REQUEST_ID_HEADER)!;
        expect(parseMcpRequestId(id)).toBe(id); expect(request.headers.get(MCP_TIMING_DEBUG_HEADER)).toBe("1"); ids.push(id);
        const nonce = decodeJwt(request.headers.get("Thinkarr-Delegation")!).jti!; nonces.push(nonce); expect(id).not.toBe(nonce);
        const response = await POST(request);
        expect(response.headers.get(MCP_REQUEST_ID_HEADER)).toBe(id);
        expect(readMcpServerDuration(response.headers.get("Server-Timing"))).toBeTypeOf("number");
        return response;
      },
    });
    expect(await connector.startLink({ channel: "whatsapp", account: "account-A", sender: "sender-A", kind: "group", conversation: "group-A", assertCurrent: () => {} })).toEqual({ status: "private_link_sent" });
    expect(new Set(ids).size).toBe(3);
    const client = lines.map((line) => JSON.parse(line.slice("[thinkarr] ".length)));
    expect(client.filter((r) => r.stage === "mcp.http.body_complete")).toHaveLength(3);
    for (const id of ids) {
      const server = timings().filter((r) => r.requestId === id);
      expect(server[0]).toMatchObject({ stage: "request_received", timestampUtc: expect.any(String) });
      expect(server.at(-1)).toMatchObject({ stage: "request_completed", httpStatus: expect.any(Number), durationMs: expect.any(Number) });
      for (const phase of ["authentication", "body_read", "delegation", "delegation_key", "signature_verify", "nonce_claim", "envelope", "sdk_connect", "sdk_dispatch", "response_body", "cleanup"]) {
        expect(server.some((r) => r.stage === `${phase}_start`)).toBe(true);
        expect(server.some((r) => r.stage === `${phase}_end` && typeof r.durationMs === "number")).toBe(true);
      }
      expect(client.find((r) => r.requestId === id && r.stage === "mcp.http.response")).toMatchObject({ responseRequestId: id, httpDurationMs: expect.any(Number), serverDurationMs: expect.any(Number), outsideHandlerMs: expect.any(Number), serverTimingAvailable: true });
    }
    const raw = JSON.stringify([timings(), client]);
    for (const value of [f.credential.token, f.privateKeyPem, f.principal.id, "sender-A", "account-A", "group-A", privateUrl, ...nonces]) expect(raw).not.toContain(value);
    expect(timings().some((r) => r.stage === "tool_handler_end")).toBe(true);
  });
  it("keeps request summaries and timing headers without requesting detailed server stages", async () => {
    const f = await delegatedLinkFixture(db, adminId); const request = await f.signedRequest(list); const id = randomUUID();
    request.headers.set(MCP_REQUEST_ID_HEADER, id);
    const response = await POST(request);
    expect(response.status).toBe(200); expect(response.headers.get(MCP_REQUEST_ID_HEADER)).toBe(id);
    expect(response.headers.get("Server-Timing")).toContain("mcp_signature_verify;dur=");
    expect(timings().map((r) => r.stage)).toEqual(["request_received", "request_completed"]);
  });
  it("does not log untrusted request IDs or allow diagnostic headers to authorize a bad credential", async () => {
    const secret = "SECRET_MUST_NOT_APPEAR";
    const response = await POST(new Request("https://thinkarr.invalid/api/mcp", { method: "POST", headers: {
      Authorization: "Bearer thk_svc_invalid", [MCP_REQUEST_ID_HEADER]: secret, [MCP_TIMING_DEBUG_HEADER]: "1",
    }, body: secret }));
    expect(response.status).toBe(401); expect(parseMcpRequestId(response.headers.get(MCP_REQUEST_ID_HEADER))).toBeDefined();
    expect(JSON.stringify(timings())).not.toContain(secret);
    expect(timings().map((r) => r.stage)).not.toContain("body_read_start");
  });
  it("finishes timing a rejected signature without logging the assertion or creating a challenge", async () => {
    const f = await delegatedLinkFixture(db, adminId); const request = await f.signedRequest(list);
    request.headers.set("Thinkarr-Delegation", "SECRET_INVALID_ASSERTION"); request.headers.set(MCP_TIMING_DEBUG_HEADER, "1");
    const response = await POST(request);
    expect(response.status).toBe(403);
    expect(timings().find((r) => r.stage === "delegation_key_end")).toMatchObject({ failed: true });
    expect(timings().at(-1)).toMatchObject({ stage: "request_completed", httpStatus: 403 });
    expect(JSON.stringify(timings())).not.toContain("SECRET_INVALID_ASSERTION");
    expect(db.select().from(schema.mcpLinkChallenges).all()).toHaveLength(0);
  });
  it("includes awaited SDK cleanup in the server total and exposes a cleanup stall before returning", async () => {
    const f = await delegatedLinkFixture(db, adminId); const request = await f.signedRequest(list); request.headers.set(MCP_TIMING_DEBUG_HEADER, "1");
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    let clock = 0; const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
    const original = Server.prototype.close;
    const close = vi.spyOn(Server.prototype, "close").mockImplementation(async function (this: Server) { entered.resolve(); await release.promise; return original.call(this); });
    const pending = POST(request);
    try {
      await entered.promise;
      expect(timings().some((r) => r.stage === "cleanup_start")).toBe(true);
      expect(timings().some((r) => r.stage === "request_completed")).toBe(false);
      clock = 250; release.resolve(); const response = await pending;
      expect(readMcpServerDuration(response.headers.get("Server-Timing"))).toBe(250);
      expect(timings().find((r) => r.stage === "cleanup_end")).toMatchObject({ durationMs: 250 });
    } finally { release.resolve(); await pending.catch(() => {}); close.mockRestore(); now.mockRestore(); }
  });
  it("does not break an authenticated request when the timing logger throws", async () => {
    const f = await delegatedLinkFixture(db, adminId); const request = await f.signedRequest(list); request.headers.set(MCP_TIMING_DEBUG_HEADER, "1");
    const info = vi.spyOn(logger, "info").mockImplementation((...args: unknown[]) => { if (args[0] === "MCP_HTTP_TIMING") throw new Error("SECRET LOGGER FAILURE"); return logger; });
    try { expect((await POST(request)).status).toBe(200); } finally { info.mockRestore(); }
  });
  it("records a client abort during cleanup without logging its reason or changing the completed response", async () => {
    const f = await delegatedLinkFixture(db, adminId); const abort = new AbortController();
    const request = new Request(await f.signedRequest(list), { signal: abort.signal }); request.headers.set(MCP_TIMING_DEBUG_HEADER, "1");
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>(); const original = Server.prototype.close;
    const close = vi.spyOn(Server.prototype, "close").mockImplementation(async function (this: Server) { entered.resolve(); await release.promise; return original.call(this); });
    const pending = POST(request);
    try {
      await entered.promise; abort.abort(new Error("SECRET_ABORT_REASON"));
      expect(timings().some((r) => r.stage === "request_aborted")).toBe(true);
      expect(timings().some((r) => r.stage === "cleanup_end")).toBe(false);
      release.resolve(); expect((await pending).status).toBe(200);
      expect(timings().at(-1)).toMatchObject({ stage: "request_completed", httpStatus: 200 });
      expect(JSON.stringify(timings())).not.toContain("SECRET_ABORT_REASON");
    } finally { release.resolve(); await pending.catch(() => {}); close.mockRestore(); }
  });
});
