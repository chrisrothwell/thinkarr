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
