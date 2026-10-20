import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { consumeDelegatedEvent, requireCurrentDelegation, type VerifiedServiceMcpContext } from "./delegation";
import { recordServiceAudit } from "./service-principals";

export const LINK_CHALLENGE_TTL_MS = 5 * 60_000;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type LinkStore = Pick<ReturnType<typeof getDb>, "select" | "insert" | "update" | "delete">;
type Challenge = typeof schema.mcpLinkChallenges.$inferSelect;
export class AccountLinkError extends Error {
  constructor(message: string, public status: 400 | 403 | 404 | 409 | 410) { super(message); }
}
const invalid = () => new AccountLinkError("This link has expired or is no longer valid. Ask for a new private link.", 410);

function actorHash(context: VerifiedServiceMcpContext) {
  const c = context.delegation;
  return hash(JSON.stringify([context.principalId, c.iss, c.channel, c.account, c.sender]));
}
function contextHash(context: VerifiedServiceMcpContext) {
  return hash(JSON.stringify([context.delegation.kind, context.delegation.conversation]));
}
function assertChallengeTrust(db: LinkStore, row: Challenge) {
  const p = db.select().from(schema.mcpServicePrincipals).where(eq(schema.mcpServicePrincipals.id, row.principalId)).get();
  const credential = db.select().from(schema.mcpServiceCredentials).where(and(eq(schema.mcpServiceCredentials.id, row.credentialId), eq(schema.mcpServiceCredentials.principalId, row.principalId))).get();
  const key = db.select().from(schema.mcpServiceKeys).where(and(eq(schema.mcpServiceKeys.id, row.verificationKeyId), eq(schema.mcpServiceKeys.principalId, row.principalId))).get();
  if (!p?.enabled || !credential || credential.revokedAt || credential.expiresAt <= new Date() || !key || key.revokedAt || row.consumedAt || row.expiresAt <= new Date()) throw invalid();
  return p;
}

/** Internal control result: token must go only to the trusted private-delivery adapter. */
export function initiateAccountLink(context: VerifiedServiceMcpContext) {
  const c = context.delegation;
  if (!(c.source === "tool" || (c.source === "command" && c.intent === "link-start"))) throw new AccountLinkError("Link initiation requires trusted actor context", 403);
  const token = randomBytes(32).toString("hex");
  const id = randomUUID();
  const actor = actorHash(context);
  const origin = contextHash(context);
  const expiresAt = new Date(Date.now() + LINK_CHALLENGE_TTL_MS);
  return getDb().transaction((tx) => {
    const active = requireCurrentDelegation(context, tx);
    if (!active.allowedOperations.includes("account_link_start")) throw new AccountLinkError("Linking is not permitted for this integration", 403);
    const existing = tx.select().from(schema.mcpActorBindings).where(and(
      eq(schema.mcpActorBindings.principalId, context.principalId), eq(schema.mcpActorBindings.actorHash, actor), eq(schema.mcpActorBindings.contextHash, origin),
    )).get();
    if (existing && !existing.revokedAt) {
      const user = tx.select().from(schema.users).where(eq(schema.users.id, existing.userId)).get();
      if (!user || user.plexId !== existing.plexId) throw new AccountLinkError("The existing binding needs administrator recovery", 409);
      return { linked: true as const };
    }
    // New challenges replace pending challenges in this exact scope, not other
    // senders/groups. The old browser/code must not remain usable.
    tx.update(schema.mcpLinkChallenges).set({ consumedAt: new Date() }).where(and(
      eq(schema.mcpLinkChallenges.principalId, context.principalId), eq(schema.mcpLinkChallenges.actorHash, actor),
      eq(schema.mcpLinkChallenges.contextHash, origin), isNull(schema.mcpLinkChallenges.consumedAt),
    )).run();
    tx.insert(schema.mcpLinkChallenges).values({
      id, principalId: context.principalId, credentialId: context.credentialId, verificationKeyId: context.verificationKeyId,
      tokenHash: hash(token), actorHash: actor, contextHash: origin, channel: c.channel, contextKind: c.kind, expiresAt,
    }).run();
    recordServiceAudit(tx, context.principalId, null, "link_challenge_created", id);
    return { linked: false as const, id, token, expiresAt };
  }, { behavior: "immediate" });
}

