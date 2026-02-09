import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getConfig, setConfig } from "@/lib/config";
import type { ApiResponse } from "@/types/api";

export async function GET() {
  const session = await getSession();
  if (!session || !session.user.isAdmin) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Admin access required" },
      { status: 403 },
    );
  }

  // Return current config (mask secrets)
  const data = {
    llm: {
      baseUrl: getConfig("llm.baseUrl") || "",
      apiKey: getConfig("llm.apiKey") ? "••••••••" : "",
      model: getConfig("llm.model") || "",
    },
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

  let body: Record<string, Record<string, string>>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  // Update only non-masked values
  const sections: Record<string, { keys: Record<string, boolean> }> = {
    llm: { keys: { baseUrl: false, apiKey: true, model: false } },
    plex: { keys: { url: false, token: true } },
    sonarr: { keys: { url: false, apiKey: true } },
    radarr: { keys: { url: false, apiKey: true } },
    overseerr: { keys: { url: false, apiKey: true } },
  };

  for (const [section, config] of Object.entries(sections)) {
    const sectionData = body[section];
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
