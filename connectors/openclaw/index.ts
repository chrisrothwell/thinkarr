import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { createLinkingConnector, linkingConnectorConfigSchema, LINK_OPERATION_TIMEOUT_MS, LINK_VERIFICATION_TIMEOUT_MS, LINK_HOOK_TIMEOUT_MS, type LinkOutcome, type LinkingConnectorConfig, type PrivateLinkDelivery, type TrustedLinkInvocation } from "../delegated-mcp/linking.js";
import type { OpenClawHost, ToolContext } from "./host.js";
import { loadPreparedSecretReader } from "./secrets.js";
import { confirmationIntent, mediaTools, mediaInputSchema, type MediaOutcome } from "../delegated-mcp/media-contract.js";
import { ConnectorDiagnosticError, createDiagnosticTrace, diagnosticErrorFields, type DiagnosticSink } from "../delegated-mcp/diagnostics.js";

const routingOptions = {
  debug: z.boolean().default(false),
  // Receiving bot accounts/self identities, not a participant allowlist.
  accounts: z.record(z.string().min(1).max(512), z.string().regex(/^\+[1-9][0-9]{6,14}$/)),
  pilotGroup: z.string().max(512).regex(/^[0-9]+(?:-[0-9]+)?@g\.us$/).optional(),
};
const secretRefSchema = z.object({
  source: z.enum(["store", "env", "file", "exec"]), provider: z.string().min(1), id: z.string().min(1),
}).strict();
const nativeConnectionSchema = linkingConnectorConfigSchema.extend({
  bearer: z.union([linkingConnectorConfigSchema.shape.bearer, secretRefSchema]),
  privateKeyPem: z.union([linkingConnectorConfigSchema.shape.privateKeyPem, secretRefSchema]),
});
const nativeOptionsSchema = z.object({ ...routingOptions, connection: nativeConnectionSchema }).strict();
const legacyOptionsSchema = z.object({ ...routingOptions, credentialsFile: z.string().refine(isAbsolute) }).strict();
const optionsSchema = z.union([
  nativeOptionsSchema,
  // Compatibility for existing 0.2 installations; new setup uses native secrets.
  legacyOptionsSchema,
]);

/** Diagnostics contain only schema-owned paths, codes and primitive types.
 * Never stringify Zod errors: messages/keys/inputs can contain credential data.
 */
function configurationError(input: unknown): Error {
  const record = input && typeof input === "object" ? input : undefined;
  const native = !!record && Object.hasOwn(record, "connection");
  const result = (native ? nativeOptionsSchema : legacyOptionsSchema).safeParse(input);
  const fields = new Set(["endpoint", "publicLinkOrigin", "service", "issuer", "audience", "keyId", "bearer", "privateKeyPem"]);
  const issues = result.success ? [] : result.error.issues.flatMap((issue) => {
    if (issue.code !== "invalid_union" || issue.path[0] !== "connection") return [issue];
    const connection = record && Reflect.get(record, "connection");
    const value = connection && typeof connection === "object" ? Reflect.get(connection, issue.path[1]!) : undefined;
    const branch = issue.errors[typeof value === "string" ? 0 : 1];
    return branch ? branch.map((child) => ({ ...child, path: [...issue.path, ...child.path] })) : [issue];
  });
  const details = issues.map((issue) => {
    const [root, field] = issue.path;
    const path = root === "connection" ? (typeof field === "string" && fields.has(field) ? `connection.${field}` : "connection")
      : root === "accounts" ? "accounts.*" : root === "pilotGroup" || root === "credentialsFile" || root === "debug" ? root : "config";
    // Use actual types only for fixed connection fields, never dynamic map keys.
    const connection = record && Reflect.get(record, "connection");
    const value = path.startsWith("connection.") && connection && typeof connection === "object"
      ? Reflect.get(connection, field!) : undefined;
    const received = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    return `${path}: ${issue.code}${path.startsWith("connection.") ? ` (received ${received})` : ""}`;
  });
  return new Error(`Invalid Thinkarr plugin configuration [${native ? "native" : "legacy"}]: ${[...new Set(details)].slice(0, 12).join("; ")}`);
}

/** Provider-address classification, not session-key parsing or alias guessing.
 * LID/hosted/device/unknown identities need verified provider mapping and are
 * deliberately unsupported by this first adapter.
 */
