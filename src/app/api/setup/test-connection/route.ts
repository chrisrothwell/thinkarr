import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { testConnection } from "@/lib/services/test-connection";
import { getConfig } from "@/lib/config";
import type { TestConnectionRequest, TestConnectionResponse, ApiResponse } from "@/types/api";

const MASK = "••••••••";

/** Look up a stored apiKey for a service, falling back when the frontend sends a masked value. */
function resolveApiKey(body: TestConnectionRequest): string {
  if (body.apiKey && body.apiKey !== MASK) return body.apiKey;

  // Frontend sent empty or masked — look up from stored config
  if (body.type === "llm") {
    // For multi-endpoint LLM, find the specific endpoint by ID
    if (body.endpointId) {
      const raw = getConfig("llm.endpoints");
      if (raw) {
        try {
          const endpoints: Array<{ id: string; apiKey: string }> = JSON.parse(raw);
          const ep = endpoints.find((e) => e.id === body.endpointId);
          if (ep?.apiKey) return ep.apiKey;
        } catch {
          // Fall through to legacy
        }
      }
    }
    return getConfig("llm.apiKey") || "";
  }

  const stored: Record<string, string> = {
    plex: getConfig("plex.token") || "",
    sonarr: getConfig("sonarr.apiKey") || "",
    radarr: getConfig("radarr.apiKey") || "",
    overseerr: getConfig("overseerr.apiKey") || "",
  };
  return stored[body.type] || "";
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session || !session.user.isAdmin) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Admin access required" },
      { status: 403 },
    );
  }

  let body: TestConnectionRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  if (!body.type || !body.url) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "type and url are required" },
      { status: 400 },
    );
  }

  const apiKey = resolveApiKey(body);
  if (!apiKey) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "No API key configured for this service — save your settings first" },
      { status: 400 },
    );
  }

  const result: TestConnectionResponse = await testConnection({ ...body, apiKey });

  return NextResponse.json<ApiResponse<TestConnectionResponse>>({
    success: result.success,
    data: result,
    error: result.success ? undefined : result.message,
  });
}
