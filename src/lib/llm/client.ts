import OpenAI from "openai";
import { getConfig } from "@/lib/config";
import { logger } from "@/lib/logger";

/**
 * Wraps globalThis.fetch to capture and log the raw response body on any
 * non-2xx response before the OpenAI SDK reads it. The SDK surfaces structured
 * APIErrors but discards the raw body when it cannot be parsed — producing
 * messages like "400 status code (no body)" with no further detail. This
 * wrapper preserves the body so failures are diagnosable regardless of model.
 *
 * Logging is fire-and-forget (no await) so it never delays the response or
 * interferes with the SDK's own body read.
 */
async function loggingFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await globalThis.fetch(input, init);
  if (!response.ok) {
    response
      .clone()
      .text()
      .then((body) => {
        logger.error("LLM API raw error response", {
          status: response.status,
          rawBody: body || "(no body)",
        });
      })
      .catch(() => {}); // suppress — logging failure must never affect the request
  }
  return response;
}

let _client: OpenAI | null = null;
let _cachedKey: string | null = null;

export function getLlmClient(): OpenAI {
  const baseURL = getConfig("llm.baseUrl");
  const apiKey = getConfig("llm.apiKey");

  if (!baseURL || !apiKey) {
    throw new Error("LLM not configured. Complete setup first.");
  }

  // Re-create client if API key changed (e.g. after reconfiguration)
  if (_client && _cachedKey === apiKey) {
    return _client;
  }

  _client = new OpenAI({ baseURL, apiKey, fetch: loggingFetch });
  _cachedKey = apiKey;
  return _client;
}

export function getLlmModel(): string {
  const model = getConfig("llm.model");
  if (!model) {
    throw new Error("LLM model not configured. Complete setup first.");
  }
  return model;
}

export interface LlmEndpointConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  enabled: boolean;
  supportsVoice?: boolean;
  supportsTts?: boolean;
  ttsVoice?: string;
  transcriptionLanguage?: string;
  supportsRealtime?: boolean;
  realtimeModel?: string;
  realtimeSystemPrompt?: string;
}

const endpointClients = new Map<string, { client: OpenAI; key: string }>();

/**
 * Resolve a modelId like "ep_123:gpt-4.1" to the full LlmEndpointConfig, or null if not found.
 */
export function getEndpointConfig(modelId: string): LlmEndpointConfig | null {
  const colonIdx = modelId.indexOf(":");
  const endpointId = colonIdx !== -1 ? modelId.slice(0, colonIdx) : null;
  if (!endpointId) return null;
  const raw = getConfig("llm.endpoints");
  if (!raw) return null;
  try {
    const endpoints: LlmEndpointConfig[] = JSON.parse(raw);
    return endpoints.find((e) => e.id === endpointId && e.enabled) ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve a modelId like "ep_123:gpt-4.1" to a specific OpenAI client + model + systemPrompt.
 * Falls back to the default client/model if endpoint not found.
 */
export function getLlmClientForEndpoint(modelId: string): { client: OpenAI; model: string; systemPrompt?: string } {
  const colonIdx = modelId.indexOf(":");
  if (colonIdx === -1) {
    // No endpoint prefix — treat as plain model name with default client
    return { client: getLlmClient(), model: modelId };
  }

  const endpointId = modelId.slice(0, colonIdx);
  const modelName = modelId.slice(colonIdx + 1);

  // Look up endpoint from config
  const raw = getConfig("llm.endpoints");
  if (raw) {
    try {
      const endpoints: LlmEndpointConfig[] = JSON.parse(raw);
      const ep = endpoints.find((e) => e.id === endpointId && e.enabled);
      if (ep) {
        // Cache clients per endpoint
        const cached = endpointClients.get(ep.id);
        if (cached && cached.key === ep.apiKey) {
          return { client: cached.client, model: modelName || ep.model, systemPrompt: ep.systemPrompt || undefined };
        }
        const client = new OpenAI({ baseURL: ep.baseUrl, apiKey: ep.apiKey, fetch: loggingFetch });
        endpointClients.set(ep.id, { client, key: ep.apiKey });
        return { client, model: modelName || ep.model, systemPrompt: ep.systemPrompt || undefined };
      }
    } catch {
      // Fall through
    }
  }

  // Fallback to default
  return { client: getLlmClient(), model: modelName || getLlmModel() };
}
