/** Narrow structural SDK surface. check:openclaw checks registration against
 * the integrity-pinned, published OpenClaw declarations without installing its
 * runtime/dependency tree into the Thinkarr application.
 */
export type ToolContext<C extends object> = {
  config?: C; runtimeConfig?: C;
  messageChannel?: string; agentAccountId?: string; nativeChannelId?: string; requesterSenderId?: string;
  deliveryContext?: { channel?: string; accountId?: string; to?: string };
  assertInvocationCurrent: () => void;
};
export type LinkTool = {
  name: string; label: string; description: string;
  parameters: { type: "object"; properties: Record<string, unknown>; additionalProperties: false; required?: string[] };
  execute: (id: string, args: unknown, signal?: AbortSignal) => Promise<{
    content: Array<{ type: "text"; text: string }>; details: { status: string };
  }>;
};
export type DispatchEvent = {
  content: string; channel?: string; senderId?: string; messageId?: string; timestamp?: number; isGroup?: boolean;
  replyToId?: string; replyToIsQuote?: boolean;
};
export type DispatchContext = {
  channelId?: string; accountId?: string; conversationId?: string; senderId?: string; messageId?: string;
  replyToId?: string; replyToIsQuote?: boolean;
};
export type DispatchResult = { handled: boolean; text?: string };
export type Outbound<C extends object> = {
  resolveTarget?: (params: { cfg: C; to: string; accountId: string; mode: "explicit"; allowFrom: string[] }) =>
    { ok: true; to: string } | { ok: false; error: Error };
  sendText?: (params: {
    cfg: C; to: string; accountId: string; text: string; signal: AbortSignal;
    onPlatformSendDispatch: () => Promise<void>; assertDirectAdapterHandoff: () => void;
  }) => Promise<{ channel: string; messageId?: string; toJid?: string }>;
};
export type OpenClawHost<C extends object> = {
  registrationMode: string; config: C; pluginConfig?: Record<string, unknown>;
  logger?: { info: (message: string) => void; warn: (message: string) => void; error: (message: string) => void };
  lifecycle: { readonly signal?: AbortSignal };
  runtime: { version: string; channel: { outbound: { loadAdapter: (channel: "whatsapp") => Promise<Outbound<C> | undefined> } } };
  registerTool: (factory: { contextVersion: 2; create: (ctx: ToolContext<C>) => LinkTool | null }, opts: { names: string[]; optional: boolean }) => void;
  on: (name: "before_dispatch", handler: (event: DispatchEvent, ctx: DispatchContext) => Promise<DispatchResult | void>, opts: { timeoutMs: number }) => void;
};
