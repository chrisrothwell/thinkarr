/**
 * Langfuse observability client.
 *
 * Configuration priority (first match wins):
 *   1. Environment variables  — LANGFUSE_SECRET_KEY, LANGFUSE_PUBLIC_KEY, LANGFUSE_HOST
 *   2. DB app_config keys     — langfuse.secretKey, langfuse.publicKey, langfuse.baseUrl
 *
 * If neither source provides both keys, all calls are silent no-ops — no
 * changes to orchestrator behaviour and no extra latency.
 *
 * Self-hosted Langfuse: set LANGFUSE_HOST (env) or langfuse.baseUrl (DB) to
 * your instance URL.  Defaults to https://cloud.langfuse.com.
 */
import Langfuse from "langfuse";
import type { LangfuseTraceClient } from "langfuse";
import { getConfig } from "@/lib/config";

export type { LangfuseTraceClient };

interface ResolvedKeys {
  secretKey: string;
  publicKey: string;
  baseUrl: string;
}

function resolveKeys(): ResolvedKeys | null {
  const secret = process.env.LANGFUSE_SECRET_KEY || getConfig("langfuse.secretKey") || "";
  const pub = process.env.LANGFUSE_PUBLIC_KEY || getConfig("langfuse.publicKey") || "";
  if (!secret || !pub) return null;
  const baseUrl =
    process.env.LANGFUSE_HOST ||
    getConfig("langfuse.baseUrl") ||
    "https://cloud.langfuse.com";
  return { secretKey: secret, publicKey: pub, baseUrl };
}

let _client: Langfuse | null = null;
let _cachedCacheKey: string | null = null;

function getClient(): Langfuse | null {
  const keys = resolveKeys();
  if (!keys) return null;

  const cacheKey = `${keys.secretKey}:${keys.publicKey}:${keys.baseUrl}`;
  if (_client && _cachedCacheKey === cacheKey) return _client;

  _client = new Langfuse({
    secretKey: keys.secretKey,
    publicKey: keys.publicKey,
    baseUrl: keys.baseUrl,
    // Flush after each trace so events reach Langfuse before the
    // Next.js function/container exits.
    flushAt: 1,
    flushInterval: 0,
  });
  _cachedCacheKey = cacheKey;
  return _client;
}

export function isLangfuseEnabled(): boolean {
  return resolveKeys() !== null;
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
