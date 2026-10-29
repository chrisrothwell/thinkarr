import { createHash, createPublicKey, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/lib/db";
import { logger } from "@/lib/logger";
import type { ServiceMcpContext } from "./auth-context";
import { publicLinkOriginSchema, whatsappBotNumberSchema } from "./link-handoff";
import { whatsappGroupSchema } from "./integration-policy";

export const SERVICE_TOKEN_PREFIX = "thk_svc_";
export const DELEGATED_MCP_AVAILABLE = true;
export const SERVICE_OPERATIONS = [
  "media_search", "media_details", "media_select", "media_pending_selection",
  "media_confirm_request", "account_link_start", "account_link_confirm",
] as const;
const operations = z.array(z.enum(SERVICE_OPERATIONS)).max(SERVICE_OPERATIONS.length)
  .refine((items) => new Set(items).size === items.length, "Duplicate operations");
export const createIntegrationSchema = z.object({
  name: z.string().trim().min(1).max(100),
  allowedOperations: operations.default(["media_search", "media_details"]),
  publicLinkOrigin: publicLinkOriginSchema.nullable().optional(),
  whatsappBotNumber: whatsappBotNumberSchema.nullable().optional(),
  pilotGroup: whatsappGroupSchema.nullable().optional(),
}).strict();
export const updateIntegrationSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  allowedOperations: operations.optional(),
  enabled: z.boolean().optional(),
  publicLinkOrigin: publicLinkOriginSchema.nullable().optional(),
  whatsappBotNumber: whatsappBotNumberSchema.nullable().optional(),
  pilotGroup: whatsappGroupSchema.nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "No changes supplied");
export const issueCredentialSchema = z.object({
  expiresInDays: z.number().int().min(1).max(365).default(90),
  replaceCredentialId: z.string().uuid().optional(),
  overlapMinutes: z.number().int().min(0).max(60).default(0),
}).strict().refine((value) => value.overlapMinutes === 0 || value.replaceCredentialId !== undefined, "Overlap requires a replacement");
export const registerKeySchema = z.object({
  issuer: z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9:/.@_-]*$/),
  keyId: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/),
  publicKeyPem: z.string().min(1).max(4096),
}).strict();

export class IntegrationError extends Error {
  constructor(message: string, public status: 400 | 404 | 409) { super(message); }
}

type AuditDb = Pick<ReturnType<typeof getDb>, "insert">;
function audit(db: AuditDb, principalId: string, actorUserId: number | null, action: string, targetId?: string) {
  db.insert(schema.mcpServiceAudit).values({ id: randomUUID(), principalId, actorUserId, action, targetId }).run();
  logger.info("MCP_INTEGRATION_AUDIT", { principalId, actorUserId, action, targetId });
}
export { audit as recordServiceAudit };

function principalOrThrow(id: string) {
  const row = getDb().select().from(schema.mcpServicePrincipals).where(eq(schema.mcpServicePrincipals.id, id)).get();
  if (!row) throw new IntegrationError("Integration not found", 404);
  return row;
}

function publicPrincipal(row: typeof schema.mcpServicePrincipals.$inferSelect) {
  return { ...row, allowedOperations: operations.parse(JSON.parse(row.allowedOperations)) };
}

export function listIntegrations() {
  return getDb().select().from(schema.mcpServicePrincipals).orderBy(desc(schema.mcpServicePrincipals.createdAt)).all().map(publicPrincipal);
}

export function getIntegration(id: string) {
  const principal = publicPrincipal(principalOrThrow(id));
  const db = getDb();
  const c = schema.mcpServiceCredentials;
  const credentials = db.select({
    id: c.id, prefix: c.prefix, createdAt: c.createdAt, expiresAt: c.expiresAt,
    revokedAt: c.revokedAt, lastUsedAt: c.lastUsedAt,
  }).from(c).where(eq(c.principalId, id)).all();
  const keys = db.select().from(schema.mcpServiceKeys).where(eq(schema.mcpServiceKeys.principalId, id)).all();
  const audit = db.select().from(schema.mcpServiceAudit).where(eq(schema.mcpServiceAudit.principalId, id))
    .orderBy(desc(schema.mcpServiceAudit.createdAt)).limit(20).all();
  const b = schema.mcpActorBindings;
  const bindings = db.select({ id: b.id, userId: b.userId, channel: b.channel, contextKind: b.contextKind, createdAt: b.createdAt, revokedAt: b.revokedAt })
    .from(b).where(eq(b.principalId, id)).all();
  return { ...principal, credentials, keys, audit, bindings };
}

export function createIntegration(input: z.input<typeof createIntegrationSchema>, actorUserId: number) {
  const value = createIntegrationSchema.parse(input);
  const db = getDb();
  const row = db.transaction((tx) => {
    const created = tx.insert(schema.mcpServicePrincipals).values({
      id: randomUUID(), name: value.name, allowedOperations: JSON.stringify(value.allowedOperations), createdByUserId: actorUserId,
      publicLinkOrigin: value.publicLinkOrigin, whatsappBotNumber: value.whatsappBotNumber,
      pilotGroup: value.pilotGroup,
    }).returning().get();
    audit(tx, created.id, actorUserId, "principal_created");
    return created;
  });
  return publicPrincipal(row);
}