/** Browser-only lookup; never accepts identity fields or logs a token. */
export function inspectAccountLink(token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw invalid();
  const db = getDb();
  const row = db.select().from(schema.mcpLinkChallenges).where(eq(schema.mcpLinkChallenges.tokenHash, hash(token))).get();
  if (!row) throw invalid();
  const principal = assertChallengeTrust(db, row);
  return { integrationName: principal.name, channel: row.channel, contextKind: row.contextKind, expiresAt: row.expiresAt };
}

/** Normal authenticated Plex browser session supplies the account, never the connector. */
export function prepareAccountLink(token: string, sessionId: string, userId: number) {
  inspectAccountLink(token);
  const code = randomBytes(32).toString("hex");
  return getDb().transaction((tx) => {
    const row = tx.select().from(schema.mcpLinkChallenges).where(eq(schema.mcpLinkChallenges.tokenHash, hash(token))).get();
    if (!row) throw invalid();
    assertChallengeTrust(tx, row);
    const session = tx.select().from(schema.sessions).where(and(eq(schema.sessions.id, sessionId), eq(schema.sessions.userId, userId), gt(schema.sessions.expiresAt, new Date()))).get();
    const user = tx.select().from(schema.users).where(eq(schema.users.id, userId)).get();
    if (!session || !user?.plexId) throw new AccountLinkError("Sign in with Plex before linking", 403);
    if (row.browserUserId !== null && (row.browserUserId !== userId || row.browserSessionHash !== hash(sessionId))) {
      throw new AccountLinkError("This link is already being used in another signed-in session. Ask for a new private link.", 409);
    }
    // Repeat preparation in the same authenticated browser rotates the code;
    // no reusable cleartext code is stored or retrieved.
    tx.update(schema.mcpLinkChallenges).set({
      browserUserId: userId, browserPlexId: user.plexId, browserSessionHash: hash(sessionId), completionCodeHash: hash(code), browserPreparedAt: new Date(),
    }).where(eq(schema.mcpLinkChallenges.id, row.id)).run();
    recordServiceAudit(tx, row.principalId, userId, "link_browser_prepared", row.id);
    return { completionCode: code, expiresAt: row.expiresAt };
  }, { behavior: "immediate" });
}

