import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { createLinkingConnector, linkingConnectorConfigSchema, LINK_OPERATION_TIMEOUT_MS, LINK_VERIFICATION_TIMEOUT_MS, LINK_HOOK_TIMEOUT_MS, type LinkOutcome, type LinkingConnectorConfig, type PrivateLinkDelivery, type TrustedLinkInvocation } from "../delegated-mcp/linking.js";
import type { OpenClawHost, ToolContext, GroupReplyResult } from "./host.js";
import { loadPreparedSecretReader } from "./secrets.js";
import { confirmationIntent, mediaTools, mediaInputSchema, type MediaOutcome } from "../delegated-mcp/media-contract.js";
import { ConnectorDiagnosticError, createDiagnosticTrace, diagnosticErrorFields, type DiagnosticSink } from "../delegated-mcp/diagnostics.js";
import { createLifecycleDiagnostics } from "./lifecycle.js";
import { createPromptReplyGuard } from "./reply-guard.js";

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
  const native = typeof value === "string" && value.startsWith("whatsapp:") ? value.slice(9) : value;
  if (typeof native === "string" && /^[0-9]+(?:-[0-9]+)?@g\.us$/.test(native) && native.length <= 512) return { kind: "group" as const, id: native };
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
  private_link_sent: "Check your private WhatsApp message to finish linking Plex.",
  private_delivery_unconfirmed: "Check your private WhatsApp chat for the Plex sign-in instructions. If no message arrived, let me know.",
  permission_required: "Ask the Thinkarr administrator to enable account_link_start and account_link_confirm for this integration in Settings → MCP → Service integrations → Operation allowlist. Keep the existing setup; no new enrollment or key rotation is needed.",
  unavailable: "Thinkarr did not respond in time. Please try this step again while your current private link is valid; keep the link if you already received one.",
  unknown: "I could not confirm the result from Thinkarr. Please check your account-link status before trying again.",
  failed: "Account linking could not be completed. Please ask for a new private link.",
};

/** Synchronous registration accepts source refs or host-materialized strings.
 * Prepared native secrets and legacy files are read only during an admitted
 * invocation, never during registration or tool discovery.
 */
