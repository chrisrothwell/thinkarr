import OpenAI from "openai";
import { getConfig } from "@/lib/config";

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

  _client = new OpenAI({ baseURL, apiKey });
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

interface LlmEndpointConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  enabled: boolean;
}

const endpointClients = new Map<string, { client: OpenAI; key: string }>();

/**
 * Resolve a modelId like "ep_123:gpt-4.1" to a specific OpenAI client + model.
 * Falls back to the default client/model if endpoint not found.
 */
export function getLlmClientForEndpoint(modelId: string): { client: OpenAI; model: string } {
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
          return { client: cached.client, model: modelName || ep.model };
        }
        const client = new OpenAI({ baseURL: ep.baseUrl, apiKey: ep.apiKey });
        endpointClients.set(ep.id, { client, key: ep.apiKey });
        return { client, model: modelName || ep.model };
      }
    } catch {
      // Fall through
    }
  }

  // Fallback to default
  return { client: getLlmClient(), model: modelName || getLlmModel() };
}
