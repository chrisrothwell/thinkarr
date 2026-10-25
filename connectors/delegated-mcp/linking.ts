import { createHash, randomUUID } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { confirmationIntent, mediaOutcome, mediaToolArguments, presentation, type MediaOutcome, type MediaTool } from "./media-contract.js";
import { ConnectorDiagnosticError, diagnosticErrorFields, safeDiagnosticSink, type DiagnosticSink } from "./diagnostics.js";
import { MCP_REQUEST_ID_HEADER, MCP_TIMING_DEBUG_HEADER, observeMcpResponse, parseMcpRequestId, readMcpServerDuration } from "./http-diagnostics.js";

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
// Three sequential signed MCP exchanges must fit before the tool result. Keep
// this bounded below the assertion lifetime, with fresh signatures per POST.
export const LINK_OPERATION_TIMEOUT_MS = 45_000;
export const LINK_VERIFICATION_TIMEOUT_MS = 55_000;
export const LINK_HOOK_TIMEOUT_MS = 60_000;
/** Host-owned, canonical provider identity, never model/tool arguments. */
export type TrustedLinkInvocation = z.infer<typeof actorSchema> & {
  assertCurrent: () => void;
  signal?: AbortSignal;
};
export type TrustedLinkMessage = TrustedLinkInvocation & z.infer<typeof eventSchema>;
export type LinkOutcome = Readonly<{ status: "linked" | "private_link_sent" | "private_delivery_unconfirmed" | "unavailable" | "unknown" | "failed" }>;
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
  diagnostics?: DiagnosticSink;
  debugTimings?: boolean;
};

function safeUrl(raw: string) {
  const url = new URL(raw);
  if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(
    url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  ))) throw new Error("Invalid connector URL");
  return url;
}

const failed = Object.freeze({ status: "failed" as const });
// Exact known Thinkarr errors only; never log arbitrary remote tool text.
const remoteReasons = new Map([
  ["Configure the public linking origin and WhatsApp bot number before linking", "remote_link_configuration_required"],
  ["Linking is not permitted for this integration", "remote_linking_not_permitted"],
  ["Link initiation requires trusted actor context", "remote_actor_context_rejected"],
  ["The existing binding needs administrator recovery", "remote_binding_recovery_required"],
  ["This link has expired or is no longer valid. Ask for a new private link.", "remote_link_expired"],
  ["Sign in with Plex before linking", "remote_plex_signin_required"],
  ["Private sender verification is required", "remote_sender_verification_required"],
  ["This verification belongs to another participant", "remote_participant_mismatch"],
  ["This channel identity is already bound to another account. Contact the administrator to recover it.", "remote_binding_conflict"],
  ["Link your Plex account in this conversation first", "remote_account_link_required"],
]);
function remoteToolReason(content: Array<{ type: string; text?: string }>) {
  if (content.length !== 1 || content[0].type !== "text" || !content[0].text || content[0].text.length > 1024) return "remote_tool_error";
  try {
    const value = JSON.parse(content[0].text);
    return typeof value?.error === "string" ? remoteReasons.get(value.error) ?? "remote_tool_error" : "remote_tool_error";
  } catch { return "remote_tool_error"; }
}
const linked: LinkOutcome = Object.freeze({ status: "linked" });
const sent: LinkOutcome = Object.freeze({ status: "private_link_sent" });
const deliverySchema = z.object({
  version: z.literal(1), channel: z.literal("whatsapp"), account: identity, recipient: identity,
  url: z.string().url(), expiresAt: z.string().datetime(),
}).strict();

async function loadSettings(config: LinkingConnectorConfig, log: DiagnosticSink) {
  let stage = "connector.config";
  try {
    log("debug", stage);
    const settings = configSchema.parse(config);
    stage = "connector.urls"; log("debug", stage);
    const endpoint = safeUrl(settings.endpoint);
    const origin = safeUrl(settings.publicLinkOrigin);
    if (endpoint.pathname !== "/api/mcp" || endpoint.search || origin.pathname !== "/" || origin.search) throw new Error();
    stage = "connector.signing_key"; log("debug", stage);
    const key = await importPKCS8(settings.privateKeyPem, "EdDSA");
    log("debug", "connector.ready");
    return { settings, endpoint, origin, key };
  } catch (error) {
    log("error", stage, diagnosticErrorFields(error));
    // No configuration values, key-parser diagnostics or validation inputs.
    throw new Error("Invalid linking connector configuration");
  }
}

