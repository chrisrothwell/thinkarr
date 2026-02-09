import { NextResponse } from "next/server";
import { getConfig, setConfig, isSetupComplete } from "@/lib/config";
import type { SetupStatus, SetupSaveRequest, ApiResponse } from "@/types/api";

export async function GET() {
  const status: SetupStatus = {
    complete: isSetupComplete(),
    hasLlm: !!getConfig("llm.baseUrl"),
    hasPlex: !!getConfig("plex.url"),
    hasSonarr: !!getConfig("sonarr.url"),
    hasRadarr: !!getConfig("radarr.url"),
    hasOverseerr: !!getConfig("overseerr.url"),
  };

  return NextResponse.json<ApiResponse<SetupStatus>>({
    success: true,
    data: status,
  });
}

export async function POST(request: Request) {
  if (isSetupComplete()) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Setup already complete. Use settings to reconfigure." },
      { status: 400 },
    );
  }

  let body: SetupSaveRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  // Validate required fields
  if (!body.llm?.baseUrl || !body.llm?.apiKey || !body.llm?.model) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "LLM configuration (baseUrl, apiKey, model) is required" },
      { status: 400 },
    );
  }
  if (!body.plex?.url || !body.plex?.token) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Plex configuration (url, token) is required" },
      { status: 400 },
    );
  }

  // Save LLM config
  setConfig("llm.baseUrl", body.llm.baseUrl);
  setConfig("llm.apiKey", body.llm.apiKey, true);
  setConfig("llm.model", body.llm.model);

  // Save Plex config
  setConfig("plex.url", body.plex.url);
  setConfig("plex.token", body.plex.token, true);

  // Save optional services
  if (body.sonarr?.url && body.sonarr?.apiKey) {
    setConfig("sonarr.url", body.sonarr.url);
    setConfig("sonarr.apiKey", body.sonarr.apiKey, true);
  }

  if (body.radarr?.url && body.radarr?.apiKey) {
    setConfig("radarr.url", body.radarr.url);
    setConfig("radarr.apiKey", body.radarr.apiKey, true);
  }

  if (body.overseerr?.url && body.overseerr?.apiKey) {
    setConfig("overseerr.url", body.overseerr.url);
    setConfig("overseerr.apiKey", body.overseerr.apiKey, true);
  }

  setConfig("setup.complete", "true");

  return NextResponse.json<ApiResponse>({ success: true });
}
