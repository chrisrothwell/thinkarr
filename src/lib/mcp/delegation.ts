import { createHash, randomUUID } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { decodeJwt, decodeProtectedHeader, importSPKI, jwtVerify } from "jose";
import { z } from "zod";
import { getDb, schema } from "@/lib/db";
import type { ServiceMcpContext } from "./auth-context";
import { SERVICE_OPERATIONS } from "./service-principals";

export const DELEGATION_CLOCK_SKEW_SECONDS = 5;
export const DELEGATION_MAX_LIFETIME_SECONDS = 60;
export const DELEGATION_EVENT_MAX_AGE_SECONDS = 900;
const audienceKey = "mcp.delegationAudience";
const verified = Symbol("verified-delegation");
const text = z.string().min(1).max(512);
const headerSchema = z.object({
  alg: z.literal("EdDSA"), typ: z.literal("thinkarr-delegation+jwt"),
  kid: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/),
}).strict();

const claimsSchema = z.object({
  v: z.literal(1), iss: z.string().min(1).max(200), aud: z.string().min(1).max(200),
  service: z.string().uuid(), channel: text, account: text, sender: text,
  kind: z.enum(["direct", "group"]), conversation: text,
  source: z.enum(["tool", "message", "command"]),
  iat: z.number().int().nonnegative(), exp: z.number().int().nonnegative(),
  jti: z.string().min(16).max(128), method: z.enum(["POST", "GET", "DELETE"]),
  target: z.string().min(1).max(4096).startsWith("/"), bodyHash: z.string().regex(/^[a-f0-9]{64}$/),
  intent: z.string().max(180).optional(), choice: z.number().int().min(1).max(99).optional(),
  eventId: text.optional(), eventTime: z.number().int().nonnegative().optional(),
  replyTo: text.optional(), requiresQuote: z.boolean().optional(),
}).strict().superRefine((c, ctx) => {
  let valid = c.exp > c.iat && c.exp - c.iat <= DELEGATION_MAX_LIFETIME_SECONDS;
  if (c.source === "tool") valid &&= [c.intent, c.choice, c.eventId, c.eventTime, c.replyTo, c.requiresQuote].every((v) => v === undefined);
  if (c.source === "message") {
    valid &&= c.eventId !== undefined && c.eventTime !== undefined;
    valid &&= (c.intent === "confirm-current" && c.choice === undefined)
      || (c.intent === "confirm-choice" && c.choice !== undefined && c.requiresQuote === undefined)
      || (c.kind === "direct" && /^link-confirm:[A-Za-z0-9-]+$/.test(c.intent ?? "") && c.choice === undefined);
  }
  if (c.source === "command") {
    valid &&= c.choice === undefined && c.eventId === undefined && c.eventTime === undefined && c.replyTo === undefined && c.requiresQuote === undefined;
    valid &&= c.intent === "link-start" || /^confirm:[A-Za-z0-9-]+$/.test(c.intent ?? "")
      || (c.kind === "direct" && /^link-confirm:[A-Za-z0-9-]+$/.test(c.intent ?? ""));
  }
  if (!valid) ctx.addIssue({ code: "custom", message: "Invalid delegation profile" });
});

export type DelegationClaims = z.infer<typeof claimsSchema>;
export interface VerifiedServiceMcpContext extends ServiceMcpContext {
  readonly delegation: Readonly<DelegationClaims>;
  readonly verificationKeyId: string;
  readonly [verified]: true;
}

export class DelegationError extends Error {
  constructor(public code: "INVALID_ASSERTION" | "INVALID_REQUEST_BINDING" | "INACTIVE_SERVICE" | "REPLAYED_ASSERTION" | "INVALID_EVENT" | "REPLAYED_EVENT") {
    super("Delegated request could not be authorized");
  }
}

/** Public instance identity, independent of proxy headers and administrator credentials. */
export function getDelegationAudience(): string {
  const db = getDb();
  const c = schema.appConfig;
  let row = db.select().from(c).where(eq(c.key, audienceKey)).get();
  if (!row) {
    db.insert(c).values({ key: audienceKey, value: randomUUID() }).onConflictDoNothing().run();
    row = db.select().from(c).where(eq(c.key, audienceKey)).get();
  }
  if (!row?.value) throw new DelegationError("INACTIVE_SERVICE");
  return row.value;
}

type ReadStore = Pick<ReturnType<typeof getDb>, "select">;
type ReplayStore = Pick<ReturnType<typeof getDb>, "select" | "insert" | "delete">;
function requireActive(db: ReadStore, caller: ServiceMcpContext, keyId: string, now: Date) {
  const p = schema.mcpServicePrincipals;
  const c = schema.mcpServiceCredentials;
  const k = schema.mcpServiceKeys;
  const row = db.select({
    enabled: p.enabled, allowedOperations: p.allowedOperations, expiresAt: c.expiresAt,
    revokedAt: c.revokedAt, keyRevokedAt: k.revokedAt, publicKeyPem: k.publicKeyPem,
  }).from(p).innerJoin(c, and(eq(c.principalId, p.id), eq(c.id, caller.credentialId)))
    .innerJoin(k, and(eq(k.principalId, p.id), eq(k.id, keyId)))
    .where(eq(p.id, caller.principalId)).get();
  if (!row?.enabled || row.revokedAt || row.keyRevokedAt || row.expiresAt <= now) throw new DelegationError("INACTIVE_SERVICE");
  let allowedOperations: string[];
  try { allowedOperations = z.array(z.enum(SERVICE_OPERATIONS)).parse(JSON.parse(row.allowedOperations)); }
  catch { throw new DelegationError("INACTIVE_SERVICE"); }
  return { ...row, allowedOperations };
}

