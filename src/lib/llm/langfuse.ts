/**
 * Langfuse observability client.
 *
 * Opt-in: set LANGFUSE_SECRET_KEY + LANGFUSE_PUBLIC_KEY to enable.
 * If either key is absent all calls are silent no-ops — no changes to
 * orchestrator behaviour and no extra latency.
 *
 * Self-hosted Langfuse: set LANGFUSE_HOST to your instance URL.
 * Defaults to https://cloud.langfuse.com.
 */
import Langfuse from "langfuse";
import type { LangfuseTraceClient } from "langfuse";

export type { LangfuseTraceClient };

let _client: Langfuse | null = null;

function getClient(): Langfuse | null {
  const secret = process.env.LANGFUSE_SECRET_KEY;
  const pub = process.env.LANGFUSE_PUBLIC_KEY;

  if (!secret || !pub) return null;

  if (!_client) {
    _client = new Langfuse({
      secretKey: secret,
      publicKey: pub,
      baseUrl: process.env.LANGFUSE_HOST ?? "https://cloud.langfuse.com",
      // Flush after each trace so events reach Langfuse before the
      // Next.js function/container exits.
      flushAt: 1,
      flushInterval: 0,
    });
  }

  return _client;
}

export function isLangfuseEnabled(): boolean {
  return !!(process.env.LANGFUSE_SECRET_KEY && process.env.LANGFUSE_PUBLIC_KEY);
}

/** Start a root trace for one chat request. Returns null if Langfuse is not configured. */
export function startTrace(params: {
  conversationId: string;
  userId: string;
  userMessage: string;
  model: string;
}): LangfuseTraceClient | null {
  const client = getClient();
  if (!client) return null;

  return client.trace({
    name: "chat",
    sessionId: params.conversationId,
    userId: params.userId,
    input: params.userMessage,
    metadata: { model: params.model },
  });
}

/** Flush buffered events. Call fire-and-forget at the end of a request. */
export function flushLangfuse(): void {
  _client?.flushAsync().catch(() => {
    // Best-effort — never throw
  });
}
