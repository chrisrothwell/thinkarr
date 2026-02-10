import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getConfig, setConfig } from "@/lib/config";
import type { ApiResponse } from "@/types/api";

export interface LlmEndpoint {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  enabled: boolean;
}

function getLlmEndpoints(): LlmEndpoint[] {
  const raw = getConfig("llm.endpoints");
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {
      // Fall through to legacy
    }
  }

  // Legacy: migrate single endpoint to array
  const baseUrl = getConfig("llm.baseUrl");
  const apiKey = getConfig("llm.apiKey");
  const model = getConfig("llm.model");
  if (baseUrl && apiKey) {
    return [
      {
        id: "default",
        name: "Default",
        baseUrl,
        apiKey,
        model: model || "gpt-4.1",
        systemPrompt: "",
        enabled: true,
      },
    ];
  }
  return [];
}

function getMaskedEndpoints(): LlmEndpoint[] {
  return getLlmEndpoints().map((ep) => ({
    ...ep,
    apiKey: ep.apiKey ? "••••••••" : "",
  }));
}

export async function GET() {
  const session = await getSession();
  if (!session || !session.user.isAdmin) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Admin access required" },
      { status: 403 },
    );
  }

  const data = {
    llmEndpoints: getMaskedEndpoints(),
    plex: {
      url: getConfig("plex.url") || "",
      token: getConfig("plex.token") ? "••••••••" : "",
    },
    sonarr: {
      url: getConfig("sonarr.url") || "",
      apiKey: getConfig("sonarr.apiKey") ? "••••••••" : "",
    },
    radarr: {
      url: getConfig("radarr.url") || "",
      apiKey: getConfig("radarr.apiKey") ? "••••••••" : "",
    },
    overseerr: {
      url: getConfig("overseerr.url") || "",
      apiKey: getConfig("overseerr.apiKey") ? "••••••••" : "",
    },
  };

  return NextResponse.json<ApiResponse>({ success: true, data });
}

export async function PATCH(request: Request) {
  const session = await getSession();
  if (!session || !session.user.isAdmin) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Admin access required" },
      { status: 403 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  // Handle LLM endpoints
  if (body.llmEndpoints && Array.isArray(body.llmEndpoints)) {
    const existing = getLlmEndpoints();
    const endpoints = (body.llmEndpoints as LlmEndpoint[]).map((ep) => {
      // Preserve masked API keys
      if (ep.apiKey === "••••••••") {
        const prev = existing.find((e) => e.id === ep.id);
        ep.apiKey = prev?.apiKey || "";
      }
      return ep;
    });
    setConfig("llm.endpoints", JSON.stringify(endpoints));

    // Also update legacy keys for backward compatibility with orchestrator
    const primary = endpoints.find((e) => e.enabled);
    if (primary) {
      setConfig("llm.baseUrl", primary.baseUrl);
      setConfig("llm.apiKey", primary.apiKey, true);
      setConfig("llm.model", primary.model);
    }
  }

  // Handle arr services
  const sections: Record<string, { keys: Record<string, boolean> }> = {
    plex: { keys: { url: false, token: true } },
    sonarr: { keys: { url: false, apiKey: true } },
    radarr: { keys: { url: false, apiKey: true } },
    overseerr: { keys: { url: false, apiKey: true } },
  };

  for (const [section, config] of Object.entries(sections)) {
    const sectionData = body[section] as Record<string, string> | undefined;
    if (!sectionData) continue;

    for (const [key, encrypted] of Object.entries(config.keys)) {
      const value = sectionData[key];
      if (value && value !== "••••••••") {
        setConfig(`${section}.${key}`, value, encrypted);
      }
    }
  }

  return NextResponse.json<ApiResponse>({ success: true });
}
