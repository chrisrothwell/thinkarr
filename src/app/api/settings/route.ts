import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getConfig, setConfig } from "@/lib/config";
import { logger } from "@/lib/logger";
import { validateServiceUrl } from "@/lib/security/url-validation";
import { checkUserApiRateLimit } from "@/lib/security/api-rate-limit";
import type { ApiResponse } from "@/types/api";

export interface LlmEndpoint {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  enabled: boolean;
  isDefault: boolean;
  supportsVoice: boolean;
  supportsRealtime: boolean;
  realtimeModel: string;
  realtimeSystemPrompt: string;
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
        isDefault: true,
        supportsVoice: false,
        supportsRealtime: false,
        realtimeModel: "",
        realtimeSystemPrompt: "",
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
    logger.warn("ADMIN_ACCESS_DENIED", { userId: session?.user.id, path: "GET /api/settings" });
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Admin access required" },
      { status: 403 },
    );
  }

  if (!checkUserApiRateLimit(session.user.id)) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Too many requests. Please slow down." },
      { status: 429 },
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
    logger.warn("ADMIN_ACCESS_DENIED", { userId: session?.user.id, path: "PATCH /api/settings" });
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Admin access required" },
      { status: 403 },
    );
  }

  if (!checkUserApiRateLimit(session.user.id)) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Too many requests. Please slow down." },
      { status: 429 },
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

    // Validate all baseUrls before saving
    for (const ep of endpoints) {
      if (ep.baseUrl) {
        const check = validateServiceUrl(ep.baseUrl);
        if (!check.valid) {
          return NextResponse.json<ApiResponse>(
            { success: false, error: `LLM endpoint "${ep.name}" has invalid baseUrl: ${check.error}` },
            { status: 400 },
          );
        }
      }
    }

    // Ensure exactly one endpoint is marked as default; fall back to first enabled
    const hasDefault = endpoints.some((e) => e.isDefault && e.enabled);
    if (!hasDefault) {
      const firstEnabled = endpoints.find((e) => e.enabled);
      if (firstEnabled) firstEnabled.isDefault = true;
    }
    setConfig("llm.endpoints", JSON.stringify(endpoints));

    // Update legacy keys to the isDefault endpoint for backward compatibility
    const primary = endpoints.find((e) => e.isDefault && e.enabled) ?? endpoints.find((e) => e.enabled);
    if (primary) {
      setConfig("llm.baseUrl", primary.baseUrl);
      setConfig("llm.apiKey", primary.apiKey, true);
      setConfig("llm.model", primary.model);
    }

    logger.info("SETTINGS_CHANGE", {
      adminUserId: session.user.id,
      section: "llmEndpoints",
      endpointIds: endpoints.map((e) => e.id),
    });
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

    const changedKeys: string[] = [];
    for (const [key, encrypted] of Object.entries(config.keys)) {
      const value = sectionData[key];
      if (value && value !== "••••••••") {
        // Validate URL fields before saving
        if (key === "url") {
          const check = validateServiceUrl(value);
          if (!check.valid) {
            return NextResponse.json<ApiResponse>(
              { success: false, error: `${section}.url is invalid: ${check.error}` },
              { status: 400 },
            );
          }
        }
        setConfig(`${section}.${key}`, value, encrypted);
        changedKeys.push(encrypted ? `${key}=[redacted]` : `${key}=${value}`);
      }
    }

    if (changedKeys.length > 0) {
      logger.info("SETTINGS_CHANGE", {
        adminUserId: session.user.id,
        section,
        changed: changedKeys,
      });
    }
  }

  return NextResponse.json<ApiResponse>({ success: true });
}
