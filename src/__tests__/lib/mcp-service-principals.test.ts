import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, generateKeyPairSync } from "node:crypto";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { createTestDb, seedUser, type TestDb } from "../helpers/db";
import { logger } from "@/lib/logger";

let db: TestDb;
let sqlite: Database.Database;
let adminId: number;
vi.mock("@/lib/db", () => ({ getDb: () => db, schema }));

import {
  authenticateServiceMcpToken, createIntegration, getIntegration, issueServiceCredential,
  listIntegrations, recordServiceMcpDenial, registerServiceKey, revokeServiceCredential,
  revokeServiceKey, updateIntegration,
} from "@/lib/mcp/service-principals";

beforeEach(() => {
  ({ db, sqlite } = createTestDb());
  adminId = seedUser(db, { isAdmin: true });
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-19T12:00:00Z"));
  vi.clearAllMocks();
});
afterEach(() => { sqlite.close(); vi.useRealTimers(); });

function integration() { return createIntegration({ name: "Group media" }, adminId); }
function publicKey() {
  return generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
}

describe("administrator-managed service identities", () => {
  it("creates a disabled machine identity without creating a Plex user or inheriting the creator's role", () => {
    const principal = integration();
    expect(principal.enabled).toBe(false);
    expect(principal.createdByUserId).toBe(adminId);
    expect(principal.allowedOperations).toEqual(["media_search", "media_details"]);
    expect(principal).not.toHaveProperty("plexId");
    expect(principal).not.toHaveProperty("isAdmin");
    expect(db.select().from(schema.users).all()).toHaveLength(1);
    expect(listIntegrations()).toHaveLength(1);
  });

  it("restricts configurable scope and requires a group and private-link configuration before enabling", () => {
    expect(() => createIntegration({ name: "Unsafe", allowedOperations: ["plex_get_on_deck"] as never }, adminId)).toThrow();
    const principal = integration();
    expect(() => updateIntegration(principal.id, { enabled: true }, adminId)).toThrow(/Configure the WhatsApp group/);
    const updated = updateIntegration(principal.id, { name: "Updated", allowedOperations: ["media_search"], enabled: false }, adminId);
    expect(updated.name).toBe("Updated");
    expect(updated.allowedOperations).toEqual(["media_search"]);
    expect(updated.enabled).toBe(false);
  });

  it("configures independent integrations through persisted settings without process-wide pilot restrictions", () => {
    const first = integration(); const second = integration();
    for (const [principal, group] of [[first, "120300000000@g.us"], [second, "120300000001@g.us"]] as const) {
      const updated = updateIntegration(principal.id, { pilotGroup: group, publicLinkOrigin: "https://thinkarr.example.com", whatsappBotNumber: "+15555550100", enabled: true }, adminId);
      expect(updated).toMatchObject({ enabled: true, pilotGroup: group });
    }
    expect(listIntegrations().filter((p) => p.enabled)).toHaveLength(2);
  });

  it("returns a secret only at issuance, stores its hash, and keeps secrets/hashes out of retrieval and audit logs", () => {
    const principal = integration();
    const issued = issueServiceCredential(principal.id, {}, adminId);
    const stored = db.select().from(schema.mcpServiceCredentials).get()!;
    expect(stored.tokenHash).toBe(createHash("sha256").update(issued.token).digest("hex"));
    expect(stored.prefix).not.toContain(issued.token.split(".")[1]);
    const visible = JSON.stringify({
      list: listIntegrations(), detail: getIntegration(principal.id),
      audit: db.select().from(schema.mcpServiceAudit).all(), logs: vi.mocked(logger.info).mock.calls,
    });
    expect(visible).not.toContain(issued.token);
    expect(visible).not.toContain(stored.tokenHash);
    const auth = authenticateServiceMcpToken(issued.token)!;
    expect(auth).toMatchObject({ kind: "service", principalId: principal.id, credentialId: issued.id, enabled: false });
    expect(auth).not.toHaveProperty("permission");
    expect(auth).not.toHaveProperty("userId");
  });

  it("rotates immediately by default and revokes credentials without affecting the principal", () => {
    const principal = integration();
    const first = issueServiceCredential(principal.id, {}, adminId);
    expect(() => issueServiceCredential(principal.id, {}, adminId)).toThrow(/Rotate or revoke/);
    const replacement = issueServiceCredential(principal.id, { replaceCredentialId: first.id }, adminId);
    expect(authenticateServiceMcpToken(first.token)).toBeNull();
    expect(authenticateServiceMcpToken(replacement.token)).not.toBeNull();
    revokeServiceCredential(principal.id, replacement.id, adminId);
    revokeServiceCredential(principal.id, replacement.id, adminId);
    expect(authenticateServiceMcpToken(replacement.token)).toBeNull();
    expect(getIntegration(principal.id).id).toBe(principal.id);
  });

  it("bounds rotation overlap, prevents credential accumulation, and expires the old token at the deadline", () => {
    const principal = integration();
    const first = issueServiceCredential(principal.id, {}, adminId);
    const second = issueServiceCredential(principal.id, { replaceCredentialId: first.id, overlapMinutes: 10 }, adminId);
    expect(authenticateServiceMcpToken(first.token)).not.toBeNull();
    expect(authenticateServiceMcpToken(second.token)).not.toBeNull();
    expect(() => issueServiceCredential(principal.id, { replaceCredentialId: second.id }, adminId)).toThrow(/Rotate or revoke/);
    expect(() => issueServiceCredential(principal.id, { replaceCredentialId: second.id, overlapMinutes: 61 }, adminId)).toThrow();
    vi.setSystemTime(new Date("2026-10-19T12:10:00Z"));
    expect(authenticateServiceMcpToken(first.token)).toBeNull();
    expect(authenticateServiceMcpToken(second.token)).not.toBeNull();
  });

  it("does not extend an earlier expiry during overlap and checks expiry on every lookup", () => {
    const principal = integration();
    const first = issueServiceCredential(principal.id, { expiresInDays: 1 }, adminId);
    vi.setSystemTime(new Date("2026-10-20T11:59:00Z"));
    issueServiceCredential(principal.id, { replaceCredentialId: first.id, overlapMinutes: 60 }, adminId);
    vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
    expect(authenticateServiceMcpToken(first.token)).toBeNull();
  });

  it("cannot rotate/revoke a different integration's credential and rolls back failed issuance", () => {
    const first = integration();
    const second = integration();
    const issued = issueServiceCredential(first.id, {}, adminId);
    expect(() => issueServiceCredential(second.id, { replaceCredentialId: issued.id }, adminId)).toThrow(/not found/);
    expect(() => revokeServiceCredential(second.id, issued.id, adminId)).toThrow(/not found/);
    expect(getIntegration(second.id).credentials).toHaveLength(0);
    expect(authenticateServiceMcpToken(issued.token)).not.toBeNull();
  });

  it("registers and revokes independent public verification keys without accepting private or non-Ed25519 material", () => {
    const principal = integration();
    const first = registerServiceKey(principal.id, { issuer: "connector:fixture", keyId: "key-1", publicKeyPem: publicKey() }, adminId);
    expect(first.publicKeyPem).toContain("BEGIN PUBLIC KEY");
    expect(() => registerServiceKey(principal.id, { issuer: first.issuer, keyId: first.keyId, publicKeyPem: publicKey() }, adminId)).toThrow(/already registered/);
    const privateKeyPem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => registerServiceKey(principal.id, { issuer: "connector:fixture", keyId: "bad-private", publicKeyPem: privateKeyPem }, adminId)).toThrow(/public key/);
    const wrongKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(() => registerServiceKey(principal.id, { issuer: "connector:fixture", keyId: "bad-alg", publicKeyPem: wrongKey }, adminId)).toThrow(/Ed25519/);
    revokeServiceKey(principal.id, first.id, adminId);
    expect(getIntegration(principal.id).keys[0].revokedAt).not.toBeNull();
    expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain(privateKeyPem);
  });

  it("records service caller without assigning the creator as the delegated human", () => {
    const principal = integration();
    const issued = issueServiceCredential(principal.id, {}, adminId);
    recordServiceMcpDenial(authenticateServiceMcpToken(issued.token)!);
    const events = db.select().from(schema.mcpServiceAudit).all();
    expect(events.find((event) => event.action === "principal_created")?.actorUserId).toBe(adminId);
    expect(events.find((event) => event.action === "service_access_denied")).toMatchObject({ principalId: principal.id, actorUserId: null, targetId: issued.id });
  });

  it("rejects malformed, unknown and policy-corrupted credentials without returning a broader identity", () => {
    expect(authenticateServiceMcpToken("thk_svc_invalid")).toBeNull();
    const principal = integration();
    const issued = issueServiceCredential(principal.id, {}, adminId);
    expect(authenticateServiceMcpToken(issued.token.slice(0, -1) + (issued.token.endsWith("a") ? "b" : "a"))).toBeNull();
    db.update(schema.mcpServicePrincipals).set({ allowedOperations: "[\"raw_admin_tool\"]" }).where(eq(schema.mcpServicePrincipals.id, principal.id)).run();
    expect(authenticateServiceMcpToken(issued.token)).toBeNull();
  });
});
