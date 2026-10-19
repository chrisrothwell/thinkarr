import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { generateKeyPairSync } from "node:crypto";
import * as schema from "@/lib/db/schema";
import { createTestDb, seedUser, type TestDb } from "../helpers/db";

let db: TestDb;
let sqlite: Database.Database;
let session: { user: { id: number; isAdmin: boolean } } | null;
let adminId: number;
vi.mock("@/lib/db", () => ({ getDb: () => db, schema }));
vi.mock("@/lib/auth/session", () => ({ getSession: async () => session }));
vi.mock("@/lib/security/api-rate-limit", () => ({ checkUserApiRateLimit: vi.fn(() => true) }));

import { GET, POST } from "@/app/api/settings/mcp-integrations/route";
import { GET as detailGET, PATCH } from "@/app/api/settings/mcp-integrations/[id]/route";
import { POST as credentialPOST } from "@/app/api/settings/mcp-integrations/[id]/credentials/route";
import { DELETE as credentialDELETE } from "@/app/api/settings/mcp-integrations/[id]/credentials/[credentialId]/route";
import { POST as keyPOST } from "@/app/api/settings/mcp-integrations/[id]/keys/route";
import { DELETE as keyDELETE } from "@/app/api/settings/mcp-integrations/[id]/keys/[keyId]/route";
import { checkUserApiRateLimit } from "@/lib/security/api-rate-limit";

function request(body: unknown, method = "POST") {
  return new Request("http://localhost/api/settings/mcp-integrations", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  ({ db, sqlite } = createTestDb());
  adminId = seedUser(db, { isAdmin: true });
  session = { user: { id: adminId, isAdmin: true } };
  vi.mocked(checkUserApiRateLimit).mockReturnValue(true);
});
afterEach(() => sqlite.close());

describe("MCP integration management API", () => {
  it.each(["anonymous", "user", "service"])("denies every management operation to %s callers", async (caller) => {
    session = caller === "user" ? { user: { id: adminId, isAdmin: false } } : null;
    const req = request({ name: "Denied" });
    if (caller === "service") req.headers.set("Authorization", "Bearer thk_svc_fixture");
    const id = "missing";
    const replies = await Promise.all([
      GET(), POST(req), detailGET(req, params(id)), PATCH(req, params(id)),
      credentialPOST(req, params(id)), keyPOST(req, params(id)),
      credentialDELETE(req, { params: Promise.resolve({ id, credentialId: id }) }),
      keyDELETE(req, { params: Promise.resolve({ id, keyId: id }) }),
    ]);
    expect(replies.every((response) => response.status === 403)).toBe(true);
    expect(db.select().from(schema.mcpServicePrincipals).all()).toHaveLength(0);
  });

  it("creates disabled integrations, exposes only curated scope, and refuses activation", async () => {
    const created = await POST(request({ name: "Helga" }));
    expect(created.status).toBe(200);
    const principal = (await created.json()).data;
    expect(principal.enabled).toBe(false);
    const listed = await (await GET()).json();
    expect(listed.data.delegatedAccessAvailable).toBe(false);
    expect(listed.data.integrations).toHaveLength(1);
    expect((await PATCH(request({ enabled: true }, "PATCH"), params(principal.id))).status).toBe(409);
    expect((await POST(request({ name: "Unsafe", allowedOperations: ["splitwise_add_expense"] }))).status).toBe(400);
  });

  it("issues a no-store secret once, rotates it, and returns only safe metadata on retrieval", async () => {
    const id = (await (await POST(request({ name: "Helga" }))).json()).data.id;
    const issuedResponse = await credentialPOST(request({}), params(id));
    expect(issuedResponse.headers.get("cache-control")).toBe("no-store");
    const issued = (await issuedResponse.json()).data;
    expect(issued.token).toMatch(/^thk_svc_/);
    const detail = await detailGET(request({}), params(id));
    const text = await detail.text();
    expect(text).not.toContain(issued.token);
    expect(text).not.toContain("tokenHash");
    const replacement = await credentialPOST(request({ replaceCredentialId: issued.id, overlapMinutes: 5 }), params(id));
    expect(replacement.status).toBe(200);
    const replacementId = (await replacement.json()).data.id;
    expect((await credentialDELETE(request({}), { params: Promise.resolve({ id, credentialId: replacementId }) })).status).toBe(200);
  });

  it("registers public keys, revokes them, and never reflects uploaded private-key input in an error", async () => {
    const id = (await (await POST(request({ name: "Helga" }))).json()).data.id;
    const pair = generateKeyPairSync("ed25519");
    const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
    const created = await keyPOST(request({ issuer: "connector:fixture", keyId: "key-1", publicKeyPem }), params(id));
    expect(created.status).toBe(200);
    const keyId = (await created.json()).data.id;
    expect((await keyDELETE(request({}), { params: Promise.resolve({ id, keyId }) })).status).toBe(200);
    const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const rejected = await keyPOST(request({ issuer: "connector:fixture", keyId: "key-2", publicKeyPem: privatePem }), params(id));
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).not.toContain(privatePem);
  });

  it("enforces request validation, missing-resource errors and rate limits", async () => {
    expect((await POST(request({ name: "Helga", isAdmin: true }))).status).toBe(400);
    expect((await detailGET(request({}), params("missing"))).status).toBe(404);
    const invalid = new Request("http://localhost/api/settings/mcp-integrations", { method: "POST", body: "{broken" });
    expect((await POST(invalid)).status).toBe(400);
    vi.mocked(checkUserApiRateLimit).mockReturnValue(false);
    expect((await GET()).status).toBe(429);
  });
});