export function canonicalPhone(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const raw = value.startsWith("whatsapp:") ? value.slice(9) : value;
  const phone = /^\+([1-9][0-9]{6,14})$/.exec(raw)?.[1]
    ?? /^([1-9][0-9]{6,14})@s\.whatsapp\.net$/.exec(raw)?.[1];
  return phone ? `${phone}@s.whatsapp.net` : undefined;
}

function conversation(value: unknown) {
  const phone = canonicalPhone(value);
  if (phone) return { kind: "direct" as const, id: phone };
  if (typeof value === "string" && /^[0-9]+(?:-[0-9]+)?@g\.us$/.test(value) && value.length <= 512) return { kind: "group" as const, id: value };
}

async function readCredentials(path: string): Promise<LinkingConnectorConfig> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 16_384 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new ConnectorDiagnosticError("legacy_credentials_file_unsafe");
    // Bound the actual read too if the file changes after fstat.
    const buffer = Buffer.alloc(16_385);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 16_384) throw new ConnectorDiagnosticError("legacy_credentials_file_too_large");
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally { await file.close(); }
}

const failure: LinkOutcome = Object.freeze({ status: "failed" });
const messages = {
  linked: "Your Plex account is linked.",
  private_link_sent: "I sent your private Plex sign-in link. Open it, then finish verification in WhatsApp.",
  private_delivery_unconfirmed: "A private Plex sign-in message may have been sent. Please check your private WhatsApp chat and follow the instructions there. If it arrived, use that link rather than requesting another one.",
  unavailable: "Thinkarr did not respond in time. Please try this step again while your current private link is valid; keep the link if you already received one.",
  unknown: "I could not confirm the result from Thinkarr. Please check your account-link status before trying again.",
  failed: "Account linking could not be completed. Please ask for a new private link.",
};

/** Synchronous registration accepts source refs or host-materialized strings.
 * Prepared native secrets and legacy files are read only during an admitted
 * invocation, never during registration or tool discovery.
 */
