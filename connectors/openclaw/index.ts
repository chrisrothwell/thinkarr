import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { createLinkingConnector, type LinkOutcome, type LinkingConnectorConfig, type PrivateLinkDelivery, type TrustedLinkInvocation } from "../delegated-mcp/linking.js";
import type { OpenClawHost, ToolContext } from "./host.js";

const optionsSchema = z.object({
  credentialsFile: z.string().refine(isAbsolute),
  // Receiving bot accounts/self identities, not a participant allowlist.
  accounts: z.record(z.string().min(1).max(512), z.string().regex(/^\+[1-9][0-9]{6,14}$/)),
}).strict();

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
    if (!stat.isFile() || stat.size > 16_384 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error();
    // Bound the actual read too if the file changes after fstat.
    const buffer = Buffer.alloc(16_385);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 16_384) throw new Error();
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally { await file.close(); }
}

const failure: LinkOutcome = Object.freeze({ status: "failed" });
const messages = {
  linked: "Your Plex account is linked.",
  private_link_sent: "I sent your private Plex sign-in link. Open it, then finish verification in WhatsApp.",
  failed: "Account linking could not be completed. Please ask for a new private link.",
};

/** Synchronous native plugin registration. Credentials are read only inside a
 * current invocation, never during metadata/discovery or into model results.
 */
