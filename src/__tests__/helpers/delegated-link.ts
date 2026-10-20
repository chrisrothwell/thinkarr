import { generateKeyPairSync, createHash, randomUUID } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";
import { eq } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { authenticateServiceMcpToken, createIntegration, issueServiceCredential, registerServiceKey } from "@/lib/mcp/service-principals";
import { getDelegationAudience, verifyDelegatedRequest, type DelegationClaims } from "@/lib/mcp/delegation";
import { seedSession, seedUser, type TestDb } from "./db";

export async function delegatedLinkFixture(db: TestDb, adminId: number) {
  const principal = createIntegration({ name: "Group assistant", allowedOperations: ["account_link_start", "account_link_confirm", "media_search"], publicLinkOrigin: "https://thinkarr.invalid", whatsappBotNumber: "15555550100" }, adminId);
  // Test preparation only: production management/transport gates remain disabled.
  db.update(schema.mcpServicePrincipals).set({ enabled: true }).where(eq(schema.mcpServicePrincipals.id, principal.id)).run();
  const credential = issueServiceCredential(principal.id, {}, adminId);
  const pair = generateKeyPairSync("ed25519");
  const key = registerServiceKey(principal.id, { issuer: "connector:test", keyId: "key-1", publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString() }, adminId);
  const privateKey = await importPKCS8(pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), "EdDSA");
  const userA = seedUser(db, { plexId: "plex-A", plexUsername: "same-display-name" });
  const userB = seedUser(db, { plexId: "plex-B", plexUsername: "same-display-name" });
  const sessionA = seedSession(db, userA);
  const sessionB = seedSession(db, userB);
  async function signedRequest(envelope: unknown, patch: Partial<DelegationClaims> = {}, target = "/api/mcp") {
    const now = Math.floor(Date.now() / 1000);
    const raw = typeof envelope === "string" ? envelope : JSON.stringify(envelope);
    const body = new TextEncoder().encode(raw);
    const claims: DelegationClaims = {
      v: 1, iss: key.issuer, aud: getDelegationAudience(), service: principal.id,
      channel: "whatsapp", account: "account-A", sender: "sender-A", kind: "group", conversation: "group-A",
      source: "tool", iat: now, exp: now + 60, jti: randomUUID(), method: "POST", target,
      bodyHash: createHash("sha256").update(body).digest("hex"), ...patch,
    };
    const token = await new SignJWT(claims).setProtectedHeader({ alg: "EdDSA", typ: "thinkarr-delegation+jwt", kid: key.keyId }).sign(privateKey);
    return new Request(`https://thinkarr.invalid${target}`, {
      method: "POST", body: raw,
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${credential.token}`, "Thinkarr-Delegation": token },
    });
  }
  async function context(patch: Partial<DelegationClaims> = {}) {
    const request = await signedRequest("{}", patch);
    return verifyDelegatedRequest(request, new TextEncoder().encode("{}"), authenticateServiceMcpToken(credential.token)!);
  }
  async function privateContext(code: string, patch: Partial<DelegationClaims> = {}) {
    return context({ kind: "direct", conversation: "private-A", source: "message", intent: `link-confirm:${code}`, eventId: randomUUID(), eventTime: Date.now(), ...patch });
  }
  return { principal, credential, key, userA, userB, sessionA, sessionB, context, privateContext, signedRequest };
}