/** Verify authenticated metadata and durably consume this HTTP request's nonce.
 * This does not resolve a human binding or authorize a media operation.
 */
export async function verifyDelegatedRequest(request: Request, body: Uint8Array, caller: ServiceMcpContext): Promise<VerifiedServiceMcpContext> {
  const assertion = request.headers.get("Thinkarr-Delegation");
  if (!assertion || assertion.length > 16384) throw new DelegationError("INVALID_ASSERTION");
  const db = getDb();
  let claims: DelegationClaims;
  let key: typeof schema.mcpServiceKeys.$inferSelect;
  try {
    const protectedHeader = headerSchema.parse(decodeProtectedHeader(assertion));
    const untrusted = claimsSchema.parse(decodeJwt(assertion));
    if (untrusted.service !== caller.principalId) throw new Error();
    const found = db.select().from(schema.mcpServiceKeys).where(and(
      eq(schema.mcpServiceKeys.principalId, caller.principalId),
      eq(schema.mcpServiceKeys.issuer, untrusted.iss), eq(schema.mcpServiceKeys.keyId, protectedHeader.kid),
    )).get();
    if (!found || found.revokedAt) throw new Error();
    key = found;
    requireActive(db, caller, key.id, new Date());
    const result = await jwtVerify(assertion, await importSPKI(key.publicKeyPem, "EdDSA"), {
      algorithms: ["EdDSA"], typ: "thinkarr-delegation+jwt", issuer: key.issuer,
      audience: getDelegationAudience(), clockTolerance: DELEGATION_CLOCK_SKEW_SECONDS,
      requiredClaims: ["iat", "exp", "jti"],
    });
    claims = claimsSchema.parse(result.payload);
    if (claims.iat > Math.floor(Date.now() / 1000) + DELEGATION_CLOCK_SKEW_SECONDS) throw new Error();
  } catch { throw new DelegationError("INVALID_ASSERTION"); }
  const url = new URL(request.url);
  if (claims.method !== request.method || claims.target !== url.pathname + url.search
    || claims.bodyHash !== createHash("sha256").update(body).digest("hex")) throw new DelegationError("INVALID_REQUEST_BINDING");
  return db.transaction((tx) => {
    const now = new Date();
    const seconds = Math.floor(now.getTime() / 1000);
    const active = requireActive(tx, caller, key.id, now);
    if (active.publicKeyPem !== key.publicKeyPem || claims.exp + DELEGATION_CLOCK_SKEW_SECONDS <= seconds) throw new DelegationError("INVALID_ASSERTION");
    tx.delete(schema.mcpDelegationNonces).where(lt(schema.mcpDelegationNonces.expiresAt, seconds)).run();
    const inserted = tx.insert(schema.mcpDelegationNonces).values({
      principalId: caller.principalId, issuer: claims.iss, nonce: claims.jti,
      expiresAt: claims.exp + DELEGATION_CLOCK_SKEW_SECONDS,
    }).onConflictDoNothing().run();
    if (inserted.changes !== 1) throw new DelegationError("REPLAYED_ASSERTION");
    return Object.freeze({
      ...caller, enabled: active.enabled, allowedOperations: Object.freeze(active.allowedOperations),
      delegation: Object.freeze(claims), verificationKeyId: key.id, [verified]: true as const,
    });
  }, { behavior: "immediate" });
}

/** Mutating operations consume provider events separately from HTTP nonce replay.
 * Handlers must first validate the binding, current selection and operation.
 */
export function consumeDelegatedEvent(context: VerifiedServiceMcpContext, transaction?: ReplayStore): void {
  const c = context.delegation;
  const now = Math.floor(Date.now() / 1000);
  if (context[verified] !== true || c.source !== "message" || !c.eventId || c.eventTime === undefined
    || c.exp + DELEGATION_CLOCK_SKEW_SECONDS <= now
    || c.eventTime > (now + DELEGATION_CLOCK_SKEW_SECONDS) * 1000
    || c.eventTime + (DELEGATION_EVENT_MAX_AGE_SECONDS + DELEGATION_CLOCK_SKEW_SECONDS) * 1000 <= now * 1000) {
    throw new DelegationError("INVALID_EVENT");
  }
  const eventTime = c.eventTime;
  const eventHash = createHash("sha256").update(JSON.stringify([
    context.principalId, c.iss, c.channel, c.account, c.sender, c.kind, c.conversation, c.eventId,
  ])).digest("hex");
  const consume = (tx: ReplayStore) => {
    requireActive(tx, context, context.verificationKeyId, new Date());
    tx.delete(schema.mcpDelegationEvents).where(lt(schema.mcpDelegationEvents.expiresAt, now)).run();
    const result = tx.insert(schema.mcpDelegationEvents).values({
      eventHash, principalId: context.principalId, createdAt: now,
      expiresAt: Math.floor(eventTime / 1000) + DELEGATION_EVENT_MAX_AGE_SECONDS + DELEGATION_CLOCK_SKEW_SECONDS,
    }).onConflictDoNothing().run();
    if (result.changes !== 1) throw new DelegationError("REPLAYED_EVENT");
  };
  if (transaction) consume(transaction);
  else getDb().transaction(consume, { behavior: "immediate" });
}
