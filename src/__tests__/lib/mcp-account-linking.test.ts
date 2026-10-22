import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { createTestDb, seedSession, seedUser, type TestDb } from "../helpers/db";
import { delegatedLinkFixture } from "../helpers/delegated-link";
import { logger } from "@/lib/logger";

let db: TestDb;
let sqlite: Database.Database;
let adminId: number;
vi.mock("@/lib/db", () => ({ getDb: () => db, schema }));
import { completeAccountLink, initiateAccountLink, inspectAccountLink, LINK_CHALLENGE_TTL_MS, listAccountBindings, prepareAccountLink, resolveServiceActor, revokeAccountBinding } from "@/lib/mcp/account-linking";
import { revokeServiceCredential, revokeServiceKey, updateIntegration } from "@/lib/mcp/service-principals";

beforeEach(() => {
  ({ db, sqlite } = createTestDb());
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-20T02:00:00Z"));
  adminId = seedUser(db, { isAdmin: true });
  vi.clearAllMocks();
});
afterEach(() => { sqlite.close(); vi.useRealTimers(); });

async function pending() {
  const f = await delegatedLinkFixture(db, adminId);
  const origin = await f.context();
  const challenge = initiateAccountLink(origin);
  if (challenge.linked) throw new Error("Unexpected existing binding");
  return { ...f, origin, challenge };
}

