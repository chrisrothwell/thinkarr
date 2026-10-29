import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { createTestDb, seedUser, type TestDb } from "../helpers/db";
let db: TestDb; let sqlite: Database.Database; let adminId: number;
let session: { user: { id: number; isAdmin: boolean } } | null;
vi.mock("@/lib/db", () => ({ getDb: () => db, schema }));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn(async () => session) }));
vi.mock("@/lib/security/api-rate-limit", () => ({ checkUserApiRateLimit: () => true }));
vi.mock("@/lib/tools/init", () => ({ initializeTools: vi.fn() }));
vi.mock("@/lib/tools/registry", () => ({ getOpenAITools: () => [], hasTools: () => true, executeTool: vi.fn() }));
import { GET as info } from "@/app/api/mcp/info/route";
import { POST as redeem } from "@/app/api/mcp/setup/route";
import { POST as create } from "@/app/api/settings/mcp-integrations/[id]/setup/route";
import { POST as mcp } from "@/app/api/mcp/route";
import { createIntegration, getIntegration, issueServiceCredential, updateIntegration } from "@/lib/mcp/service-principals";
import { getSession } from "@/lib/auth/session";
import { _resetRateLimits } from "@/lib/auth/rate-limit";
import { logger } from "@/lib/logger";
import { createLinkingConnector } from "../../../connectors/delegated-mcp/linking";

