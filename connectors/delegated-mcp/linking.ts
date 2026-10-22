import { createHash, randomUUID } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { confirmationIntent, mediaOutcome, mediaToolArguments, presentation, type MediaOutcome, type MediaTool } from "./media-contract.js";

const identity = z.string().min(1).max(512);
const actorSchema = z.object({
  channel: z.literal("whatsapp"), account: identity, sender: identity,
  kind: z.enum(["direct", "group"]), conversation: identity,
}).strict();
const eventSchema = z.object({ eventId: identity, eventTime: z.number().int().nonnegative() }).strict();
const configSchema = z.object({
  endpoint: z.string().url(), publicLinkOrigin: z.string().url(),
  service: z.string().uuid(), issuer: z.string().min(1).max(200), audience: z.string().min(1).max(200),
  keyId: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/),
  bearer: z.string().max(256).regex(/^thk_svc_[A-Za-z0-9_-]+\.[a-f0-9]{64}$/), privateKeyPem: z.string().min(1),
}).strict();

export type LinkingConnectorConfig = z.infer<typeof configSchema>;
export { configSchema as linkingConnectorConfigSchema };
/** Host-owned, canonical provider identity, never model/tool arguments. */
export type TrustedLinkInvocation = z.infer<typeof actorSchema> & {
  assertCurrent: () => void;
  signal?: AbortSignal;
};
export type TrustedLinkMessage = TrustedLinkInvocation & z.infer<typeof eventSchema>;
export type LinkOutcome = Readonly<{ status: "linked" | "private_link_sent" | "failed" }>;
export type PrivateLinkDelivery = Readonly<{
  channel: "whatsapp"; account: string; recipient: string; url: string; expiresAt: string;
  /** The host must recheck immediately before every physical provider send. */
  assertCurrent: () => void;
  signal: AbortSignal;
}>;
const receiptSchema = z.object({
  accepted: z.literal(true), channel: z.literal("whatsapp"), account: identity,
  recipient: identity, messageId: identity,
}).strict();
export type PrivateDeliveryReceipt = z.infer<typeof receiptSchema>;
export type LinkingConnectorHost = {
  /** Must resolve only this canonical sender, on this account, to a private target.
   * No current-group delivery helper, public fallback or automatic send retry.
   */
  sendPrivate: (delivery: PrivateLinkDelivery) => Promise<PrivateDeliveryReceipt>;
  sendPrompt?: (delivery: { channel: "whatsapp"; account: string; conversation: string; text: string; signal: AbortSignal; assertCurrent: () => void }) => Promise<{ accepted: true; messageId: string; conversation: string }>;
  fetch?: typeof globalThis.fetch;
};

function safeUrl(raw: string) {
  const url = new URL(raw);
  if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(
    url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  ))) throw new Error("Invalid connector URL");
  return url;
}

const failed = Object.freeze({ status: "failed" as const });
const linked: LinkOutcome = Object.freeze({ status: "linked" });
const sent: LinkOutcome = Object.freeze({ status: "private_link_sent" });
const deliverySchema = z.object({
  version: z.literal(1), channel: z.literal("whatsapp"), account: identity, recipient: identity,
  url: z.string().url(), expiresAt: z.string().datetime(),
}).strict();

async function loadSettings(config: LinkingConnectorConfig) {
  try {
    const settings = configSchema.parse(config);
    const endpoint = safeUrl(settings.endpoint);
    const origin = safeUrl(settings.publicLinkOrigin);
    if (endpoint.pathname !== "/api/mcp" || endpoint.search || origin.pathname !== "/" || origin.search) throw new Error();
    const key = await importPKCS8(settings.privateKeyPem, "EdDSA");
    return { settings, endpoint, origin, key };
  } catch {
    // No configuration values, key-parser diagnostics or validation inputs.
    throw new Error("Invalid linking connector configuration");
  }
}

/** Harness-neutral trusted connector core. Importable outside Next.js; no DB,
 * application settings or ambient credentials. Errors/results never carry raw
 * upstream output, private URLs, receipt IDs or account/actor identifiers.
 */
