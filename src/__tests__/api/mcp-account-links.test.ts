import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import type { SessionWithUser } from "@/lib/auth/session";
import { createTestDb, seedUser, type TestDb } from "../helpers/db";
import { delegatedLinkFixture } from "../helpers/delegated-link";

let db: TestDb;
let sqlite: Database.Database;
let adminId: number;
let session: SessionWithUser | null;
vi.mock("@/lib/db", () => ({ getDb: () => db, schema }));
vi.mock("@/lib/auth/session", () => ({ getSession: async () => session }));
vi.mock("@/lib/security/api-rate-limit", () => ({ checkUserApiRateLimit: () => true }));

import { POST as inspectPOST } from "@/app/api/mcp/account-links/inspect/route";
import { POST as preparePOST } from "@/app/api/mcp/account-links/prepare/route";
import { GET } from "@/app/api/account-links/route";
import { DELETE } from "@/app/api/account-links/[id]/route";
import { DELETE as adminDELETE } from "@/app/api/settings/mcp-integrations/[id]/bindings/[bindingId]/route";
import { completeAccountLink, initiateAccountLink } from "@/lib/mcp/account-linking";
import { _resetRateLimits } from "@/lib/auth/rate-limit";

function request(body: unknown) {
  return new Request("https://thinkarr.invalid/api/mcp/account-links/inspect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
function login(id: number, sessionId: string) {
  const user = db.select().from(schema.users).where(eq(schema.users.id, id)).get()!;
  session = { sessionId, user: { id, plexId: user.plexId, plexUsername: user.plexUsername, plexEmail: user.plexEmail, plexAvatarUrl: null, isAdmin: user.isAdmin } };
}
beforeEach(() => {
  ({ db, sqlite } = createTestDb());
  adminId = seedUser(db, { isAdmin: true });
  session = null; _resetRateLimits();
});
afterEach(() => sqlite.close());

describe("browser account-link and ownership APIs", () => {
  it("inspects a private token via no-store POST without exposing actor or account identifiers", async () => {
    const f = await delegatedLinkFixture(db, adminId);
    const challenge = initiateAccountLink(await f.context());
    if (challenge.linked) throw new Error();
    const response = await inspectPOST(request({ token: challenge.token }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const output = await response.text();
    for (const value of [challenge.token, "sender-A", "group-A", "userId", "plexId", "actorHash"]) expect(output).not.toContain(value);
    expect((await inspectPOST(request({ token: challenge.token, userId: f.userB }))).status).toBe(400);
  });

  it("prepares only for an authenticated real browser session, rejecting user selectors", async () => {
    const f = await delegatedLinkFixture(db, adminId);
    const challenge = initiateAccountLink(await f.context());
    if (challenge.linked) throw new Error();
    expect((await preparePOST(request({ token: challenge.token }))).status).toBe(403);
    login(f.userA, f.sessionA);
    const wrongOrigin = request({ token: challenge.token }); wrongOrigin.headers.set("Origin", "https://another.invalid");
    expect((await preparePOST(wrongOrigin)).status).toBe(403);
    const wrongAccount = request({ token: challenge.token }); wrongAccount.headers.set("Thinkarr-Link-Expected-User", String(f.userB));
    expect((await preparePOST(wrongAccount)).status).toBe(409);
    expect(db.select().from(schema.mcpLinkChallenges).get()!.completionCodeHash).toBeNull();
    const plainText = request({ token: challenge.token }); plainText.headers.set("Content-Type", "text/plain");
    expect((await preparePOST(plainText)).status).toBe(400);
    expect((await preparePOST(request({ token: challenge.token, userId: f.userB }))).status).toBe(400);
    const response = await preparePOST(request({ token: challenge.token }));
    expect(response.status).toBe(200);
    const prepared = (await response.json()).data;
    expect(prepared).not.toHaveProperty("completionCode");
    const code = new URL(prepared.handoffUrl).searchParams.get("text")!.replace("Link account ", "");
    expect(new URL(prepared.handoffUrl).pathname).toBe("/15555550100");
    expect(code).toMatch(/^[a-f0-9]{64}$/);
    expect(db.select().from(schema.mcpActorBindings).all()).toHaveLength(0);
    completeAccountLink(await f.privateContext(code), code);
    const listed = (await (await GET()).json()).data;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ integrationName: "Group assistant", channel: "whatsapp", contextKind: "group" });
    expect(JSON.stringify(listed)).not.toContain("actorHash");
  });

  it("allows self unlink and administrator revocation but blocks other users and cross-integration requests", async () => {
    const f = await delegatedLinkFixture(db, adminId);
    const challenge = initiateAccountLink(await f.context());
    if (challenge.linked) throw new Error();
    login(f.userA, f.sessionA);
    const handoff = (await (await preparePOST(request({ token: challenge.token }))).json()).data.handoffUrl as string;
    const code = new URL(handoff).searchParams.get("text")!.replace("Link account ", "");
    completeAccountLink(await f.privateContext(code), code);
    const id = db.select().from(schema.mcpActorBindings).get()!.id;
    login(f.userB, f.sessionB);
    expect((await (await GET()).json()).data).toEqual([]);
    expect((await DELETE(request({}), { params: Promise.resolve({ id }) })).status).toBe(404);
    expect((await adminDELETE(request({}), { params: Promise.resolve({ id: f.principal.id, bindingId: id }) })).status).toBe(403);
    login(adminId, "admin-session");
    expect((await adminDELETE(request({}), { params: Promise.resolve({ id: "another-principal", bindingId: id }) })).status).toBe(404);
    expect((await adminDELETE(request({}), { params: Promise.resolve({ id: f.principal.id, bindingId: id }) })).status).toBe(200);
    login(f.userA, f.sessionA);
    expect((await DELETE(request({}), { params: Promise.resolve({ id }) })).status).toBe(200);
    expect(db.select().from(schema.mcpActorBindings).get()!.revokedAt).not.toBeNull();
  });
});