export function register<C extends object>(api: OpenClawHost<C>) {
  if (!["full", "tool-discovery"].includes(api.registrationMode)) return;
  if (api.runtime.version !== "2026.10.4") throw new Error("Thinkarr requires OpenClaw 2026.10.4");
  const parsed = optionsSchema.safeParse(api.pluginConfig);
  if (!parsed.success) throw new Error("Invalid Thinkarr plugin configuration");
  const options = parsed.data;
  const lifecycle = api.lifecycle.signal;
  if (!lifecycle) throw new Error("Thinkarr requires plugin lifecycle admission");
  const assertLive = () => lifecycle.throwIfAborted();

  function actor(channel: unknown, account: unknown, sender: unknown, nativeConversation: unknown) {
    if (channel !== "whatsapp" || typeof account !== "string" || !Object.hasOwn(options.accounts, account)) return;
    const canonical = canonicalPhone(sender);
    const origin = conversation(nativeConversation);
    if (!canonical || !origin || canonical === canonicalPhone(options.accounts[account])) return;
    if (origin.kind === "direct" && origin.id !== canonical) return;
    return { channel: "whatsapp" as const, account, sender: canonical, kind: origin.kind, conversation: origin.id };
  }

  async function sendPrivate(cfg: C, delivery: PrivateLinkDelivery) {
    delivery.assertCurrent(); assertLive();
    const recipient = canonicalPhone(delivery.recipient);
    if (!recipient || !Object.hasOwn(options.accounts, delivery.account)) throw new Error();
    const outbound = await api.runtime.channel.outbound.loadAdapter("whatsapp");
    delivery.assertCurrent(); assertLive();
    if (!outbound?.resolveTarget || !outbound.sendText) throw new Error();
    const resolved = outbound.resolveTarget({ cfg, to: recipient, accountId: delivery.account, mode: "explicit", allowFrom: [recipient] });
    if (!resolved.ok || canonicalPhone(resolved.to) !== recipient) throw new Error();
    let dispatches = 0;
    const guard = () => { delivery.assertCurrent(); assertLive(); };
    guard();
    const result = await outbound.sendText({
      cfg, to: resolved.to, accountId: delivery.account,
      text: `Link your Plex account privately: ${delivery.url}`,
      signal: delivery.signal, assertDirectAdapterHandoff: guard,
      // The pinned WhatsApp implementation awaits this before each physical
      // send (including chunks); it does not forward assertDirectAdapterHandoff.
      onPlatformSendDispatch: async () => { guard(); dispatches++; },
    });
    guard();
    if (dispatches === 0 || result.channel !== "whatsapp" || !result.messageId?.trim() || canonicalPhone(result.toJid) !== recipient) throw new Error();
    return { accepted: true as const, channel: "whatsapp" as const, account: delivery.account, recipient, messageId: result.messageId };
  }

  async function run(invocation: TrustedLinkInvocation, cfg: C, completion?: { content: string; eventId: string; eventTime: number }): Promise<LinkOutcome> {
    try {
      const signal = AbortSignal.any([AbortSignal.timeout(15_000), ...(invocation.signal ? [invocation.signal] : [])]);
      const assertCurrent = () => { signal.throwIfAborted(); invocation.assertCurrent(); };
      assertCurrent();
      const credentials = await readCredentials(options.credentialsFile);
      assertCurrent();
      const connector = await createLinkingConnector(credentials, { sendPrivate: (d) => sendPrivate(cfg, d) });
      assertCurrent();
      const current = { ...invocation, signal, assertCurrent };
      return completion
        ? (await connector.handlePrivateLinkMessage({ ...current, eventId: completion.eventId, eventTime: completion.eventTime }, completion.content)) ?? failure
        : await connector.startLink(current);
    } catch { return failure; }
  }

  api.registerTool({
    contextVersion: 2,
    create(ctx: ToolContext<C>) {
      const identity = actor(ctx.messageChannel, ctx.agentAccountId, ctx.requesterSenderId, ctx.nativeChannelId);
      if (!identity || typeof ctx.assertInvocationCurrent !== "function") return null;
      const route = ctx.deliveryContext;
      if (route && ((route.channel !== undefined && route.channel !== identity.channel)
        || (route.accountId !== undefined && route.accountId !== identity.account)
        || (route.to !== undefined && conversation(route.to)?.id !== identity.conversation))) return null;
      const assertCurrent = ctx.assertInvocationCurrent;
      const cfg = ctx.runtimeConfig ?? ctx.config ?? api.config;
      return {
        name: "thinkarr_account_link", label: "Link Plex account",
        description: "Privately link the current WhatsApp participant to Plex. Takes no identity or delivery arguments; returns only a safe outcome.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async execute(_id, args, signal) {
          let outcome = failure;
          if (z.object({}).strict().safeParse(args).success) {
            outcome = await run({ ...identity, signal: signal ? AbortSignal.any([signal, lifecycle]) : lifecycle,
              assertCurrent: () => { assertLive(); assertCurrent(); } }, cfg);
          }
          return { content: [{ type: "text" as const, text: messages[outcome.status] }], details: outcome };
        },
      };
    },
  }, { names: ["thinkarr_account_link"], optional: true });

  if (api.registrationMode !== "full") return;
  api.on("before_dispatch", async (event, context) => {
    // Claim only this plugin's exact prefilled verification grammar, so finance
    // and ordinary conversation keep their existing routing.
    if (typeof event.content !== "string" || event.content.length > 100 || !/^Link account [a-f0-9]{64}$/.test(event.content.trim())) return;
    if (context.channelId !== "whatsapp" && event.channel !== "whatsapp") return;
    const denied = { handled: true, text: messages.failed };
    if (event.channel !== "whatsapp" || context.channelId !== "whatsapp" || event.isGroup !== false
      || !event.messageId || event.messageId !== context.messageId || event.messageId.length > 512
      || !Number.isSafeInteger(event.timestamp) || event.timestamp! < Date.now() - 900_000 || event.timestamp! > Date.now() + 5000
      || !canonicalPhone(event.senderId) || canonicalPhone(event.senderId) !== canonicalPhone(context.senderId)) return denied;
    const identity = actor(context.channelId, context.accountId, context.senderId, context.conversationId);
    if (!identity || identity.kind !== "direct") return denied;
    let active = true;
    try {
      const outcome = await run({ ...identity, signal: lifecycle, assertCurrent: () => { if (!active) throw new Error(); assertLive(); } }, api.config,
        { content: event.content, eventId: event.messageId, eventTime: event.timestamp! });
      return { handled: true, text: messages[outcome.status] };
    } finally { active = false; }
  }, { timeoutMs: 20_000 });
}

const plugin = { id: "thinkarr", name: "Thinkarr", description: "Private, sender-verified Plex linking over signed MCP", register };
export default plugin;