export async function createLinkingConnector(config: LinkingConnectorConfig, host: LinkingConnectorHost) {
  const { settings, endpoint, origin, key } = await loadSettings(config);
  // Capture host capabilities once; never share mutable per-session headers.
  const sendPrivate = host.sendPrivate.bind(host);
  const fetchRequest = host.fetch ?? globalThis.fetch;

  type MediaCall = { name: string; args: unknown; source?: Record<string, unknown> };
  async function invoke(invocation: TrustedLinkInvocation, code?: string, event?: z.infer<typeof eventSchema>, media?: MediaCall): Promise<LinkOutcome | MediaOutcome> {
    let client: Client | undefined;
    let active = true;
    try {
      const actor = Object.freeze(actorSchema.parse({
        channel: invocation.channel, account: invocation.account, sender: invocation.sender,
        kind: invocation.kind, conversation: invocation.conversation,
      }));
      const assertCurrent = invocation.assertCurrent;
      if (typeof assertCurrent !== "function") return failed;
      const signal = AbortSignal.any([AbortSignal.timeout(media ? 25_000 : 15_000), ...(invocation.signal ? [invocation.signal] : [])]);
      const guard = () => {
        if (!active) throw new Error("Closed connector invocation");
        signal.throwIfAborted(); assertCurrent();
      };
      guard();
      const proof = event ? Object.freeze(eventSchema.parse(event)) : undefined;
      if (code && (actor.kind !== "direct" || !proof || proof.eventTime > Date.now() + 5000 || proof.eventTime < Date.now() - 900_000)) return failed;
      const source = media?.source ?? (code ? { source: "message", intent: `link-confirm:${code}`, ...proof } : { source: "tool" });
      const transport = new StreamableHTTPClientTransport(endpoint, {
        fetch: async (input, init) => {
          guard();
          const request = new Request(input, init);
          if (request.url !== endpoint.href || request.method !== "POST") throw new Error("Unsupported connector request");
          const body = new Uint8Array(await request.arrayBuffer());
          if (body.byteLength > 65536) throw new Error("Unsupported connector request");
          guard();
          const now = Math.floor(Date.now() / 1000);
          const assertion = await new SignJWT({
            v: 1, iss: settings.issuer, aud: settings.audience, service: settings.service,
            ...actor, ...source, iat: now, exp: now + 60, jti: randomUUID(),
            method: "POST", target: endpoint.pathname + endpoint.search,
            bodyHash: createHash("sha256").update(body).digest("hex"),
          }).setProtectedHeader({ alg: "EdDSA", typ: "thinkarr-delegation+jwt", kid: settings.keyId }).sign(key);
          const headers = new Headers({
            Authorization: `Bearer ${settings.bearer}`, "Thinkarr-Delegation": assertion,
            "Content-Type": "application/json", Accept: "application/json, text/event-stream",
          });
          const version = request.headers.get("mcp-protocol-version");
          if (version) headers.set("mcp-protocol-version", version);
          guard();
          const response = await fetchRequest(endpoint.href, {
            method: "POST", body: Buffer.from(body), headers, redirect: "error", credentials: "omit", signal,
          });
          guard();
          if (response.redirected || (response.status >= 300 && response.status < 400)) throw new Error("Unsupported connector response");
          return response;
        },
      });
      client = new Client({ name: "thinkarr-linking-connector", version: "1" });
      await client.connect(transport);
      guard();
      const result = CallToolResultSchema.parse(await client.callTool({
        name: media?.name ?? (code ? "account_link_confirm" : "account_link_start"), arguments: media ? media.args as Record<string, unknown> : code ? { code } : {},
      }, undefined, { signal, timeout: media ? 20_000 : 10_000 }));
      guard();
      // Allow only the exact wire outcomes. Never forward arbitrary server text,
      // structuredContent, metadata, exceptions or delivery receipts to a model.
      if (result.isError || result.structuredContent !== undefined || result.content.length !== 1 || result.content[0].type !== "text") return failed;
      const value: unknown = JSON.parse(result.content[0].text);
      if (media) {
        if (media.name === "media_select" && !media.source && z.object({ status: z.literal("draft") }).strict().safeParse(value).success) {
          if (!host.sendPrompt || actor.kind !== "group") return failed;
          const meta = z.object({ "thinkarr/presentation": presentation }).strict().parse(result._meta)["thinkarr/presentation"];
          guard();
          const receipt = z.object({ accepted: z.literal(true), messageId: identity, conversation: identity }).strict().parse(await host.sendPrompt({
            channel: actor.channel, account: actor.account, conversation: actor.conversation, text: meta.text, signal, assertCurrent: guard,
          }));
          guard();
          if (receipt.conversation !== actor.conversation) return failed;
          const presented = await invoke({ ...invocation, signal, assertCurrent: guard }, undefined, undefined, {
            name: "media_select", args: { selectionId: meta.selectionId, promptMessageId: receipt.messageId },
            source: { source: "command", intent: `present:${meta.selectionId}` },
          });
          guard();
          return mediaOutcome.parse(presented);
        }
        if (result._meta !== undefined) return failed;
        const parsed = mediaOutcome.parse(value);
        if (parsed.status === "ok" && ((media.name === "media_search" && !("items" in parsed)) || (media.name === "media_details" && !("item" in parsed)) || !["media_search", "media_details"].includes(media.name))) return failed;
        return parsed;
      }
      if (z.object({ linked: z.literal(true) }).strict().safeParse(value).success) {
        return result._meta === undefined ? linked : failed;
      }
      if (code || !z.object({ linked: z.literal(false), privateDeliveryRequired: z.literal(true) }).strict().safeParse(value).success) return failed;
      const meta = z.object({ "thinkarr/private-delivery": deliverySchema }).strict().parse(result._meta);
      const delivery = meta["thinkarr/private-delivery"];
      const url = new URL(delivery.url);
      const expiresAt = Date.parse(delivery.expiresAt);
      if (delivery.channel !== actor.channel || delivery.account !== actor.account || delivery.recipient !== actor.sender
        || url.origin !== origin.origin || url.username || url.password || url.pathname !== "/mcp/connect" || url.search
        || !/^#token=[a-f0-9]{64}$/.test(url.hash) || expiresAt <= Date.now() || expiresAt > Date.now() + 300_000) return failed;
      guard();
      const receipt = receiptSchema.parse(await sendPrivate(Object.freeze({
        channel: delivery.channel, account: delivery.account, recipient: delivery.recipient,
        url: delivery.url, expiresAt: delivery.expiresAt, assertCurrent: guard, signal,
      })));
      guard();
      if (receipt.channel !== actor.channel || receipt.account !== actor.account || receipt.recipient !== actor.sender) return failed;
      return sent;
    } catch {
      return failed;
    } finally {
      active = false;
      await client?.close().catch(() => {});
    }
  }

  return Object.freeze({
    /** Expose only a zero-argument linking tool; capture invocation in a host factory. */
    startLink: (invocation: TrustedLinkInvocation) => invoke(invocation) as Promise<LinkOutcome>,
    async mediaTool(invocation: TrustedLinkInvocation, name: MediaTool, args: unknown): Promise<MediaOutcome> {
      const parsed = mediaToolArguments[name]?.safeParse(args);
      if (!parsed?.success) return failed;
      return mediaOutcome.parse(await invoke(invocation, undefined, undefined, { name, args: parsed.data }));
    },
    async confirmMediaMessage(invocation: TrustedLinkMessage & { replyTo?: string }, content: string): Promise<MediaOutcome | undefined> {
      const intent = confirmationIntent(content, invocation.replyTo);
      if (!intent) return;
      try {
        if (invocation.kind !== "group" || (invocation.replyTo !== undefined && !identity.safeParse(invocation.replyTo).success)) return failed;
        const proof = eventSchema.parse({ eventId: invocation.eventId, eventTime: invocation.eventTime });
        return mediaOutcome.parse(await invoke(invocation, undefined, undefined, { name: "media_confirm_request", args: {}, source: { ...intent, ...proof } }));
      } catch { return failed; }
    },
    /** Call only from an admitted inbound hook; unrelated content remains unclaimed. */
    async handlePrivateLinkMessage(invocation: TrustedLinkMessage, content: string): Promise<LinkOutcome | undefined> {
      if (typeof content !== "string" || content.length > 100) return undefined;
      const match = /^Link account ([a-f0-9]{64})$/.exec(content.trim());
      if (!match) return undefined;
      if (invocation.kind !== "direct") return failed;
      return invoke(invocation, match[1], { eventId: invocation.eventId, eventTime: invocation.eventTime }) as Promise<LinkOutcome>;
    },
  });
}