export function updateIntegration(id: string, input: z.input<typeof updateIntegrationSchema>, actorUserId: number) {
  const value = updateIntegrationSchema.parse(input);
  principalOrThrow(id);
  const db = getDb();
  db.transaction((tx) => {
    const principal = tx.select().from(schema.mcpServicePrincipals).where(eq(schema.mcpServicePrincipals.id, id)).get()!;
    const enabled = value.enabled ?? principal.enabled;
    const group = value.pilotGroup !== undefined ? value.pilotGroup : principal.pilotGroup;
    const origin = value.publicLinkOrigin !== undefined ? value.publicLinkOrigin : principal.publicLinkOrigin;
    const bot = value.whatsappBotNumber !== undefined ? value.whatsappBotNumber : principal.whatsappBotNumber;
    if (enabled && (!whatsappGroupSchema.safeParse(group).success || !origin || !bot)) {
      throw new IntegrationError("Configure the WhatsApp group, public linking origin and bot number before enabling the integration", 409);
    }
    const groupChanged = value.pilotGroup !== undefined && value.pilotGroup !== principal.pilotGroup;
    tx.update(schema.mcpServicePrincipals).set({
      ...(value.name !== undefined ? { name: value.name } : {}),
      ...(value.allowedOperations !== undefined ? { allowedOperations: JSON.stringify(value.allowedOperations) } : {}),
      ...(value.enabled !== undefined ? { enabled: value.enabled } : {}), updatedAt: new Date(),
      ...(value.pilotGroup !== undefined ? { pilotGroup: value.pilotGroup } : {}),
      ...(value.publicLinkOrigin !== undefined ? { publicLinkOrigin: value.publicLinkOrigin } : {}),
      ...(value.whatsappBotNumber !== undefined ? { whatsappBotNumber: value.whatsappBotNumber } : {}),
    }).where(eq(schema.mcpServicePrincipals.id, id)).run();
    if ((value.publicLinkOrigin !== undefined && value.publicLinkOrigin !== principal.publicLinkOrigin)
      || (value.whatsappBotNumber !== undefined && value.whatsappBotNumber !== principal.whatsappBotNumber) || groupChanged) {
      tx.update(schema.mcpLinkChallenges).set({ consumedAt: new Date() }).where(and(
        eq(schema.mcpLinkChallenges.principalId, id), isNull(schema.mcpLinkChallenges.consumedAt),
      )).run();
    }
    if (groupChanged) {
      tx.update(schema.mcpActorBindings).set({ revokedAt: new Date(), updatedAt: new Date(), version: sql`${schema.mcpActorBindings.version} + 1` })
        .where(and(eq(schema.mcpActorBindings.principalId, id), isNull(schema.mcpActorBindings.revokedAt))).run();
    }
    if (groupChanged || value.enabled === false || (value.publicLinkOrigin !== undefined && value.publicLinkOrigin !== principal.publicLinkOrigin)
      || (value.whatsappBotNumber !== undefined && value.whatsappBotNumber !== principal.whatsappBotNumber)
      || (value.allowedOperations !== undefined && JSON.stringify(value.allowedOperations) !== principal.allowedOperations)) {
      tx.update(schema.mcpSetupGrants).set({ consumedAt: new Date() }).where(and(eq(schema.mcpSetupGrants.principalId, id), isNull(schema.mcpSetupGrants.consumedAt))).run();
    }
    audit(tx, id, actorUserId, value.enabled === false ? "principal_disabled" : "principal_updated");
  }, { behavior: "immediate" });
  return getIntegration(id);
}