/** Harness-neutral trusted connector core. Importable outside Next.js; no DB,
 * application settings or ambient credentials. Errors/results never carry raw
 * upstream output, private URLs, receipt IDs or account/actor identifiers.
 */
export async function createLinkingConnector(config: LinkingConnectorConfig, host: LinkingConnectorHost) {
  const log = safeDiagnosticSink(host.diagnostics);
  const { settings, endpoint, origin, key } = await loadSettings(config, log);
  // Capture host capabilities once; never share mutable per-session headers.
  const sendPrivate = host.sendPrivate.bind(host);
  const fetchRequest = host.fetch ?? globalThis.fetch;
  const debugTimings = host.debugTimings === true;

  type MediaCall = { name: string; args: unknown; source?: Record<string, unknown> };
  async function invoke(invocation: TrustedLinkInvocation, code?: string, event?: z.infer<typeof eventSchema>, media?: MediaCall): Promise<LinkOutcome | MediaOutcome> {
    let client: Client | undefined;
    let active = true;
    let toolCallStarted = false;
    let stage = "connector.actor";
    const step = (next: string) => { stage = next; log("debug", stage); };
    const reject = (reason: string) => { log("warn", stage, { reason, outcome: "failed" }); return failed; };
    try {
      step(stage);
      const actor = Object.freeze(actorSchema.parse({
        channel: invocation.channel, account: invocation.account, sender: invocation.sender,
        kind: invocation.kind, conversation: invocation.conversation,
      }));
      const assertCurrent = invocation.assertCurrent;
      if (typeof assertCurrent !== "function") return reject("invocation_guard_missing");
      const signal = AbortSignal.any([AbortSignal.timeout(media ? 25_000 : LINK_OPERATION_TIMEOUT_MS), ...(invocation.signal ? [invocation.signal] : [])]);
      const guard = () => {
        if (!active) throw new Error("Closed connector invocation");
        signal.throwIfAborted(); assertCurrent();
      };
      guard();
      const proof = event ? Object.freeze(eventSchema.parse(event)) : undefined;
      if (code && (actor.kind !== "direct" || !proof || proof.eventTime > Date.now() + 5000 || proof.eventTime < Date.now() - 900_000)) return reject("verification_context_invalid");
      const source = media?.source ?? (code ? { source: "message", intent: `link-confirm:${code}`, ...proof } : { source: "tool" });
      const transport = new StreamableHTTPClientTransport(endpoint, {
        fetch: async (input, init) => {
          let requestStage = "mcp.http.prepare";
          const requestId = randomUUID();
          let fetchStarted: number | undefined;
          let protocolPhase: "initialize" | "initialized" | "tool_call" | "other" = "other";
          try {
            log("debug", requestStage, { requestId });
            guard();
            const request = new Request(input, init);
            const requestSignal = AbortSignal.any([signal, request.signal]);
            requestSignal.throwIfAborted();
            if (request.url !== endpoint.href) throw new ConnectorDiagnosticError("connector_request_target_invalid");
            // The SDK probes optional standalone SSE after initialized. This
            // connector is POST-only: reject locally without auth or network I/O.
            if (request.method === "GET") { log("debug", "mcp.sse_unsupported", { requestId }); return new Response(null, { status: 405 }); }
            if (request.method !== "POST") throw new ConnectorDiagnosticError("connector_request_target_invalid");
            const body = new Uint8Array(await request.arrayBuffer());
            if (body.byteLength > 65536) throw new ConnectorDiagnosticError("connector_request_too_large");
            const method = JSON.parse(new TextDecoder().decode(body)).method;
            protocolPhase = method === "initialize" ? "initialize" : method === "notifications/initialized" ? "initialized" : method === "tools/call" ? "tool_call" : "other";
            guard();
            const now = Math.floor(Date.now() / 1000);
            requestStage = "mcp.http.sign"; log("debug", requestStage, { requestId, protocolPhase });
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
            headers.set(MCP_REQUEST_ID_HEADER, requestId);
            if (debugTimings) headers.set(MCP_TIMING_DEBUG_HEADER, "1");
            const version = request.headers.get("mcp-protocol-version");
            if (version) headers.set("mcp-protocol-version", version);
            guard();
            requestSignal.throwIfAborted();
            requestStage = "mcp.http.fetch"; log("debug", requestStage, { requestId, protocolPhase });
            fetchStarted = performance.now();
            const response = await fetchRequest(endpoint.href, {
              method: "POST", body: Buffer.from(body), headers, redirect: "error", credentials: "omit", signal: requestSignal,
            });
            const httpDurationMs = Math.max(0, performance.now() - fetchStarted);
            guard();
            const serverDurationMs = readMcpServerDuration(response.headers.get("Server-Timing"));
            const responseRequestId = parseMcpRequestId(response.headers.get(MCP_REQUEST_ID_HEADER));
            const fields = { requestId, responseRequestId, protocolPhase, httpDurationMs, serverDurationMs,
              serverTimingAvailable: serverDurationMs !== undefined,
              ...(serverDurationMs !== undefined ? { outsideHandlerMs: Math.max(0, httpDurationMs - serverDurationMs) } : {}),
            };
            log(response.ok ? "debug" : "error", "mcp.http.response", { ...fields, httpStatus: response.status, ...(!response.ok ? { reason: "http_request_rejected" } : {}) });
            if (response.redirected || (response.status >= 300 && response.status < 400)) throw new ConnectorDiagnosticError("connector_redirect_refused");
            return observeMcpResponse(response, log, fields);
          } catch (error) {
            log("error", requestStage, { ...diagnosticErrorFields(error), requestId, protocolPhase,
              ...(fetchStarted !== undefined ? { httpDurationMs: Math.max(0, performance.now() - fetchStarted) } : {}),
            });
            throw error;
          }
        },
      });
      client = new Client({ name: "thinkarr-linking-connector", version: "1" });
      step("mcp.connect");
      await client.connect(transport);
      guard();
      step("mcp.tool_call");
      toolCallStarted = true;
      const result = CallToolResultSchema.parse(await client.callTool({
        name: media?.name ?? (code ? "account_link_confirm" : "account_link_start"), arguments: media ? media.args as Record<string, unknown> : code ? { code } : {},
      }, undefined, { signal, timeout: 20_000 }));
      guard();
      step("mcp.tool_result");
      // Allow only the exact wire outcomes. Never forward arbitrary server text,
      // structuredContent, metadata, exceptions or delivery receipts to a model.
      if (result.isError) return reject(remoteToolReason(result.content));
      if (result.structuredContent !== undefined || result.content.length !== 1 || result.content[0].type !== "text") return reject("tool_result_shape_invalid");
      const value: unknown = JSON.parse(result.content[0].text);
      if (media) {
        if (media.name === "media_select" && !media.source && z.object({ status: z.literal("draft") }).strict().safeParse(value).success) {
          if (!host.sendPrompt || actor.kind !== "group") return reject("prompt_delivery_unavailable");
          step("media.presentation_validate");
          const meta = z.object({ "thinkarr/presentation": presentation }).strict().parse(result._meta)["thinkarr/presentation"];
          guard();
          step("media.prompt_send");
          const receipt = z.object({ accepted: z.literal(true), messageId: identity, conversation: identity }).strict().parse(await host.sendPrompt({
            channel: actor.channel, account: actor.account, conversation: actor.conversation, text: meta.text, signal, assertCurrent: guard,
          }));
          guard();
          if (receipt.conversation !== actor.conversation) return reject("prompt_receipt_mismatch");
          step("media.presentation_acknowledge");
          const presented = await invoke({ ...invocation, signal, assertCurrent: guard }, undefined, undefined, {
            name: "media_select", args: { selectionId: meta.selectionId, promptMessageId: receipt.messageId },
            source: { source: "command", intent: `present:${meta.selectionId}` },
          });
          guard();
          return mediaOutcome.parse(presented);
        }
        if (result._meta !== undefined) return reject("unexpected_result_metadata");
        step("media.outcome_validate");
        const parsed = mediaOutcome.parse(value);
        if (parsed.status === "ok" && ((media.name === "media_search" && !("items" in parsed)) || (media.name === "media_details" && !("item" in parsed)) || !["media_search", "media_details"].includes(media.name))) return reject("media_outcome_invalid");
        return parsed;
      }
      if (z.object({ linked: z.literal(true) }).strict().safeParse(value).success) {
        return result._meta === undefined ? linked : reject("unexpected_result_metadata");
      }
      if (code || !z.object({ linked: z.literal(false), privateDeliveryRequired: z.literal(true) }).strict().safeParse(value).success) return reject("link_outcome_invalid");
      step("link.delivery_validate");
      const meta = z.object({ "thinkarr/private-delivery": deliverySchema }).strict().parse(result._meta);
      const delivery = meta["thinkarr/private-delivery"];
      const url = new URL(delivery.url);
      const expiresAt = Date.parse(delivery.expiresAt);
      if (delivery.channel !== actor.channel || delivery.account !== actor.account || delivery.recipient !== actor.sender
        || url.origin !== origin.origin || url.username || url.password || url.pathname !== "/mcp/connect" || url.search
        || !/^#token=[a-f0-9]{64}$/.test(url.hash) || expiresAt <= Date.now() || expiresAt > Date.now() + 300_000) return reject("private_delivery_invalid");
      guard();
      step("link.private_send");
      const receipt = receiptSchema.parse(await sendPrivate(Object.freeze({
        channel: delivery.channel, account: delivery.account, recipient: delivery.recipient,
        url: delivery.url, expiresAt: delivery.expiresAt, assertCurrent: guard, signal,
      })));
      guard();
      step("link.receipt_validate");
      if (receipt.channel !== actor.channel || receipt.account !== actor.account || receipt.recipient !== actor.sender) return reject("private_receipt_mismatch");
      log("debug", "link.private_sent");
      return sent;
    } catch (error) {
      const details = diagnosticErrorFields(error);
      log("error", stage, details);
      if (!media && error instanceof ConnectorDiagnosticError && error.reason === "private_delivery_unconfirmed") return { status: "private_delivery_unconfirmed" };
      let code: unknown;
      try { code = error && typeof error === "object" ? Reflect.get(error, "code") : undefined; } catch { /* retain a safe failed outcome */ }
      const connectivityFailure = details.errorType === "TimeoutError" || code === -32001
        || (details.errorCode !== undefined && ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"].includes(details.errorCode))
        || (typeof code === "number" && code >= 500 && code <= 599);
      if (!media && connectivityFailure) {
        const status = toolCallStarted ? "unknown" : "unavailable";
        log("warn", "link.transport_outcome", { reason: toolCallStarted ? "tool_outcome_unconfirmed" : "handshake_unavailable", outcome: status });
        return { status };
      }
      return failed;
    } finally {
      active = false;
      log("debug", "mcp.close");
      await client?.close().catch((error) => { log("warn", "mcp.close", diagnosticErrorFields(error)); });
    }
  }

  return Object.freeze({
    /** Expose only a zero-argument linking tool; capture invocation in a host factory. */
    startLink: (invocation: TrustedLinkInvocation) => invoke(invocation) as Promise<LinkOutcome>,
    async mediaTool(invocation: TrustedLinkInvocation, name: MediaTool, args: unknown): Promise<MediaOutcome> {
      const parsed = mediaToolArguments[name]?.safeParse(args);
      if (!parsed?.success) { log("warn", "media.arguments", { reason: "tool_arguments_invalid" }); return failed; }
      return mediaOutcome.parse(await invoke(invocation, undefined, undefined, { name, args: parsed.data }));
    },
    async confirmMediaMessage(invocation: TrustedLinkMessage & { replyTo?: string }, content: string): Promise<MediaOutcome | undefined> {
      const intent = confirmationIntent(content, invocation.replyTo);
      if (!intent) return;
      try {
        if (invocation.kind !== "group" || (invocation.replyTo !== undefined && !identity.safeParse(invocation.replyTo).success)) throw new ConnectorDiagnosticError("confirmation_context_invalid");
        const proof = eventSchema.parse({ eventId: invocation.eventId, eventTime: invocation.eventTime });
        return mediaOutcome.parse(await invoke(invocation, undefined, undefined, { name: "media_confirm_request", args: {}, source: { ...intent, ...proof } }));
      } catch (error) { log("error", "media.confirmation", diagnosticErrorFields(error)); return failed; }
    },
    /** Call only from an admitted inbound hook; unrelated content remains unclaimed. */
    async handlePrivateLinkMessage(invocation: TrustedLinkMessage, content: string): Promise<LinkOutcome | undefined> {
      if (typeof content !== "string" || content.length > 100) return undefined;
      const match = /^Link account ([a-f0-9]{64})$/.exec(content.trim());
      if (!match) return undefined;
      if (invocation.kind !== "direct") { log("warn", "link.verification", { reason: "verification_not_private" }); return failed; }
      return invoke(invocation, match[1], { eventId: invocation.eventId, eventTime: invocation.eventTime }) as Promise<LinkOutcome>;
    },
  });
}