describe("trusted actor linking", () => {
  it("builds a configured fragment-only private address and invalidates pending links when handoff settings change", async () => {
    const f = await pending();
    const url = new URL(f.challenge.privateLinkUrl);
    expect(url.origin).toBe("https://thinkarr.invalid");
    expect(url.search).toBe("");
    expect(url.hash).toBe(`#token=${f.challenge.token}`);
    updateIntegration(f.principal.id, { publicLinkOrigin: "https://thinkarr.invalid/", whatsappBotNumber: "+15555550100" }, adminId);
    expect(() => inspectAccountLink(f.challenge.token)).not.toThrow();
    updateIntegration(f.principal.id, { whatsappBotNumber: "15555550101" }, adminId);
    updateIntegration(f.principal.id, { whatsappBotNumber: "15555550100" }, adminId);
    expect(() => inspectAccountLink(f.challenge.token)).toThrow();
    expect(() => prepareAccountLink(f.challenge.token, f.sessionA, f.userA)).toThrow();
  });

  it("does not accept caller-host destinations, missing configuration or a changed configuration fingerprint", async () => {
    const f = await pending();
    expect(() => inspectAccountLink(f.challenge.token, "https://caller-controlled.invalid")).toThrow(/original Thinkarr address/);
    db.update(schema.mcpServicePrincipals).set({ whatsappBotNumber: "15555550101" }).where(eq(schema.mcpServicePrincipals.id, f.principal.id)).run();
    expect(() => inspectAccountLink(f.challenge.token)).toThrow();
    db.update(schema.mcpServicePrincipals).set({ publicLinkOrigin: null }).where(eq(schema.mcpServicePrincipals.id, f.principal.id)).run();
    expect(() => initiateAccountLink(f.origin)).toThrow(/Configure/);
  });
  it("keeps challenge/code secrets and raw channel identity out of storage/logs and waits for private sender proof", async () => {
    const f = await pending();
    expect(inspectAccountLink(f.challenge.token)).toMatchObject({ integrationName: "Group assistant", channel: "whatsapp", contextKind: "group" });
    expect(() => resolveServiceActor(f.origin)).toThrow(/Link your Plex/);
    const prepared = prepareAccountLink(f.challenge.token, f.sessionA, f.userA);
    expect(() => resolveServiceActor(f.origin)).toThrow(/Link your Plex/);
    const stored = JSON.stringify(db.select().from(schema.mcpLinkChallenges).all());
    const logs = JSON.stringify(vi.mocked(logger.info).mock.calls);
    for (const secret of [f.challenge.token, prepared.completionCode, f.sessionA, "sender-A", "group-A"]) {
      expect(stored).not.toContain(secret);
      expect(logs).not.toContain(secret);
    }
    expect(completeAccountLink(await f.privateContext(prepared.completionCode), prepared.completionCode)).toEqual({ linked: true });
    expect(resolveServiceActor(await f.context())).toMatchObject({ actorUserId: f.userA, actorPlexId: "plex-A", bindingVersion: 1 });
    expect(resolveServiceActor(await f.context())).not.toHaveProperty("permission");
    expect(() => inspectAccountLink(f.challenge.token)).toThrow(/expired|valid/);
    const replay = await f.privateContext(prepared.completionCode);
    expect(() => completeAccountLink(replay, prepared.completionCode)).toThrow();
  });

  it("does not trust legacy unsigned-header bindings or select an account by display name", async () => {
    const f = await pending();
    db.insert(schema.mcpChannelIdentities).values({ channelType: "whatsapp", channelUserId: "sender-A", userId: adminId }).run();
    expect(() => resolveServiceActor(f.origin)).toThrow();
    const prepared = prepareAccountLink(f.challenge.token, f.sessionA, f.userA);
    completeAccountLink(await f.privateContext(prepared.completionCode), prepared.completionCode);
    expect(resolveServiceActor(await f.context()).actorUserId).toBe(f.userA);
    expect(resolveServiceActor(await f.context()).actorUserId).not.toBe(f.userB);
  });

  it("enforces current operation scope and refuses a model/tool call as private completion proof", async () => {
    const f = await pending();
    const code = prepareAccountLink(f.challenge.token, f.sessionA, f.userA).completionCode;
    expect(() => completeAccountLink(f.origin, code)).toThrow(/Private sender/);
    const commandWithoutEvent = await f.context({ source: "command", kind: "direct", conversation: "private-A", intent: `link-confirm:${code}` });
    expect(() => completeAccountLink(commandWithoutEvent, code)).toThrow(/Private sender/);
    const privateProof = await f.privateContext(code);
    db.update(schema.mcpServicePrincipals).set({ allowedOperations: JSON.stringify(["media_search"]) }).where(eq(schema.mcpServicePrincipals.id, f.principal.id)).run();
    expect(() => initiateAccountLink(f.origin)).toThrow(/not permitted/);
    expect(() => completeAccountLink(privateProof, code)).toThrow(/not permitted/);
    expect(db.select().from(schema.mcpActorBindings).all()).toHaveLength(0);
    expect(db.select().from(schema.mcpDelegationEvents).all()).toHaveLength(0);
  });

  it("rejects forwarded-link completion by a different sender/account and binds only the original context", async () => {
    const f = await pending();
    const code = prepareAccountLink(f.challenge.token, f.sessionA, f.userA).completionCode;
    const contexts = [await f.privateContext(code, { sender: "sender-B" }), await f.privateContext(code, { account: "account-B" })];
    for (const context of contexts) expect(() => completeAccountLink(context, code)).toThrow(/another participant/);
    completeAccountLink(await f.privateContext(code), code);
    const awaitedOtherGroup = await f.context({ conversation: "group-B" });
    expect(() => resolveServiceActor(awaitedOtherGroup)).toThrow(/Link your Plex/);
    const awaitedOtherSender = await f.context({ sender: "sender-B" });
    expect(() => resolveServiceActor(awaitedOtherSender)).toThrow(/Link your Plex/);
  });

  it("expires links after five minutes, and new challenges supersede only the exact sender/context scope", async () => {
    const f = await pending();
    const other = initiateAccountLink(await f.context({ sender: "sender-B" }));
    if (other.linked) throw new Error();
    const oldCode = prepareAccountLink(f.challenge.token, f.sessionA, f.userA).completionCode;
    const replacement = initiateAccountLink(await f.context());
    if (replacement.linked) throw new Error();
    expect(() => inspectAccountLink(f.challenge.token)).toThrow();
    const retained = await f.privateContext(oldCode);
    expect(() => completeAccountLink(retained, oldCode)).toThrow();
    expect(() => inspectAccountLink(other.token)).not.toThrow();
    vi.setSystemTime(new Date(Date.now() + LINK_CHALLENGE_TTL_MS));
    expect(() => inspectAccountLink(replacement.token)).toThrow();
    const fresh = initiateAccountLink(await f.context());
    expect(fresh.linked).toBe(false);
  });

  it("pins browser preparation to the real user and session, rotates codes without extending lifetime", async () => {
    const f = await pending();
    expect(() => prepareAccountLink(f.challenge.token, f.sessionB, f.userA)).toThrow(/Sign in/);
    const first = prepareAccountLink(f.challenge.token, f.sessionA, f.userA);
    expect(() => prepareAccountLink(f.challenge.token, f.sessionB, f.userB)).toThrow(/another signed-in session/);
    expect(() => prepareAccountLink(f.challenge.token, seedSession(db, f.userA), f.userA)).toThrow(/another signed-in session/);
    const next = prepareAccountLink(f.challenge.token, f.sessionA, f.userA);
    expect(next.completionCode).not.toBe(first.completionCode);
    expect(next.expiresAt).toEqual(first.expiresAt);
    const old = await f.privateContext(first.completionCode);
    expect(() => completeAccountLink(old, first.completionCode)).toThrow();
    completeAccountLink(await f.privateContext(next.completionCode), next.completionCode);
  });

  it.each(["credential", "key", "principal"])("invalidates an in-flight link when original %s authority is revoked", async (target) => {
    const f = await pending();
    const code = prepareAccountLink(f.challenge.token, f.sessionA, f.userA).completionCode;
    const context = await f.privateContext(code);
    if (target === "credential") revokeServiceCredential(f.principal.id, f.credential.id, adminId);
    if (target === "key") revokeServiceKey(f.principal.id, f.key.id, adminId);
    if (target === "principal") db.update(schema.mcpServicePrincipals).set({ enabled: false }).where(eq(schema.mcpServicePrincipals.id, f.principal.id)).run();
    expect(() => inspectAccountLink(f.challenge.token)).toThrow();
    expect(() => completeAccountLink(context, code)).toThrow();
    expect(db.select().from(schema.mcpActorBindings).all()).toHaveLength(0);
  });

  it.each(["session", "plex-identity"])("does not complete when prepared browser %s is no longer valid", async (target) => {
    const f = await pending();
    const code = prepareAccountLink(f.challenge.token, f.sessionA, f.userA).completionCode;
    if (target === "session") db.delete(schema.sessions).where(eq(schema.sessions.id, f.sessionA)).run();
    else db.update(schema.users).set({ plexId: "changed-id" }).where(eq(schema.users.id, f.userA)).run();
    const context = await f.privateContext(code);
    expect(() => completeAccountLink(context, code)).toThrow();
    expect(db.select().from(schema.mcpActorBindings).all()).toHaveLength(0);
  });

  it("allows owner unlink/admin revoke, invalidates versions and prevents silent re-linking to another Plex account", async () => {
    const f = await pending();
    const code = prepareAccountLink(f.challenge.token, f.sessionA, f.userA).completionCode;
    completeAccountLink(await f.privateContext(code), code);
    const linked = resolveServiceActor(await f.context());
    expect(listAccountBindings(f.userB)).toEqual([]);
    expect(() => revokeAccountBinding(linked.bindingId, f.userB)).toThrow(/not found/);
    expect(() => revokeAccountBinding(linked.bindingId, f.userB, f.principal.id)).toThrow(/Admin/);
    revokeAccountBinding(linked.bindingId, adminId, f.principal.id);
    expect(() => resolveServiceActor(f.origin)).toThrow();
    const next = initiateAccountLink(await f.context());
    if (next.linked) throw new Error();
    const replacementCode = prepareAccountLink(next.token, f.sessionB, f.userB).completionCode;
    const replacementContext = await f.privateContext(replacementCode);
    expect(() => completeAccountLink(replacementContext, replacementCode)).toThrow(/already bound to another account/);
    const same = initiateAccountLink(await f.context());
    if (same.linked) throw new Error();
    const sameCode = prepareAccountLink(same.token, f.sessionA, f.userA).completionCode;
    completeAccountLink(await f.privateContext(sameCode), sameCode);
    expect(resolveServiceActor(await f.context()).bindingVersion).toBeGreaterThan(linked.bindingVersion);
    revokeAccountBinding(linked.bindingId, f.userA);
    const awaitedFresh = await f.context();
    expect(() => resolveServiceActor(awaitedFresh)).toThrow();
  });

  it("consumes completion and provider event in the same transaction with one resulting binding", async () => {
    const f = await pending();
    const code = prepareAccountLink(f.challenge.token, f.sessionA, f.userA).completionCode;
    const first = await f.privateContext(code);
    const second = await f.privateContext(code);
    completeAccountLink(first, code);
    expect(() => completeAccountLink(second, code)).toThrow();
    expect(db.select().from(schema.mcpActorBindings).all()).toHaveLength(1);
    expect(db.select().from(schema.mcpDelegationEvents).all()).toHaveLength(1);
    expect(db.select().from(schema.mcpServiceAudit).all().filter((event) => event.action === "binding_linked")[0].actorUserId).toBe(f.userA);
  });
});
