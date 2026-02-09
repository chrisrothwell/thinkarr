import type { TestConnectionRequest, TestConnectionResponse } from "@/types/api";

async function testLlm(url: string, apiKey: string, model?: string): Promise<TestConnectionResponse> {
  try {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ baseURL: url, apiKey });
    if (model) {
      // Quick completion test with the specified model
      await client.chat.completions.create({
        model,
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 1,
      });
      return { success: true, message: `Connected to ${model}` };
    } else {
      // Just list models to verify connectivity
      const models = await client.models.list();
      const count = (await Array.fromAsync(models)).length;
      return { success: true, message: `Connected. ${count} model(s) available.` };
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return { success: false, message: `LLM connection failed: ${msg}` };
  }
}

async function testPlex(url: string, token: string): Promise<TestConnectionResponse> {
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
      return testLlm(req.url, req.apiKey, req.model);
    case "plex":
      return testPlex(req.url, req.apiKey);
    case "sonarr":
    case "radarr":
      return testArrService(req.type, req.url, req.apiKey);
    case "overseerr":
      return testOverseerr(req.url, req.apiKey);
    default:
      return { success: false, message: `Unknown service type: ${req.type}` };
  }
}
