import { createHash, createPublicKey, randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { getDelegationAudience } from "./delegation";
import { IntegrationError, issueServiceCredential, recordServiceAudit, registerKeySchema, registerServiceKey } from "./service-principals";
import { whatsappGroupSchema } from "./integration-policy";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const fingerprint = (p: typeof schema.mcpServicePrincipals.$inferSelect) => hash(JSON.stringify([p.pilotGroup, p.publicLinkOrigin, p.whatsappBotNumber, p.allowedOperations]));
const grants = schema.mcpSetupGrants;
export class ConnectionSetupError extends Error {
  constructor() { super("The setup code has expired or is no longer valid. Create a new code in Thinkarr Settings."); }
}

/** Owner-authorized, one-use enrollment. The code is not a service bearer. */
export function createConnectionSetup(principalId: string, actorUserId: number) {
  return getDb().transaction((tx) => {
    const p = tx.select().from(schema.mcpServicePrincipals).where(eq(schema.mcpServicePrincipals.id, principalId)).get();
    if (!p) throw new IntegrationError("Integration not found", 404);
    if (!whatsappGroupSchema.safeParse(p.pilotGroup).success || !p.publicLinkOrigin || !p.whatsappBotNumber) throw new IntegrationError("Save the group, public linking origin and bot number before creating a setup code", 409);
    const active = tx.select().from(schema.mcpServiceCredentials).where(and(eq(schema.mcpServiceCredentials.principalId, principalId), isNull(schema.mcpServiceCredentials.revokedAt), gt(schema.mcpServiceCredentials.expiresAt, new Date()))).get();
    if (active) throw new IntegrationError("An active credential already exists. Reuse its protected configuration or explicitly revoke it before enrolling another connection", 409);
    tx.delete(grants).where(lt(grants.expiresAt, new Date())).run();
    tx.update(grants).set({ consumedAt: new Date() }).where(and(eq(grants.principalId, principalId), isNull(grants.consumedAt))).run();
    const id = randomUUID(); const token = `thk_setup_${id}.${randomBytes(32).toString("hex")}`;
    const expiresAt = new Date(Date.now() + 600_000);
    tx.insert(grants).values({ id, principalId, createdByUserId: actorUserId, tokenHash: hash(token), configHash: fingerprint(p), expiresAt }).run();
    recordServiceAudit(tx, principalId, actorUserId, "connection_setup_created", id);
    return { token, expiresAt };
  }, { behavior: "immediate" });
}

/** No Plex/browser session: only the scoped owner-issued setup code can redeem. */
export function redeemConnectionSetup(token: string, input: unknown) {
  if (!/^thk_setup_[a-f0-9-]{36}\.[a-f0-9]{64}$/.test(token)) throw new ConnectionSetupError();
  const value = registerKeySchema.parse(input);
  return getDb().transaction((tx) => {
    const row = tx.select().from(grants).where(eq(grants.tokenHash, hash(token))).get();
    if (!row || row.consumedAt || row.expiresAt <= new Date()) throw new ConnectionSetupError();
    const p = tx.select().from(schema.mcpServicePrincipals).where(eq(schema.mcpServicePrincipals.id, row.principalId)).get();
    const owner = tx.select().from(schema.users).where(eq(schema.users.id, row.createdByUserId)).get();
    if (!p || !owner?.isAdmin || row.configHash !== fingerprint(p)) throw new ConnectionSetupError();
    let publicKeyPem: string;
    try {
      const key = createPublicKey(value.publicKeyPem);
      if (value.publicKeyPem.includes("PRIVATE KEY") || key.asymmetricKeyType !== "ed25519") throw new Error();
      publicKeyPem = key.export({ type: "spki", format: "pem" }).toString();
    } catch { throw new IntegrationError("An Ed25519 public key is required", 400); }
    const existing = tx.select().from(schema.mcpServiceKeys).where(and(eq(schema.mcpServiceKeys.principalId, p.id), eq(schema.mcpServiceKeys.issuer, value.issuer), eq(schema.mcpServiceKeys.keyId, value.keyId))).get();
    if (existing) {
      if (existing.revokedAt || existing.publicKeyPem !== publicKeyPem) throw new IntegrationError("Use a new key ID for this connection", 409);
    } else registerServiceKey(p.id, { ...value, publicKeyPem }, row.createdByUserId);
    const credential = issueServiceCredential(p.id, {}, row.createdByUserId);
    tx.update(grants).set({ consumedAt: new Date() }).where(eq(grants.id, row.id)).run();
    recordServiceAudit(tx, p.id, row.createdByUserId, "connection_setup_completed", row.id);
    return {
      endpoint: `${p.publicLinkOrigin}/api/mcp`, publicLinkOrigin: p.publicLinkOrigin!, service: p.id,
      issuer: value.issuer, keyId: value.keyId, audience: getDelegationAudience(), bearer: credential.token, credentialId: credential.id,
      group: p.pilotGroup!, botNumber: p.whatsappBotNumber!,
    };
  }, { behavior: "immediate" });
}
