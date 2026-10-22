import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { importPKCS8, SignJWT } from "jose";
import * as schema from "@/lib/db/schema";
import { createTestDb, seedUser, type TestDb } from "../helpers/db";
import { authenticateServiceMcpToken, createIntegration, issueServiceCredential, registerServiceKey, revokeServiceCredential, revokeServiceKey } from "@/lib/mcp/service-principals";

let db: TestDb;
let sqlite: Database.Database;
let dirs: string[];
let adminId: number;
vi.mock("@/lib/db", () => ({ getDb: () => db, schema }));

import { consumeDelegatedEvent, getDelegationAudience, verifyDelegatedRequest, type DelegationClaims } from "@/lib/mcp/delegation";

const NOW = 1792411200;
const body = new TextEncoder().encode("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}");
beforeEach(() => {
  ({ db, sqlite } = createTestDb());
  adminId = seedUser(db, { isAdmin: true });
  dirs = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW * 1000));
});
afterEach(() => { sqlite.close(); for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); vi.useRealTimers(); });

async function fixture() {
  const principal = createIntegration({ name: "Fixture" }, adminId);
  db.update(schema.mcpServicePrincipals).set({ enabled: true }).where(eq(schema.mcpServicePrincipals.id, principal.id)).run();
  const credential = issueServiceCredential(principal.id, {}, adminId);
  const caller = authenticateServiceMcpToken(credential.token)!;
  const pair = generateKeyPairSync("ed25519");
  const key = registerServiceKey(principal.id, {
    issuer: "connector:fixture", keyId: "key-1", publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  }, adminId);
  const privateKey = await importPKCS8(pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), "EdDSA");
  const claims: DelegationClaims = {
    v: 1, iss: key.issuer, aud: getDelegationAudience(), service: principal.id,
    channel: "fixture", account: "account-A", sender: "sender-A", kind: "group", conversation: "group-A",
    source: "tool", iat: NOW, exp: NOW + 60, jti: randomUUID(), method: "POST", target: "/api/mcp?mode=text",
    bodyHash: createHash("sha256").update(body).digest("hex"),
  };
  async function assertion(patch: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
    return new SignJWT({ ...claims, ...patch }).setProtectedHeader({ alg: "EdDSA", typ: "thinkarr-delegation+jwt", kid: key.keyId, ...header }).sign(privateKey);
  }
  async function request(patch: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
    return new Request("https://thinkarr.invalid/api/mcp?mode=text", { method: "POST", headers: { "Thinkarr-Delegation": await assertion(patch, header) } });
  }
  return { principal, credential, caller, key, claims, assertion, request };
}