beforeEach(() => {
  ({ db, sqlite } = createTestDb()); adminId = seedUser(db, { isAdmin: true }); session = { user: { id: adminId, isAdmin: true } };
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-22T05:00:00Z")); vi.clearAllMocks(); _resetRateLimits();
});
afterEach(() => { sqlite.close(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function principal() {
  return createIntegration({ name: "Companion", pilotGroup: "120300000000@g.us", publicLinkOrigin: "https://thinkarr.invalid", whatsappBotNumber: "+15555550100", allowedOperations: ["account_link_start", "account_link_confirm", "media_search"] }, adminId);
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const request = (body: unknown, token?: string) => new Request("https://thinkarr.invalid/api/mcp/setup", { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
async function grant(id: string) { const response = await create(request({}), params(id)); expect(response.status).toBe(200); return (await response.json()).data as { token: string; expiresAt: string }; }
function key() {
  const pair = generateKeyPairSync("ed25519");
  return { issuer: "openclaw:test", keyId: "key-1", publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(), privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}
const publicPart = (pair: ReturnType<typeof key>) => ({ issuer: pair.issuer, keyId: pair.keyId, publicKeyPem: pair.publicKeyPem });

describe("API-led companion connection setup", () => {
  it("exposes only stable public audience metadata before login, integration creation or credential issuance", async () => {
    session = null; vi.mocked(getSession).mockClear();
    const first = info(); expect(first.status).toBe(200); expect(first.headers.get("cache-control")).toBe("no-store");
    const value = await first.json(); expect(value).toEqual({ version: 1, audience: expect.stringMatching(/^[a-f0-9-]{36}$/) });
    expect(getSession).not.toHaveBeenCalled();
    expect(db.select().from(schema.mcpServiceCredentials).all()).toHaveLength(0);
    const p = principal(); issueServiceCredential(p.id, {}, adminId);
    expect(await info().json()).toEqual(value);
  });

  it.each(["anonymous", "participant", "service"])("does not let %s mint owner setup grants", async (caller) => {
    const p = principal(); session = caller === "participant" ? { user: { id: adminId, isAdmin: false } } : null;
    expect((await create(request({}, caller === "service" ? "thk_svc_fake" : undefined), params(p.id))).status).toBe(403);
    expect(db.select().from(schema.mcpSetupGrants).all()).toHaveLength(0);
  });

  it("redeems once without a browser, registers only the public key and issues a scoped credential atomically", async () => {
    const p = principal(); const code = await grant(p.id); const pair = key(); session = null;
    const response = await redeem(request(publicPart(pair), code.token));
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    const { data } = await response.json();
    expect(data).toMatchObject({ service: p.id, issuer: pair.issuer, keyId: pair.keyId, audience: (await info().json()).audience, group: p.pilotGroup, endpoint: "https://thinkarr.invalid/api/mcp" });
    expect(data.bearer).toMatch(/^thk_svc_/); expect(data).not.toHaveProperty("privateKeyPem");
    expect(db.select().from(schema.mcpServiceKeys).all()).toHaveLength(1);
    expect(db.select().from(schema.mcpServiceCredentials).all()).toHaveLength(1);
    const visible = JSON.stringify([getIntegration(p.id), db.select().from(schema.mcpSetupGrants).all(), vi.mocked(logger.info).mock.calls]);
    for (const value of [data.bearer, code.token, pair.privateKeyPem]) expect(visible).not.toContain(value);
    expect((await redeem(request(publicPart(pair), code.token))).status).toBe(401);
    expect(db.select().from(schema.mcpServicePrincipals).get()!.enabled).toBe(false);
  });

  it("the enrolled key/bearer complete a real signed MCP SDK link initiation", async () => {
    const p = principal(); updateIntegration(p.id, { enabled: true }, adminId);
    const code = await grant(p.id); const pair = key();
    const { data } = await (await redeem(request(publicPart(pair), code.token))).json();
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => mcp(new Request(input, init)));
    const connector = await createLinkingConnector({ endpoint: data.endpoint, publicLinkOrigin: data.publicLinkOrigin, service: data.service, issuer: data.issuer, keyId: data.keyId, audience: data.audience, bearer: data.bearer, privateKeyPem: pair.privateKeyPem }, {
      sendPrivate: async (delivery) => ({ accepted: true, channel: delivery.channel, account: delivery.account, recipient: delivery.recipient, messageId: "accepted" }),
    });
    expect(await connector.startLink({ channel: "whatsapp", account: "default", sender: "15555550101@s.whatsapp.net", kind: "group", conversation: p.pilotGroup!, assertCurrent: () => {} })).toEqual({ status: "private_link_sent" });
  });

  it("only one concurrent redemption can issue a credential", async () => {
    const p = principal(); const code = await grant(p.id); const pair = key();
    const responses = await Promise.all([redeem(request(publicPart(pair), code.token)), redeem(request(publicPart(pair), code.token))]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 401]);
    expect(db.select().from(schema.mcpServiceCredentials).all()).toHaveLength(1);
  });

  it.each(["expiry", "replacement", "group-change-back", "scope", "disabled", "owner-revoked"])("invalidates an unused grant after %s", async (reason) => {
    const p = principal(); const code = await grant(p.id);
    if (reason === "expiry") vi.setSystemTime(Date.now() + 600_000);
    if (reason === "replacement") await grant(p.id);
    if (reason === "group-change-back") { updateIntegration(p.id, { pilotGroup: "120300000001@g.us" }, adminId); updateIntegration(p.id, { pilotGroup: p.pilotGroup }, adminId); }
    if (reason === "scope") updateIntegration(p.id, { allowedOperations: ["media_search"] }, adminId);
    if (reason === "disabled") updateIntegration(p.id, { enabled: false }, adminId);
    if (reason === "owner-revoked") db.update(schema.users).set({ isAdmin: false }).where(eq(schema.users.id, adminId)).run();
    expect((await redeem(request(publicPart(key()), code.token))).status).toBe(401);
    expect(db.select().from(schema.mcpServiceCredentials).all()).toHaveLength(0);
  });

  it("does not allow beneficiary/scope overrides or private key input and rolls back failed enrollment", async () => {
    const p = principal(); const code = await grant(p.id); const pair = key();
    expect((await redeem(request({ ...publicPart(pair), principalId: "someone-else" }, code.token))).status).toBe(400);
    expect((await redeem(request({ ...publicPart(pair), publicKeyPem: pair.privateKeyPem }, code.token))).status).toBe(400);
    expect(db.select().from(schema.mcpServiceKeys).all()).toHaveLength(0);
    expect(db.select().from(schema.mcpSetupGrants).get()!.consumedAt).toBeNull();
    expect((await redeem(request(publicPart(pair), code.token))).status).toBe(200);
  });

  it("rolls back public-key registration and code consumption if credential issuance fails", async () => {
    const p = principal(); const code = await grant(p.id); const pair = key();
    sqlite.exec("CREATE TRIGGER fail_setup_issue BEFORE INSERT ON mcp_service_credentials BEGIN SELECT RAISE(ABORT, 'synthetic issue failure'); END;");
    const response = await redeem(request(publicPart(pair), code.token)); expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("synthetic");
    expect(db.select().from(schema.mcpServiceKeys).all()).toHaveLength(0);
    expect(db.select().from(schema.mcpServiceCredentials).all()).toHaveLength(0);
    expect(db.select().from(schema.mcpSetupGrants).get()!.consumedAt).toBeNull();
    sqlite.exec("DROP TRIGGER fail_setup_issue;");
    expect((await redeem(request(publicPart(pair), code.token))).status).toBe(200);
  });

  it("refuses to rotate existing credentials and invalidates grants when credentials are issued elsewhere", async () => {
    const p = principal(); const code = await grant(p.id); issueServiceCredential(p.id, {}, adminId);
    expect((await create(request({}), params(p.id))).status).toBe(409);
    expect((await redeem(request(publicPart(key()), code.token))).status).toBe(401);
    expect(db.select().from(schema.mcpServiceKeys).all()).toHaveLength(0);
  });

  it("does not accept a normal service bearer as setup authority and rate-limits invalid attempts", async () => {
    const p = principal(); const code = await grant(p.id); session = null;
    const runtime = await mcp(new Request("https://thinkarr.invalid/api/mcp", { method: "POST", headers: { Authorization: `Bearer ${code.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "account_link_start", arguments: {} } }) }));
    expect(runtime.status).toBeGreaterThanOrEqual(400);
    expect(db.select().from(schema.mcpSetupGrants).get()!.consumedAt).toBeNull();
    const credential = issueServiceCredential(p.id, {}, adminId);
    expect((await redeem(request(publicPart(key()), credential.token))).status).toBe(401);
    for (let i = 0; i < 10; i++) await redeem(request({}, "thk_setup_invalid"));
    expect((await redeem(request({}, "thk_setup_invalid"))).status).toBe(429);
  });
  it("bounds the unauthenticated enrollment body without consuming the valid setup code", async () => {
    const p = principal(); const code = await grant(p.id);
    const response = await redeem(request({ publicKeyPem: "x".repeat(16_385) }, code.token));
    expect(response.status).toBe(400); expect(await response.text()).toContain("too large");
    expect(db.select().from(schema.mcpSetupGrants).get()!.consumedAt).toBeNull();
  });
});
