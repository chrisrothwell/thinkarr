import type { TestConnectionRequest, TestConnectionResponse } from "@/types/api";
import { validateServiceUrl } from "@/lib/security/url-validation";

/**
 * Returns true only for genuine OpenAI endpoints (api.openai.com).
 * ChatGPT-compatible providers (Gemini, Anthropic, local proxies, etc.) do not
 * support the WebRTC-based Realtime API even if they expose an OpenAI-compatible
 * REST surface, so realtime capability must never be advertised for them.
 */
export function isOpenAIEndpoint(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === "api.openai.com";
  } catch {
    return false;
  }
}

async function probeVoiceSupport(url: string, apiKey: string): Promise<boolean> {
  try {
    const base = url.replace(/\/$/, "");
    const form = new FormData();
    form.append("model", "whisper-1");
    const res = await fetch(`${base}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(8000),
    });
    // 400 = endpoint exists but we sent bad params; 200 = success; both mean voice is supported
    return res.status === 200 || res.status === 400;
  } catch {
    return false;
  }
}

async function probeRealtimeSupport(url: string, apiKey: string): Promise<string | null> {
  // Realtime (WebRTC) is an OpenAI-exclusive API — skip probing for any other provider.
  if (!isOpenAIEndpoint(url)) return null;
  try {
    const base = url.replace(/\/$/, "");
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const models: Array<{ id: string }> = data?.data ?? [];
    const realtimeModel = models.find((m) => m.id.includes("realtime"));
    return realtimeModel?.id ?? null;
  } catch {
    return null;
  }
}

async function testLlm(url: string, apiKey: string, model?: string): Promise<TestConnectionResponse> {
  try {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ baseURL: url, apiKey });
    if (model) {
      // Quick completion test — some non-OpenAI endpoints reject max_tokens,
      // so fall back to a plain request without it if the first attempt fails.
      try {
        await client.chat.completions.create({
          model,
          messages: [{ role: "user", content: "Hi" }],
          max_tokens: 1,
        });
      } catch {
        await client.chat.completions.create({
          model,
          messages: [{ role: "user", content: "Hi" }],
        });
      }
    } else {
      // Just list models to verify connectivity
      const models = await client.models.list();
      const count = (await Array.fromAsync(models)).length;
      // Return early without capability probing when no model specified
      return { success: true, message: `Connected. ${count} model(s) available.` };
    }

    // Probe capabilities in parallel (best-effort — failures don't affect connection result)
    const [supportsVoice, realtimeModel] = await Promise.all([
      probeVoiceSupport(url, apiKey),
      probeRealtimeSupport(url, apiKey),
    ]);

    return {
      success: true,
      message: `Connected to ${model}`,
      capabilities: { supportsVoice, realtimeModel },
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return { success: false, message: `LLM connection failed: ${msg}` };
  }
}

async function testPlex(url: string, token: string): Promise<TestConnectionResponse> {
  const check = validateServiceUrl(url);
  if (!check.valid) return { success: false, message: `Invalid URL: ${check.error}` };
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/identity`, {
      headers: { "X-Plex-Token": token, Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      return { success: false, message: `Plex returned HTTP ${res.status}` };
    }
    const data = await res.json();
    const name = data?.MediaContainer?.machineIdentifier ? "Plex server" : "Unknown";
    return { success: true, message: `Connected to ${name} (${data?.MediaContainer?.friendlyName || url})` };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return { success: false, message: `Plex connection failed: ${msg}` };
  }
}

async function testArrService(
  type: "sonarr" | "radarr",
  url: string,
  apiKey: string,
): Promise<TestConnectionResponse> {
  const check = validateServiceUrl(url);
  if (!check.valid) return { success: false, message: `Invalid URL: ${check.error}` };
  try {
    const base = url.replace(/\/$/, "");
    const res = await fetch(`${base}/api/v3/system/status`, {
      headers: { "X-Api-Key": apiKey },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      return { success: false, message: `${type} returned HTTP ${res.status}` };
    }
    const data = await res.json();
    const version = data?.version || "unknown";
    return { success: true, message: `Connected to ${type} v${version}` };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return { success: false, message: `${type} connection failed: ${msg}` };
  }
}

async function testOverseerr(url: string, apiKey: string): Promise<TestConnectionResponse> {
  const check = validateServiceUrl(url);
  if (!check.valid) return { success: false, message: `Invalid URL: ${check.error}` };
  try {
    const base = url.replace(/\/$/, "");
    const res = await fetch(`${base}/api/v1/status`, {
      headers: { "X-Api-Key": apiKey },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      return { success: false, message: `Overseerr returned HTTP ${res.status}` };
    }
    const data = await res.json();
    const version = data?.version || "unknown";
    return { success: true, message: `Connected to Overseerr v${version}` };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return { success: false, message: `Overseerr connection failed: ${msg}` };
  }
}

export async function testConnection(req: TestConnectionRequest): Promise<TestConnectionResponse> {
  switch (req.type) {
    case "llm":
      return testLlm(req.url, req.apiKey ?? "", req.model);
    case "plex":
      return testPlex(req.url, req.apiKey ?? "");
    case "sonarr":
    case "radarr":
      return testArrService(req.type, req.url, req.apiKey ?? "");
    case "overseerr":
      return testOverseerr(req.url, req.apiKey ?? "");
    default:
      return { success: false, message: `Unknown service type: ${req.type}` };
  }
}