describe("signed delegation authentication", () => {
  it("uses a stable instance audience and returns verified identity without inheriting an admin actor", async () => {
    const f = await fixture();
    expect(getDelegationAudience()).toBe(getDelegationAudience());
    const verified = await verifyDelegatedRequest(await f.request(), body, f.caller);
    expect(verified.delegation).toMatchObject({ sender: "sender-A", conversation: "group-A", source: "tool" });
    expect(verified).not.toHaveProperty("userId");
    expect(verified).not.toHaveProperty("permission");
    expect(Object.isFrozen(verified)).toBe(true);
    expect(db.select().from(schema.mcpDelegationNonces).all()).toHaveLength(1);
  });

  it.each([
    { aud: "another-instance" }, { iss: "unregistered-issuer" }, { service: randomUUID() },
    { exp: NOW + 61 }, { exp: NOW - 6, iat: NOW - 60 }, { iat: NOW + 6, exp: NOW + 60 },
    { sender: "" }, { source: "tool", intent: "confirm-current" },
    { source: "message", intent: "confirm-current" },
    { source: "message", intent: "confirm-choice", eventId: "event", eventTime: NOW * 1000 },
    { source: "message", intent: "link-confirm:code", eventId: "event", eventTime: NOW * 1000 },
  ])("rejects invalid identity/profile/time claims without storing a nonce: %j", async (patch) => {
    const f = await fixture();
    await expect(verifyDelegatedRequest(await f.request(patch), body, f.caller)).rejects.toMatchObject({ code: "INVALID_ASSERTION" });
    expect(db.select().from(schema.mcpDelegationNonces).all()).toHaveLength(0);
  });

  it("rejects unsigned/tampered and inline/unregistered-key assertions without leaking their contents", async () => {
    const f = await fixture();
    const token = await f.assertion();
    const parts = token.split(".");
    parts[1] = Buffer.from(JSON.stringify({ ...f.claims, sender: "sender-B" })).toString("base64url");
    const tampered = new Request("https://thinkarr.invalid/api/mcp?mode=text", { method: "POST", headers: { "Thinkarr-Delegation": parts.join(".") } });
    await expect(verifyDelegatedRequest(tampered, body, f.caller)).rejects.toMatchObject({ code: "INVALID_ASSERTION" });
    for (const header of [{ kid: "unknown-key" }, { jwk: { kty: "OKP" } }, { typ: "JWT" }]) {
      await expect(verifyDelegatedRequest(await f.request({}, header), body, f.caller)).rejects.toMatchObject({ code: "INVALID_ASSERTION" });
    }
    await expect(verifyDelegatedRequest(new Request("https://thinkarr.invalid/api/mcp"), body, f.caller)).rejects.toMatchObject({ message: "Delegated request could not be authorized" });
  });

  it("binds exact bytes, method and encoded path/query instead of trusting user/group headers", async () => {
    const f = await fixture();
    const req = await f.request();
    req.headers.set("X-User-Id", String(adminId));
    req.headers.set("X-Channel-User-Id", "another-sender");
    await expect(verifyDelegatedRequest(req, new TextEncoder().encode(new TextDecoder().decode(body) + " "), f.caller)).rejects.toMatchObject({ code: "INVALID_REQUEST_BINDING" });
    for (const altered of [
      new Request("https://thinkarr.invalid/api/mcp", { method: "POST", headers: req.headers }),
      new Request(req.url, { method: "GET", headers: req.headers }),
    ]) await expect(verifyDelegatedRequest(altered, body, f.caller)).rejects.toMatchObject({ code: "INVALID_REQUEST_BINDING" });
    expect((await verifyDelegatedRequest(req, body, f.caller)).delegation.sender).toBe("sender-A");
  });

  it("atomically admits only one of two concurrent requests with the same nonce", async () => {
    const f = await fixture();
    const requests = [await f.request(), await f.request()];
    const results = await Promise.allSettled(requests.map((request) => verifyDelegatedRequest(request, body, f.caller)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(db.select().from(schema.mcpDelegationNonces).all()).toHaveLength(1);
  });

  it("retains replay records throughout clock-skew allowance and rejects reuse after a process/database reopen", async () => {
    const f = await fixture();
    const req = await f.request();
    await verifyDelegatedRequest(req, body, f.caller);
    vi.setSystemTime(new Date((NOW + 61) * 1000));
    await expect(verifyDelegatedRequest(req, body, f.caller)).rejects.toMatchObject({ code: "REPLAYED_ASSERTION" });
    const dir = mkdtempSync(path.join(tmpdir(), "thinkarr-replay-")); dirs.push(dir);
    const filename = path.join(dir, "test.db");
    await sqlite.backup(filename);
    sqlite.close();
    sqlite = new Database(filename); sqlite.pragma("foreign_keys = ON"); db = drizzle(sqlite, { schema });
    await expect(verifyDelegatedRequest(req, body, f.caller)).rejects.toMatchObject({ code: "REPLAYED_ASSERTION" });
  });

  it.each(["key", "credential", "principal"])("rechecks %s revocation after asynchronous signature preparation", async (target) => {
    const f = await fixture();
    const req = await f.request();
    const pending = verifyDelegatedRequest(req, body, f.caller);
    if (target === "key") revokeServiceKey(f.principal.id, f.key.id, adminId);
    if (target === "credential") revokeServiceCredential(f.principal.id, f.credential.id, adminId);
    if (target === "principal") db.update(schema.mcpServicePrincipals).set({ enabled: false }).where(eq(schema.mcpServicePrincipals.id, f.principal.id)).run();
    await expect(pending).rejects.toBeInstanceOf(Error);
    expect(db.select().from(schema.mcpDelegationNonces).all()).toHaveLength(0);
  });

  it("returns current database policy rather than a stale caller allowlist", async () => {
    const f = await fixture();
    const req = await f.request();
    const pending = verifyDelegatedRequest(req, body, f.caller);
    db.update(schema.mcpServicePrincipals).set({ allowedOperations: "[]" }).where(eq(schema.mcpServicePrincipals.id, f.principal.id)).run();
    expect((await pending).allowedOperations).toEqual([]);
  });
});

describe("provider event deduplication", () => {
  const message = { source: "message", intent: "confirm-current", eventId: "provider-event-1", eventTime: NOW * 1000 };

  it("deduplicates the original event across fresh HTTP signatures and stores no raw sender/message/credential", async () => {
    const f = await fixture();
    const first = await verifyDelegatedRequest(await f.request(message), body, f.caller);
    consumeDelegatedEvent(first);
    const retry = await verifyDelegatedRequest(await f.request({ ...message, jti: randomUUID() }), body, f.caller);
    expect(() => consumeDelegatedEvent(retry)).toThrow();
    const serialized = JSON.stringify(db.select().from(schema.mcpDelegationEvents).all());
    expect(serialized).not.toContain("sender-A");
    expect(serialized).not.toContain(message.eventId);
    expect(serialized).not.toContain(f.credential.token);
  });

  it("allows reuse of provider-local IDs in a different actor/context namespace", async () => {
    const f = await fixture();
    for (const patch of [{}, { sender: "sender-B" }, { conversation: "group-B" }, { kind: "direct" }, { account: "account-B" }]) {
      const verified = await verifyDelegatedRequest(await f.request({ ...message, ...patch, jti: randomUUID() }), body, f.caller);
      consumeDelegatedEvent(verified);
    }
    expect(db.select().from(schema.mcpDelegationEvents).all()).toHaveLength(5);
  });

  it("can join a business transaction so a rolled-back claim does not discard the confirmation", async () => {
    const f = await fixture();
    const verified = await verifyDelegatedRequest(await f.request(message), body, f.caller);
    expect(() => db.transaction((tx) => { consumeDelegatedEvent(verified, tx); throw new Error("synthetic rollback"); })).toThrow(/rollback/);
    expect(db.select().from(schema.mcpDelegationEvents).all()).toHaveLength(0);
    expect(() => consumeDelegatedEvent(verified)).not.toThrow();
  });

  it("rechecks key revocation when a previously verified context is used to consume an event", async () => {
    const f = await fixture();
    const verified = await verifyDelegatedRequest(await f.request(message), body, f.caller);
    revokeServiceKey(f.principal.id, f.key.id, adminId);
    expect(() => consumeDelegatedEvent(verified)).toThrow();
    expect(db.select().from(schema.mcpDelegationEvents).all()).toHaveLength(0);
  });

  it("does not consume stale/future events, expired verified contexts or revoked bindings to credentials", async () => {
    const f = await fixture();
    for (const patch of [{ eventTime: (NOW - 906) * 1000 }, { eventTime: (NOW + 6) * 1000 }]) {
      const context = await verifyDelegatedRequest(await f.request({ ...message, ...patch, jti: randomUUID() }), body, f.caller);
      expect(() => consumeDelegatedEvent(context)).toThrow();
    }
    const context = await verifyDelegatedRequest(await f.request({ ...message, jti: randomUUID() }), body, f.caller);
    vi.setSystemTime(new Date((NOW + 65) * 1000));
    expect(() => consumeDelegatedEvent(context)).toThrow();
    expect(db.select().from(schema.mcpDelegationEvents).all()).toHaveLength(0);
  });
});