/** Private sender proof activates a binding; opening a forwarded URL cannot. */
export function completeAccountLink(context: VerifiedServiceMcpContext, code: string) {
  const c = context.delegation;
  if (!/^[a-f0-9]{64}$/.test(code) || c.source !== "message" || c.kind !== "direct" || c.intent !== `link-confirm:${code}`) {
    throw new AccountLinkError("Private sender verification is required", 403);
  }
  return getDb().transaction((tx) => {
    const active = requireCurrentDelegation(context, tx);
    if (!active.allowedOperations.includes("account_link_confirm")) throw new AccountLinkError("Linking is not permitted for this integration", 403);
    const row = tx.select().from(schema.mcpLinkChallenges).where(and(
      eq(schema.mcpLinkChallenges.principalId, context.principalId), eq(schema.mcpLinkChallenges.completionCodeHash, hash(code)),
    )).get();
    if (!row) throw invalid();
    assertChallengeTrust(tx, row);
    if (row.actorHash !== actorHash(context) || row.browserUserId === null || !row.browserSessionHash || !row.browserPreparedAt) throw new AccountLinkError("This verification belongs to another participant", 403);
    const browserSession = tx.select().from(schema.sessions).where(and(eq(schema.sessions.userId, row.browserUserId), gt(schema.sessions.expiresAt, new Date()))).all()
      .find((session) => hash(session.id) === row.browserSessionHash);
    const user = tx.select().from(schema.users).where(eq(schema.users.id, row.browserUserId)).get();
    if (!browserSession || !user?.plexId || user.plexId !== row.browserPlexId || c.eventTime === undefined || c.eventTime + 5000 < row.browserPreparedAt.getTime()) throw invalid();
    const b = schema.mcpActorBindings;
    const existing = tx.select().from(b).where(and(eq(b.principalId, row.principalId), eq(b.actorHash, row.actorHash), eq(b.contextHash, row.contextHash))).get();
    if (existing && (existing.userId !== user.id || existing.plexId !== user.plexId)) {
      throw new AccountLinkError("This channel identity is already bound to another account. Contact the administrator to recover it.", 409);
    }
    consumeDelegatedEvent(context, tx);
    const bindingId = existing?.id ?? randomUUID();
    if (existing) tx.update(b).set({ revokedAt: null, version: existing.version + 1, updatedAt: new Date() }).where(eq(b.id, bindingId)).run();
    else tx.insert(b).values({ id: bindingId, principalId: row.principalId, actorHash: row.actorHash, contextHash: row.contextHash, channel: row.channel, contextKind: row.contextKind, userId: user.id, plexId: user.plexId }).run();
    tx.update(schema.mcpLinkChallenges).set({ consumedAt: new Date(), completionCodeHash: null }).where(eq(schema.mcpLinkChallenges.id, row.id)).run();
    recordServiceAudit(tx, row.principalId, user.id, "binding_linked", bindingId);
    // No Plex/Thinkarr/Seerr account identifiers go back to a group-facing caller.
    return { linked: true as const };
  }, { behavior: "immediate" });
}

export function resolveServiceActor(context: VerifiedServiceMcpContext) {
  requireCurrentDelegation(context);
  const b = schema.mcpActorBindings;
  const row = getDb().select({ id: b.id, userId: b.userId, plexId: b.plexId, version: b.version, revokedAt: b.revokedAt, currentPlexId: schema.users.plexId })
    .from(b).innerJoin(schema.users, eq(schema.users.id, b.userId)).where(and(
      eq(b.principalId, context.principalId), eq(b.actorHash, actorHash(context)), eq(b.contextHash, contextHash(context)),
    )).get();
  if (!row || row.revokedAt || row.plexId !== row.currentPlexId) throw new AccountLinkError("Link your Plex account in this conversation first", 403);
  return { actorUserId: row.userId, actorPlexId: row.plexId, bindingId: row.id, bindingVersion: row.version };
}

export function listAccountBindings(userId: number) {
  const b = schema.mcpActorBindings;
  return getDb().select({ id: b.id, integrationName: schema.mcpServicePrincipals.name, integrationEnabled: schema.mcpServicePrincipals.enabled, channel: b.channel, contextKind: b.contextKind, createdAt: b.createdAt, revokedAt: b.revokedAt })
    .from(b).innerJoin(schema.mcpServicePrincipals, eq(b.principalId, schema.mcpServicePrincipals.id)).where(eq(b.userId, userId)).all();
}

export function revokeAccountBinding(id: string, actorUserId: number, principalId?: string) {
  getDb().transaction((tx) => {
    const b = schema.mcpActorBindings;
    const row = tx.select().from(b).where(eq(b.id, id)).get();
    if (!row || (principalId === undefined ? row.userId !== actorUserId : row.principalId !== principalId)) throw new AccountLinkError("Binding not found", 404);
    if (principalId !== undefined) {
      const admin = tx.select().from(schema.users).where(eq(schema.users.id, actorUserId)).get();
      if (!admin?.isAdmin) throw new AccountLinkError("Admin access required", 403);
    }
    if (row.revokedAt) return;
    tx.update(b).set({ revokedAt: new Date(), updatedAt: new Date(), version: row.version + 1 }).where(eq(b.id, id)).run();
    recordServiceAudit(tx, row.principalId, actorUserId, principalId ? "binding_revoked" : "binding_unlinked", id);
  }, { behavior: "immediate" });
}