export function register<C extends object>(api: OpenClawHost<C>) {
  let registration = createDiagnosticTrace(api.logger, api.pluginConfig?.debug === true, "registration");
  if (!["full", "tool-discovery"].includes(api.registrationMode)) return;
  if (api.runtime.version !== "2026.10.4") { registration.error("registration.version", new ConnectorDiagnosticError("host_version_unsupported")); throw new Error("Thinkarr requires OpenClaw 2026.10.4"); }
  const parsed = optionsSchema.safeParse(api.pluginConfig);
  if (!parsed.success) { registration.log("error", "registration.config", { ...diagnosticErrorFields(parsed.error), reason: "configuration_invalid" }); throw configurationError(api.pluginConfig); }
  const options = parsed.data;
  const lifecycle = api.lifecycle.signal;
  if (!lifecycle) { registration.error("registration.lifecycle", new ConnectorDiagnosticError("plugin_lifetime_missing")); throw new Error("Thinkarr requires plugin lifecycle admission"); }
  const diagnostics = createLifecycleDiagnostics(api.lifecycle, api.logger, options.debug, api.registrationMode as "full" | "tool-discovery");
  registration = diagnostics.trace("registration");
  const promptReplies = createPromptReplyGuard(api, options.pilotGroup, registration.log,
    (account, target) => Object.hasOwn(options.accounts, account) && canonicalPhone(target) === canonicalPhone(options.accounts[account]));
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

  async function sendGroupText(cfg: C, delivery: { account: string; conversation: string; text: string; signal: AbortSignal; assertCurrent: () => void }, log: DiagnosticSink, kind: "prompt" | "result") {
    const guard = () => { delivery.signal.throwIfAborted(); delivery.assertCurrent(); assertLive(); };
    guard(); log("debug", `outbound.${kind}_validate`);
    if (delivery.conversation !== options.pilotGroup || !Object.hasOwn(options.accounts, delivery.account)) throw new ConnectorDiagnosticError("prompt_target_invalid");
    log("debug", `outbound.${kind}_adapter`);
    const outbound = await api.runtime.channel.outbound.loadAdapter("whatsapp"); guard();
    if (!outbound?.resolveTarget || !outbound.sendText) throw new ConnectorDiagnosticError("whatsapp_outbound_unavailable");
    log("debug", `outbound.${kind}_resolve`);
    const resolved = outbound.resolveTarget({ cfg, to: delivery.conversation, accountId: delivery.account, mode: "explicit", allowFrom: [delivery.conversation] });
    if (!resolved.ok || conversation(resolved.to)?.id !== delivery.conversation) throw new ConnectorDiagnosticError("prompt_target_mismatch");
    let dispatches = 0;
    log("debug", `outbound.${kind}_send`); guard();
    const receipt = await outbound.sendText({ cfg, to: resolved.to, accountId: delivery.account, text: delivery.text,
      signal: delivery.signal, assertDirectAdapterHandoff: guard,
      onPlatformSendDispatch: async () => { guard(); log("debug", `outbound.${kind}_dispatch`); dispatches++; },
    });
    guard(); log("debug", `outbound.${kind}_receipt`);
    if (!dispatches) throw new ConnectorDiagnosticError("prompt_dispatch_fence_missing");
    if (receipt.channel !== "whatsapp" || !receipt.messageId?.trim() || conversation(receipt.toJid)?.id !== delivery.conversation) throw new ConnectorDiagnosticError("prompt_receipt_invalid");
    return { accepted: true as const, conversation: delivery.conversation, messageId: receipt.messageId };
  }

  async function run(invocation: TrustedLinkInvocation, cfg: C, completion?: { content: string; eventId: string; eventTime: number }, trace = diagnostics.trace(completion ? "link_complete" : "link_start")): Promise<LinkOutcome> {
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

  async function runMedia(invocation: TrustedLinkInvocation, cfg: C, action: (connector: Awaited<ReturnType<typeof createLinkingConnector>>, current: TrustedLinkInvocation) => Promise<MediaOutcome | undefined>, operation = "media_operation", trace = diagnostics.trace(operation)): Promise<MediaOutcome | undefined> {
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
          if (delivery.account !== invocation.account) throw new ConnectorDiagnosticError("prompt_target_invalid");
          return sendGroupText(cfg, { ...delivery, assertCurrent: () => { delivery.assertCurrent(); assertCurrent(); } }, trace.log, "prompt");
        },
      });
      assertCurrent();
      step("connector.invoke");
      const result = await action(connector, { ...invocation, signal, assertCurrent });
      trace.log(result && ["failed", "blocked", "unknown"].includes(result.status) ? "warn" : "info", operation === "media_confirm_request" ? "confirmation.result" : "operation.completed", { outcome: result?.status ?? "unclaimed" });
      return result;
    } catch (error) { trace.error(stage, error); trace.log("warn", operation === "media_confirm_request" ? "confirmation.result" : "operation.completed", { outcome: "failed" }); return { status: "failed" }; }
  }
  const mediaMessages = {
    prompt_sent: "The confirmation message is already visible in WhatsApp and includes the reply instructions. Do not send another confirmation, summary or instruction message. End this turn with NO_REPLY and wait for the user's native reply.",
    submitted: "Your request was submitted to Seerr.", pending_approval: "Your request was submitted and is awaiting approval in Seerr.",
    expired: "That choice expired. Ask me to find it again.", reply_to_prompt: "Please reply directly to the current title confirmation with “request it”.",
    blocked: "That request could not be submitted. Please check your Seerr account privately.",
    unknown: "I could not verify the request outcome. Please check Seerr before trying again.",
    failed: "This request step could not be completed. Ask your Thinkarr administrator to check the integration operation permissions and diagnostic logs.",
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
        description: "Privately link the current WhatsApp participant to Plex. Takes no identity or delivery arguments. Announce the returned private-chat guidance once, concisely. For private_delivery_unconfirmed, ask the user to check their private chat without receipt jargon or automatically requesting another link. An unknown outcome requires checking account-link status first.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async execute(_id, args, signal) {
          let outcome = failure;
          if (z.object({}).strict().safeParse(args).success) {
            const currentSignal = signal ? AbortSignal.any([signal, lifecycle]) : lifecycle;
            outcome = await diagnostics.run("link_tool", "link_start", currentSignal, (trace) => run({ ...identity, signal: currentSignal,
              assertCurrent: () => { assertLive(); assertCurrent(); } }, cfg, undefined, trace));
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
        description: name === "media_select" ? "Send the one native confirmation prompt for the exact title and explicit TV seasons after search/details. This tool already delivers the message and its reply instructions. After prompt_sent, end the turn with NO_REPLY and wait; do not send an extra confirmation or instruction message. Does not submit."
          : "Find title facts using the existing Seerr catalog. No library availability or personal activity is returned; do not infer availability. Link Plex with thinkarr_account_link first.",
        parameters: mediaInputSchema(name),
        async execute(_id, args, signal) {
          const currentSignal = signal ? AbortSignal.any([signal, lifecycle]) : lifecycle;
          const result = await diagnostics.run("media_tool", name, currentSignal, (trace) => runMedia({ ...identity, signal: currentSignal,
            assertCurrent: () => { assertLive(); assertCurrent(); } }, ctx.runtimeConfig ?? ctx.config ?? api.config, (connector, current) => connector.mediaTool(current, name, args), name, trace)) ?? { status: "failed" as const };
          if (name === "media_select" && result.status === "prompt_sent") promptReplies.presented(_id, ctx.sessionKey, identity.account);
          return { content: [{ type: "text" as const, text: result.status === "ok" ? JSON.stringify(result) : mediaMessages[result.status] }], details: result };
        },
      };
    },
  }, { names: [`thinkarr_${name}`], optional: true });

  if (api.registrationMode !== "full") return;
  if (options.pilotGroup) api.on("reply_dispatch", async (event, context): Promise<GroupReplyResult | void> => {
    // This global hook exposes the full post-admission native frame. The legacy
    // before_dispatch conversationId may be the receiving bot even for groups.
    const native = event.ctx;
    const raw = native.RawBody;
    if (typeof raw !== "string" || event.isTailDispatch) return;
    const replyTo = typeof native.ReplyToId === "string" ? native.ReplyToId : undefined;
    const intent = confirmationIntent(raw, replyTo);
    if (!intent || native.Provider !== "whatsapp") return;
    const from = conversation(native.From);
    if (from?.kind !== "group" || from.id !== options.pilotGroup) return;
    const trace = diagnostics.trace("media_confirm_request");
    const reject = (reason: string) => { trace.log("warn", "confirmation.rejected", { reason }); };
    if (native.InboundAccessAuthorized !== true || native.InboundEventKind !== "user_request") return reject("confirmation_not_admitted");
    if (context.dispatchKind !== "agent" || native.InternalTurnSource !== undefined || native.InputProvenance !== undefined) return reject("confirmation_not_foreground");
    // Tool-only suppresses automatic finals in normal groups, not this explicit
    // native-command result. ACP/background/synthetic/observed turns are denied
    // separately above; a hard send-policy denial always remains authoritative.
    if (event.sendPolicy !== "allow" || (event.suppressUserDelivery && event.sourceReplyDeliveryMode !== "message_tool_only")) return reject("confirmation_delivery_suppressed");
    if (native.ChatType !== "group" || conversation(native.ChatId)?.id !== from.id || conversation(native.OriginatingTo)?.id !== from.id) return reject("confirmation_group_mismatch");
    if ((native.Surface !== undefined && native.Surface !== "whatsapp") || native.OriginatingChannel !== "whatsapp"
      || (event.originatingChannel !== undefined && event.originatingChannel !== "whatsapp")
      || (event.originatingTo !== undefined && conversation(event.originatingTo)?.id !== from.id)
      || (event.originatingChatType !== undefined && event.originatingChatType !== "group")) return reject("confirmation_route_mismatch");
    const account = native.AccountId;
    if (typeof account !== "string" || !Object.hasOwn(options.accounts, account)
      || (event.originatingAccountId !== undefined && event.originatingAccountId !== account)) return reject("confirmation_account_mismatch");
    const receiver = canonicalPhone(native.To);
    if (receiver !== canonicalPhone(options.accounts[account]) && conversation(native.To)?.id !== from.id) return reject("confirmation_receiver_mismatch");
    const sender = canonicalPhone(native.SenderId);
    if (!sender || native.SenderIsSelf === true || native.SenderIsBot === true || sender === canonicalPhone(options.accounts[account])) return reject("confirmation_sender_unsupported");
    const eventId = native.MessageSidFull ?? native.MessageSid;
    const eventTime = native.Timestamp;
    if (typeof eventId !== "string" || !eventId || eventId.length > 512 || typeof eventTime !== "number" || !Number.isSafeInteger(eventTime)
      || eventTime < Date.now() - 900_000 || eventTime > Date.now() + 5000) return reject("confirmation_event_invalid");
    const supplemental = native.SupplementalContext;
    const quote = supplemental && typeof supplemental === "object" ? Reflect.get(supplemental, "quote") : undefined;
    const quotedId = quote && typeof quote === "object" ? Reflect.get(quote, "id") : undefined;
    if (quotedId !== undefined && quotedId !== replyTo) return reject("confirmation_quote_mismatch");
    // In this pinned WhatsApp adapter ReplyToId is populated from the visible
    // native provider quote. Supplemental quote *body* may subsequently be
    // removed by context-visibility policy, without removing the route ID.
    // Do not demand an optional flag/body as a second authorization source.
    // All group/account/admission checks above and server exact-prompt checks
    // still apply; explicitly non-quote/conflicting evidence remains rejected.
    const quoteVerified = native.ReplyToIsQuote !== false && !!replyTo;
    if (native.ReplyToId !== undefined && (!replyTo || replyTo.length > 512 || !quoteVerified)) return reject("confirmation_quote_unverified");
    if (replyTo) trace.log("debug", "confirmation.quote_verified", { reason: quotedId === replyTo ? "matching_supplemental_quote" : "native_reply_id" });
    const identity = actor("whatsapp", account, sender, from.id);
    if (!identity) return reject("confirmation_actor_invalid");
    const signal = AbortSignal.any([lifecycle, AbortSignal.timeout(28_000), ...(context.abortSignal ? [context.abortSignal] : [])]);
    return diagnostics.run("group_hook", "media_confirm_request", signal, async (trace) => {
      trace.log("debug", "confirmation.native_context_verified");
      let active = true;
      const assertCurrent = () => { signal.throwIfAborted(); assertLive(); if (!active) throw new ConnectorDiagnosticError("confirmation_handler_closed"); };
      try {
        const result = await runMedia({ ...identity, signal, assertCurrent }, context.cfg,
          (connector, current) => connector.confirmMediaMessage({ ...current, eventId, eventTime, ...(replyTo ? { replyTo } : {}) }, raw), "media_confirm_request", trace);
        // Generic quoted yes remains available to finance/other handlers unless
        // Thinkarr actually owns the current exact prompt.
        if (!result || result.status === "unclaimed" || (intent.requiresQuote && result.status === "failed")) return;
        let acknowledgementConfirmed = false;
        try {
          if (result.status === "ok" || result.status === "prompt_sent") throw new ConnectorDiagnosticError("confirmation_outcome_invalid");
          await sendGroupText(context.cfg, { account, conversation: from.id, text: mediaMessages[result.status], signal, assertCurrent }, trace.log, "result");
          acknowledgementConfirmed = true;
        } catch (error) { trace.error("confirmation.reply_unconfirmed", error); }
        trace.log(acknowledgementConfirmed ? "info" : "warn", "operation.completed", { outcome: result.status, acknowledgementConfirmed });
        // The host owns settlement after abort. For a live takeover, finish its
        // bookkeeping without throwing after a possibly-visible result message.
        if (!context.abortSignal?.aborted && !lifecycle.aborted) {
          try { context.recordProcessed("completed", { reason: "thinkarr_confirmation_handled" }); }
          catch (error) { trace.error("confirmation.record_unconfirmed", error); }
          try { context.markIdle("message_completed"); }
          catch (error) { trace.error("confirmation.idle_unconfirmed", error); }
        }
        return { handled: true, queuedFinal: acknowledgementConfirmed, counts: { tool: 0, block: 0, final: acknowledgementConfirmed ? 1 : 0 } };
      } finally { active = false; }
    });
  }, { timeoutMs: 30_000 });
  api.on("before_dispatch", async (event, context) => {
    // Claim only this plugin's exact prefilled verification grammar, so finance
    // and ordinary conversation keep their existing routing.
    const link = typeof event.content === "string" && event.content.length <= 100 && /^Link account [a-f0-9]{64}$/.test(event.content.trim());
    if (!link) return;
    registration.log("debug", "inbound.intent_detected");
    if (context.channelId !== "whatsapp" && event.channel !== "whatsapp") return;
    const denied = { handled: true, text: messages.failed };
    const eventFailure = event.channel !== "whatsapp" || context.channelId !== "whatsapp" ? "event_channel_mismatch"
      : event.isGroup !== !link ? "event_chat_kind_mismatch"
      : !event.messageId || event.messageId !== context.messageId || event.messageId.length > 512 ? "event_identity_mismatch"
      : !Number.isSafeInteger(event.timestamp) || event.timestamp! < Date.now() - 900_000 || event.timestamp! > Date.now() + 5000 ? "event_time_invalid"
      : !canonicalPhone(event.senderId) || canonicalPhone(event.senderId) !== canonicalPhone(context.senderId) ? "event_sender_mismatch" : undefined;
    if (eventFailure) { registration.log("warn", "inbound.rejected", { reason: eventFailure }); return denied; }
    const identity = actor(context.channelId, context.accountId, context.senderId, context.conversationId, link);
    if (!identity || identity.kind !== "direct") { registration.log("warn", "inbound.rejected", { reason: "actor_context_invalid" }); return denied; }
    const signal = AbortSignal.any([lifecycle, AbortSignal.timeout(LINK_VERIFICATION_TIMEOUT_MS)]);
    return diagnostics.run("private_hook", "link_complete", signal, async (trace) => {
      let active = true;
      try {
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
    });
  }, { timeoutMs: LINK_HOOK_TIMEOUT_MS });
}

const plugin = { id: "thinkarr", name: "Thinkarr", description: "Thinkarr companion with private Plex linking and participant-scoped media requests", register };
export default plugin;