export function issueServiceCredential(id: string, input: z.input<typeof issueCredentialSchema>, actorUserId: number) {
  const value = issueCredentialSchema.parse(input);
  principalOrThrow(id);
  const credentialId = randomUUID();
  const token = `${SERVICE_TOKEN_PREFIX}${credentialId}.${randomBytes(32).toString("hex")}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + value.expiresInDays * 86400_000);
  const prefix = `${SERVICE_TOKEN_PREFIX}${credentialId.slice(0, 8)}`;
  const db = getDb();
  db.transaction((tx) => {
    const c = schema.mcpServiceCredentials;
    const active = tx.select().from(c).where(and(eq(c.principalId, id), isNull(c.revokedAt), gt(c.expiresAt, now))).all();
    if (active.length >= 2 || (!value.replaceCredentialId && active.length > 0)) {
      throw new IntegrationError("Rotate or revoke an active credential before issuing another", 409);
    }
    if (value.replaceCredentialId) {
      const old = active.find((row) => row.id === value.replaceCredentialId);
      if (!old) throw new IntegrationError("Active replacement credential not found", 404);
      if (value.overlapMinutes === 0) tx.update(c).set({ revokedAt: now }).where(eq(c.id, old.id)).run();
      else tx.update(c).set({ expiresAt: new Date(Math.min(old.expiresAt.getTime(), now.getTime() + value.overlapMinutes * 60_000)) }).where(eq(c.id, old.id)).run();
      audit(tx, id, actorUserId, "credential_rotated", old.id);
    }
    tx.insert(c).values({
      id: credentialId, principalId: id, tokenHash: createHash("sha256").update(token).digest("hex"),
      prefix, createdByUserId: actorUserId, expiresAt,
    }).run();
    tx.update(schema.mcpSetupGrants).set({ consumedAt: new Date() }).where(and(eq(schema.mcpSetupGrants.principalId, id), isNull(schema.mcpSetupGrants.consumedAt))).run();
    audit(tx, id, actorUserId, "credential_issued", credentialId);
  }, { behavior: "immediate" });
  // Only the creation response includes the secret. No getter reconstructs it.
  return { id: credentialId, token, prefix, expiresAt };
}

export function revokeServiceCredential(id: string, credentialId: string, actorUserId: number) {
  principalOrThrow(id);
  const db = getDb();
  db.transaction((tx) => {
    const c = schema.mcpServiceCredentials;
    const row = tx.select().from(c).where(and(eq(c.id, credentialId), eq(c.principalId, id))).get();
    if (!row) throw new IntegrationError("Credential not found", 404);
    if (!row.revokedAt) {
      tx.update(c).set({ revokedAt: new Date() }).where(eq(c.id, credentialId)).run();
      audit(tx, id, actorUserId, "credential_revoked", credentialId);
    }
  });
}

export function registerServiceKey(id: string, input: z.input<typeof registerKeySchema>, actorUserId: number) {
  const value = registerKeySchema.parse(input);
  principalOrThrow(id);
  let publicKeyPem: string;
  try {
    if (value.publicKeyPem.includes("PRIVATE KEY") || !value.publicKeyPem.includes("BEGIN PUBLIC KEY")) throw new Error();
    const key = createPublicKey(value.publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") throw new Error();
    publicKeyPem = key.export({ type: "spki", format: "pem" }).toString();
  } catch { throw new IntegrationError("An Ed25519 public key is required; never upload a private key", 400); }
  const db = getDb();
  return db.transaction((tx) => {
    const k = schema.mcpServiceKeys;
    const existing = tx.select().from(k).where(eq(k.principalId, id)).all();
    if (existing.some((row) => row.issuer === value.issuer && row.keyId === value.keyId)) throw new IntegrationError("Issuer/key ID already registered; use a new key ID for rotation", 409);
    if (existing.filter((row) => !row.revokedAt).length >= 4) throw new IntegrationError("Revoke an existing key before registering another", 409);
    const row = tx.insert(k).values({ id: randomUUID(), principalId: id, issuer: value.issuer, keyId: value.keyId, publicKeyPem }).returning().get();
    audit(tx, id, actorUserId, "key_registered", row.id);
    return row;
  }, { behavior: "immediate" });
}

export function revokeServiceKey(id: string, keyId: string, actorUserId: number) {
  principalOrThrow(id);
  const db = getDb();
  db.transaction((tx) => {
    const k = schema.mcpServiceKeys;
    const row = tx.select().from(k).where(and(eq(k.id, keyId), eq(k.principalId, id))).get();
    if (!row) throw new IntegrationError("Key not found", 404);
    if (!row.revokedAt) {
      tx.update(k).set({ revokedAt: new Date() }).where(eq(k.id, keyId)).run();
      audit(tx, id, actorUserId, "key_revoked", keyId);
    }
  });
}

export function isServiceMcpToken(token: string): boolean { return token.startsWith(SERVICE_TOKEN_PREFIX); }

/** Recognizes credentials even for disabled principals, without falling back to personal/admin auth. */
export function authenticateServiceMcpToken(token: string): ServiceMcpContext | null {
  if (!/^thk_svc_[0-9a-f-]{36}\.[0-9a-f]{64}$/.test(token)) return null;
  const db = getDb();
  const c = schema.mcpServiceCredentials;
  const p = schema.mcpServicePrincipals;
  const row = db.select({
    principalId: p.id, credentialId: c.id, enabled: p.enabled, allowedOperations: p.allowedOperations,
  }).from(c).innerJoin(p, eq(c.principalId, p.id)).where(and(
    eq(c.tokenHash, createHash("sha256").update(token).digest("hex")), isNull(c.revokedAt), gt(c.expiresAt, new Date()),
  )).get();
  if (!row) return null;
  let allowedOperations: string[];
  try { allowedOperations = operations.parse(JSON.parse(row.allowedOperations)); } catch { return null; }
  db.update(c).set({ lastUsedAt: new Date() }).where(eq(c.id, row.credentialId)).run();
  return { kind: "service", ...row, allowedOperations };
}

export function recordServiceMcpDenial(context: ServiceMcpContext) {
  audit(getDb(), context.principalId, null, "service_access_denied", context.credentialId);
}