export function register<C extends object>(api: OpenClawHost<C>) {
  const registration = createDiagnosticTrace(api.logger, api.pluginConfig?.debug === true, "registration");
  if (!["full", "tool-discovery"].includes(api.registrationMode)) return;
  if (api.runtime.version !== "2026.10.4") { registration.error("registration.version", new ConnectorDiagnosticError("host_version_unsupported")); throw new Error("Thinkarr requires OpenClaw 2026.10.4"); }
  const parsed = optionsSchema.safeParse(api.pluginConfig);
  if (!parsed.success) { registration.log("error", "registration.config", { ...diagnosticErrorFields(parsed.error), reason: "configuration_invalid" }); throw configurationError(api.pluginConfig); }
  const options = parsed.data;
  const lifecycle = api.lifecycle.signal;
  if (!lifecycle) { registration.error("registration.lifecycle", new ConnectorDiagnosticError("plugin_lifetime_missing")); throw new Error("Thinkarr requires plugin lifecycle admission"); }
  const assertLive = () => { if (lifecycle.aborted) throw new ConnectorDiagnosticError("plugin_lifetime_closed"); };
  registration.log("info", "registration.ready", { debugEnabled: options.debug, mediaEnabled: !!options.pilotGroup });
  lifecycle.addEventListener("abort", () => registration.log("info", "registration.disposed"), { once: true });

  async function credentialsForInvocation(assertCurrent: () => void, log: DiagnosticSink) {
    assertCurrent(); assertLive();
    if (!("connection" in options)) { log("debug", "credentials.legacy_file"); return { credentials: await readCredentials(options.credentialsFile), assertSecretsCurrent: assertLive }; }
    const connection = options.connection;
    if (typeof connection.bearer === "string" && typeof connection.privateKeyPem === "string") {
      log("debug", "credentials.materialized");
      return { credentials: linkingConnectorConfigSchema.parse(connection), assertSecretsCurrent: assertLive };
    }
    log("debug", "secrets.sdk_load");
    const read = await loadPreparedSecretReader();
    assertCurrent(); assertLive();
    // Fixed manifest-owned paths, never a caller-supplied ref/provider/secret ID.
    log("debug", "secrets.prepared_read");
    const bearer = read("thinkarr", "connection.bearer");
    const key = read("thinkarr", "connection.privateKeyPem");
    const available = { bearerAvailable: !!bearer.value, keyAvailable: !!key.value, revisionMatches: Number.isSafeInteger(bearer.revision) && bearer.revision === key.revision };
    log(available.bearerAvailable && available.keyAvailable && available.revisionMatches ? "debug" : "error", "secrets.prepared_status", available);
    if (!bearer.value) throw new ConnectorDiagnosticError("prepared_bearer_unavailable");
    if (!key.value) throw new ConnectorDiagnosticError("prepared_signing_key_unavailable");
    if (!available.revisionMatches) throw new ConnectorDiagnosticError("prepared_secret_revision_mismatch");
    const assertSecretsCurrent = () => {
      assertLive();
      const currentBearer = read("thinkarr", "connection.bearer");
      const currentKey = read("thinkarr", "connection.privateKeyPem");
      if (currentBearer.revision !== bearer.revision || currentKey.revision !== bearer.revision) throw new ConnectorDiagnosticError("prepared_secret_revision_changed");
      if (!currentBearer.value || !currentKey.value) throw new ConnectorDiagnosticError("prepared_secret_access_revoked");
    };
    assertSecretsCurrent();
    return { credentials: linkingConnectorConfigSchema.parse({ ...connection, bearer: bearer.value, privateKeyPem: key.value }), assertSecretsCurrent };
  }

  function actor(channel: unknown, account: unknown, sender: unknown, nativeConversation: unknown, verifiedPrivateReply = false) {
    const reject = (reason: string) => { registration.log(verifiedPrivateReply ? "warn" : "debug", verifiedPrivateReply ? "inbound.actor_rejected" : "factory.actor_rejected", { reason }); return undefined; };
    if (channel !== "whatsapp") return reject("actor_channel_invalid");
    if (typeof account !== "string" || !Object.hasOwn(options.accounts, account)) return reject("actor_account_unconfigured");
    const canonical = canonicalPhone(sender);
    const self = canonicalPhone(options.accounts[account]);
    let origin = conversation(nativeConversation);
    if (!canonical) return reject("actor_sender_unsupported");
    if (canonical === self) return reject("actor_self_sender");
    if (!origin) return reject("actor_conversation_unsupported");
    if (verifiedPrivateReply) {
      if (origin.kind !== "direct") return reject("verification_conversation_not_private");
      // The pinned hook mapper can expose the receiving bot (To) rather than
      // the peer (OriginatingTo). This allowance is ONLY for a fresh, matching
      // private event already checked by the hook, never model tool metadata.
      if (origin.id === self) {
        registration.log("debug", "inbound.private_context", { reason: "receiving_bot_context_normalized" });
        origin = { kind: "direct", id: canonical };
      } else if (origin.id === canonical) {
        registration.log("debug", "inbound.private_context", { reason: "sender_context_verified" });
      }
    }
    if (origin.kind === "direct" && origin.id !== canonical) return reject("actor_conversation_sender_mismatch");
    return { channel: "whatsapp" as const, account, sender: canonical, kind: origin.kind, conversation: origin.id };
  }

  async function sendPrivateText(cfg: C, delivery: Pick<PrivateLinkDelivery, "account" | "recipient" | "assertCurrent" | "signal">, text: string, log: DiagnosticSink, kind: "private" | "ack" = "private") {
    let stage = `outbound.${kind}_validate`;
    let dispatches = 0;
    const step = (next: string) => { stage = next; log("debug", stage); };
    try {
      step(stage);
      delivery.assertCurrent(); assertLive();
      const recipient = canonicalPhone(delivery.recipient);
      if (!recipient || !Object.hasOwn(options.accounts, delivery.account)) throw new ConnectorDiagnosticError("private_target_invalid");
      step(`outbound.${kind}_adapter`);
      const outbound = await api.runtime.channel.outbound.loadAdapter("whatsapp");
      delivery.assertCurrent(); assertLive();
      if (!outbound?.resolveTarget || !outbound.sendText) throw new ConnectorDiagnosticError("whatsapp_outbound_unavailable");
      step(`outbound.${kind}_resolve`);
      const resolved = outbound.resolveTarget({ cfg, to: recipient, accountId: delivery.account, mode: "explicit", allowFrom: [recipient] });
      if (!resolved.ok || canonicalPhone(resolved.to) !== recipient) throw new ConnectorDiagnosticError("private_target_mismatch");
      const guard = () => { delivery.assertCurrent(); assertLive(); };
      guard();
      step(`outbound.${kind}_send`);
      const result = await outbound.sendText({
        cfg, to: resolved.to, accountId: delivery.account,
        text,
        signal: delivery.signal, assertDirectAdapterHandoff: guard,
        // The pinned WhatsApp implementation awaits this before each physical
        // send (including chunks); it does not forward assertDirectAdapterHandoff.
        onPlatformSendDispatch: async () => { guard(); log("debug", `outbound.${kind}_dispatch`); dispatches++; },
      });
      guard();
      step(`outbound.${kind}_receipt`);
      if (dispatches === 0) throw new ConnectorDiagnosticError("private_dispatch_fence_missing");
      const receiptChecks = {
        receiptChannelMatches: result.channel === "whatsapp", receiptMessageIdPresent: !!result.messageId?.trim(),
        receiptDestinationSupported: !!canonicalPhone(result.toJid), receiptDestinationMatches: canonicalPhone(result.toJid) === recipient,
      };
      const destination = result.toJid?.replace(/^whatsapp:/, "");
      const receiptDestinationKind = destination === undefined || destination === "" ? "missing"
        : destination.endsWith("@g.us") ? "group" : /^[0-9]+@lid$/.test(destination) ? "lid" : /^[0-9]+@s\.whatsapp\.net$/.test(destination) ? "pn_jid"
          : /^\+[1-9][0-9]{6,14}$/.test(destination) ? "e164" : "other";
      log(Object.values(receiptChecks).every(Boolean) ? "debug" : "warn", `outbound.${kind}_receipt_checks`, { ...receiptChecks, receiptDestinationKind });
      if (result.channel !== "whatsapp" || receiptDestinationKind === "group") throw new ConnectorDiagnosticError("private_receipt_invalid");
      if (!result.messageId?.trim() || !canonicalPhone(result.toJid)) throw new ConnectorDiagnosticError("private_delivery_unconfirmed");
      if (canonicalPhone(result.toJid) !== recipient) throw new ConnectorDiagnosticError("private_receipt_invalid");
      return { accepted: true as const, channel: "whatsapp" as const, account: delivery.account, recipient, messageId: result.messageId };
    } catch (error) {
      log("error", stage, diagnosticErrorFields(error));
      if (dispatches > 0 && !(error instanceof ConnectorDiagnosticError)) throw new ConnectorDiagnosticError("private_delivery_unconfirmed");
      throw error;
    }
  }

  const sendPrivate = (cfg: C, delivery: PrivateLinkDelivery, log: DiagnosticSink) =>
    sendPrivateText(cfg, delivery, `Link your Plex account privately: ${delivery.url}`, log);

  async function run(invocation: TrustedLinkInvocation, cfg: C, completion?: { content: string; eventId: string; eventTime: number }, trace = createDiagnosticTrace(api.logger, options.debug, completion ? "link_complete" : "link_start")): Promise<LinkOutcome> {
    let stage = "invocation.admission";
    const step = (next: string) => { stage = next; trace.log("debug", stage); };
    trace.log("info", "operation.started");
    try {
      const signal = AbortSignal.any([AbortSignal.timeout(LINK_OPERATION_TIMEOUT_MS), ...(invocation.signal ? [invocation.signal] : [])]);
      let assertSecretsCurrent = assertLive;
      const assertCurrent = () => { signal.throwIfAborted(); try { invocation.assertCurrent(); } catch { throw new ConnectorDiagnosticError("invocation_not_current"); } assertSecretsCurrent(); };
      assertCurrent();
      step("credentials.load");
      const prepared = await credentialsForInvocation(assertCurrent, trace.log);
      assertSecretsCurrent = prepared.assertSecretsCurrent;
      assertCurrent();
      step("connector.create");
      const connector = await createLinkingConnector(prepared.credentials, { sendPrivate: (d) => sendPrivate(cfg, d, trace.log), diagnostics: trace.log, debugTimings: options.debug });
      assertCurrent();
      const current = { ...invocation, signal, assertCurrent };
      step("connector.invoke");
      const result = completion
        ? (await connector.handlePrivateLinkMessage({ ...current, eventId: completion.eventId, eventTime: completion.eventTime }, completion.content)) ?? failure
        : await connector.startLink(current);
      trace.log(["linked", "private_link_sent"].includes(result.status) ? "info" : "warn", completion ? "verification.result" : "operation.completed", { outcome: result.status });
      return result;
    } catch (error) { trace.error(stage, error); trace.log("warn", completion ? "verification.result" : "operation.completed", { outcome: "failed" }); return failure; }
  }

  async function runMedia(invocation: TrustedLinkInvocation, cfg: C, action: (connector: Awaited<ReturnType<typeof createLinkingConnector>>, current: TrustedLinkInvocation) => Promise<MediaOutcome | undefined>, operation = "media_operation"): Promise<MediaOutcome | undefined> {
    const trace = createDiagnosticTrace(api.logger, options.debug, operation);
    let stage = "invocation.admission";
    const step = (next: string) => { stage = next; trace.log("debug", stage); };
    trace.log("info", "operation.started");
    try {
      if (invocation.kind !== "group" || invocation.conversation !== options.pilotGroup) throw new ConnectorDiagnosticError("media_group_mismatch");
      const signal = AbortSignal.any([AbortSignal.timeout(25_000), ...(invocation.signal ? [invocation.signal] : [])]);
      let assertSecretsCurrent = assertLive;
      const assertCurrent = () => { signal.throwIfAborted(); try { invocation.assertCurrent(); } catch { throw new ConnectorDiagnosticError("invocation_not_current"); } assertSecretsCurrent(); };
      assertCurrent();
      step("credentials.load");
      const prepared = await credentialsForInvocation(assertCurrent, trace.log);
      assertSecretsCurrent = prepared.assertSecretsCurrent;
      assertCurrent();
      step("connector.create");
      const connector = await createLinkingConnector(prepared.credentials, {
        diagnostics: trace.log,
        debugTimings: options.debug,
        sendPrivate: (d) => sendPrivate(cfg, d, trace.log),
        async sendPrompt(delivery) {
          const guard = () => { delivery.assertCurrent(); assertCurrent(); };
          guard();
          trace.log("debug", "outbound.prompt_validate");
          if (delivery.conversation !== options.pilotGroup || delivery.account !== invocation.account) throw new ConnectorDiagnosticError("prompt_target_invalid");
          trace.log("debug", "outbound.prompt_adapter");
          const outbound = await api.runtime.channel.outbound.loadAdapter("whatsapp");
          guard();
          if (!outbound?.resolveTarget || !outbound.sendText) throw new ConnectorDiagnosticError("whatsapp_outbound_unavailable");
          trace.log("debug", "outbound.prompt_resolve");
          const resolved = outbound.resolveTarget({ cfg, to: delivery.conversation, accountId: delivery.account, mode: "explicit", allowFrom: [delivery.conversation] });
          if (!resolved.ok || conversation(resolved.to)?.id !== delivery.conversation) throw new ConnectorDiagnosticError("prompt_target_mismatch");
          let dispatches = 0;
          trace.log("debug", "outbound.prompt_send");
          const receipt = await outbound.sendText({ cfg, to: resolved.to, accountId: delivery.account, text: delivery.text,
            signal: delivery.signal, assertDirectAdapterHandoff: guard, onPlatformSendDispatch: async () => { guard(); trace.log("debug", "outbound.prompt_dispatch"); dispatches++; } });
          guard();
          trace.log("debug", "outbound.prompt_receipt");
          if (!dispatches) throw new ConnectorDiagnosticError("prompt_dispatch_fence_missing");
          if (receipt.channel !== "whatsapp" || !receipt.messageId?.trim() || conversation(receipt.toJid)?.id !== delivery.conversation) throw new ConnectorDiagnosticError("prompt_receipt_invalid");
          return { accepted: true, conversation: delivery.conversation, messageId: receipt.messageId };
        },
      });
      assertCurrent();
      step("connector.invoke");
      const result = await action(connector, { ...invocation, signal, assertCurrent });
      trace.log(result && ["failed", "blocked", "unknown"].includes(result.status) ? "warn" : "info", "operation.completed", { outcome: result?.status ?? "unclaimed" });
      return result;
    } catch (error) { trace.error(stage, error); trace.log("warn", "operation.completed", { outcome: "failed" }); return { status: "failed" }; }
  }
  const mediaMessages = {
    prompt_sent: "The request confirmation was sent. Reply to that message with “request it” to submit.",
    submitted: "Your request was submitted to Seerr.", pending_approval: "Your request was submitted and is awaiting approval in Seerr.",
    expired: "That choice expired. Ask me to find it again.", reply_to_prompt: "Please reply directly to the current title confirmation with “request it”.",
    blocked: "That request could not be submitted. Please check your Seerr account privately.",
    unknown: "I could not verify the request outcome. Please check Seerr before trying again.",
    failed: "The media operation could not be completed. Check that your Plex account is linked, then try again.",
    unclaimed: "No active request confirmation.",
  };

  api.registerTool({
    contextVersion: 2,
    create(ctx: ToolContext<C>) {
      const identity = actor(ctx.messageChannel, ctx.agentAccountId, ctx.requesterSenderId, ctx.nativeChannelId);
      if (!identity || typeof ctx.assertInvocationCurrent !== "function") { registration.log("debug", "factory.link_denied", { reason: "host_identity_or_guard_missing" }); return null; }
      const route = ctx.deliveryContext;
      if (route && ((route.channel !== undefined && route.channel !== identity.channel)
        || (route.accountId !== undefined && route.accountId !== identity.account)
        || (route.to !== undefined && conversation(route.to)?.id !== identity.conversation))) { registration.log("debug", "factory.link_denied", { reason: "delivery_context_mismatch" }); return null; }
      registration.log("debug", "factory.link_admitted");
      const assertCurrent = ctx.assertInvocationCurrent;
      const cfg = ctx.runtimeConfig ?? ctx.config ?? api.config;
      return {
        name: "thinkarr_account_link", label: "Link Plex account",
        description: "Privately link the current WhatsApp participant to Plex. Takes no identity or delivery arguments. If private delivery is unconfirmed, direct the user to check their private chat and do not automatically request another link. An unknown outcome requires checking account-link status first.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async execute(_id, args, signal) {
          let outcome = failure;
          if (z.object({}).strict().safeParse(args).success) {
            outcome = await run({ ...identity, signal: signal ? AbortSignal.any([signal, lifecycle]) : lifecycle,
              assertCurrent: () => { assertLive(); assertCurrent(); } }, cfg);
          } else registration.log("warn", "tool.link_arguments", { reason: "tool_arguments_invalid" });
          return { content: [{ type: "text" as const, text: messages[outcome.status] }], details: outcome };
        },
      };
    },
  }, { names: ["thinkarr_account_link"], optional: true });

  if (options.pilotGroup) for (const name of mediaTools) api.registerTool({
    contextVersion: 2,
    create(ctx) {
      const identity = actor(ctx.messageChannel, ctx.agentAccountId, ctx.requesterSenderId, ctx.nativeChannelId);
      const route = ctx.deliveryContext;
      if (!identity || identity.kind !== "group" || identity.conversation !== options.pilotGroup || typeof ctx.assertInvocationCurrent !== "function"
        || (route && ((route.channel !== undefined && route.channel !== identity.channel) || (route.accountId !== undefined && route.accountId !== identity.account)
           || (route.to !== undefined && conversation(route.to)?.id !== identity.conversation)))) { registration.log("debug", "factory.media_denied", { reason: "host_identity_group_or_route_invalid" }); return null; }
      registration.log("debug", "factory.media_admitted");
      const assertCurrent = ctx.assertInvocationCurrent;
      return {
        name: `thinkarr_${name}`, label: "Thinkarr media pilot",
        description: name === "media_select" ? "Present the exact title and explicit TV seasons for human confirmation. Does not submit. Use after search/details."
          : "Find title facts using the existing Seerr catalog. No library availability or personal activity is returned; do not infer availability. Link Plex with thinkarr_account_link first.",
        parameters: mediaInputSchema(name),
        async execute(_id, args, signal) {
          const result = await runMedia({ ...identity, signal: signal ? AbortSignal.any([signal, lifecycle]) : lifecycle,
            assertCurrent: () => { assertLive(); assertCurrent(); } }, ctx.runtimeConfig ?? ctx.config ?? api.config, (connector, current) => connector.mediaTool(current, name, args), name) ?? { status: "failed" as const };
          return { content: [{ type: "text" as const, text: result.status === "ok" ? JSON.stringify(result) : mediaMessages[result.status] }], details: result };
        },
      };
    },
  }, { names: [`thinkarr_${name}`], optional: true });

  if (api.registrationMode !== "full") return;
  api.on("before_dispatch", async (event, context) => {
    // Claim only this plugin's exact prefilled verification grammar, so finance
    // and ordinary conversation keep their existing routing.
    const link = typeof event.content === "string" && event.content.length <= 100 && /^Link account [a-f0-9]{64}$/.test(event.content.trim());
    const replyTo = event.replyToId;
    const intent = options.pilotGroup ? confirmationIntent(event.content, replyTo) : undefined;
    if (!link && !intent) return;
    registration.log("debug", "inbound.intent_detected");
    if (context.channelId !== "whatsapp" && event.channel !== "whatsapp") return;
    const denied = { handled: true, text: link ? messages.failed : mediaMessages.failed };
    const eventFailure = event.channel !== "whatsapp" || context.channelId !== "whatsapp" ? "event_channel_mismatch"
      : event.isGroup !== !link ? "event_chat_kind_mismatch"
      : !event.messageId || event.messageId !== context.messageId || event.messageId.length > 512 ? "event_identity_mismatch"
      : !Number.isSafeInteger(event.timestamp) || event.timestamp! < Date.now() - 900_000 || event.timestamp! > Date.now() + 5000 ? "event_time_invalid"
      : !canonicalPhone(event.senderId) || canonicalPhone(event.senderId) !== canonicalPhone(context.senderId) ? "event_sender_mismatch" : undefined;
    if (eventFailure) { registration.log("warn", "inbound.rejected", { reason: eventFailure }); return denied; }
    const identity = actor(context.channelId, context.accountId, context.senderId, context.conversationId, link);
    if (!identity || (link ? identity.kind !== "direct" : identity.kind !== "group")) { registration.log("warn", "inbound.rejected", { reason: "actor_context_invalid" }); return denied; }
    if (!link && identity.conversation !== options.pilotGroup) return;
    if (!link && (replyTo !== context.replyToId || (replyTo !== undefined && (!replyTo || replyTo.length > 512 || event.replyToIsQuote !== true || context.replyToIsQuote !== true)))) { registration.log("warn", "inbound.rejected", { reason: "quote_context_invalid" }); return intent?.requiresQuote ? undefined : denied; }
    let active = true;
    try {
      if (!link) {
        const result = await runMedia({ ...identity, signal: lifecycle, assertCurrent: () => { if (!active) throw new Error(); assertLive(); } }, api.config,
          (connector, current) => connector.confirmMediaMessage({ ...current, eventId: event.messageId!, eventTime: event.timestamp!, ...(replyTo ? { replyTo } : {}) }, event.content), "media_confirm_request");
        if (!result || result.status === "unclaimed" || (intent?.requiresQuote && result.status === "failed")) return;
        return { handled: true, text: result.status === "ok" ? mediaMessages.failed : mediaMessages[result.status] };
      }
      const trace = createDiagnosticTrace(api.logger, options.debug, "link_complete");
      const signal = AbortSignal.any([lifecycle, AbortSignal.timeout(LINK_VERIFICATION_TIMEOUT_MS)]);
      const assertCurrent = () => { signal.throwIfAborted(); if (!active) throw new ConnectorDiagnosticError("verification_handler_closed"); assertLive(); };
      const outcome = await run({ ...identity, signal, assertCurrent }, api.config,
        { content: event.content, eventId: event.messageId!, eventTime: event.timestamp! }, trace);
      let acknowledgementConfirmed = false;
      try {
        assertCurrent();
        await sendPrivateText(api.config, { account: identity.account, recipient: identity.sender, signal, assertCurrent }, messages[outcome.status], trace.log, "ack");
        acknowledgementConfirmed = true;
        trace.log("info", "verification.reply_delivered", { outcome: outcome.status });
      } catch (error) {
        // The binding may already be committed. Do not retry a possibly-sent
        // acknowledgement or return automatic reply text that could duplicate it.
        trace.error("verification.reply_unconfirmed", error);
      }
      trace.log(acknowledgementConfirmed && outcome.status === "linked" ? "info" : "warn", "operation.completed", { outcome: outcome.status, acknowledgementConfirmed });
      return { handled: true };
    } finally { active = false; }
  }, { timeoutMs: LINK_HOOK_TIMEOUT_MS });
}

const plugin = { id: "thinkarr", name: "Thinkarr", description: "Thinkarr companion with private Plex linking and participant-scoped media requests", register };
export default plugin;
