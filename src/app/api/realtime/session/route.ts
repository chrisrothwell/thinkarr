import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getEndpointConfig } from "@/lib/llm/client";
import { buildRealtimeSystemPrompt } from "@/lib/llm/system-prompt";
import { isOpenAIEndpoint } from "@/lib/services/test-connection";
import { initializeTools } from "@/lib/tools/init";
import { getOpenAITools } from "@/lib/tools/registry";
import { checkUserApiRateLimit } from "@/lib/security/api-rate-limit";
import { logger } from "@/lib/logger";
import type { ApiResponse } from "@/types/api";

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Not authenticated" },
      { status: 401 },
    );
  }

  if (!checkUserApiRateLimit(session.user.id)) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Too many requests. Please slow down." },
      { status: 429 },
    );
  }

  let body: { modelId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const modelId = body.modelId || "";
  const ep = getEndpointConfig(modelId);

  if (!ep || !ep.supportsRealtime || !ep.realtimeModel) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "This endpoint does not support the Realtime API" },
      { status: 400 },
    );
  }

  if (!isOpenAIEndpoint(ep.baseUrl)) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Realtime is only supported on OpenAI endpoints (api.openai.com)" },
      { status: 400 },
    );
  }

  // Build tools for the realtime session (exclude display_titles — no visual cards in voice mode)
  initializeTools();
  const allTools = getOpenAITools();
  const realtimeTools = allTools
    .filter((t) => "function" in t && t.function.name !== "display_titles")
    .map((t) => {
      const fn = (t as { type: "function"; function: { name: string; description?: string; parameters?: unknown } }).function;
      return {
        type: "function" as const,
        name: fn.name,
        description: fn.description ?? "",
        parameters: fn.parameters,
      };
    });

  const instructions = buildRealtimeSystemPrompt(ep.realtimeSystemPrompt);

  try {
    const baseUrl = ep.baseUrl.replace(/\/$/, "");
    const res = await fetch(`${baseUrl}/realtime/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ep.apiKey}`,
      },
      body: JSON.stringify({
        model: ep.realtimeModel,
        voice: ep.ttsVoice || "alloy",
        instructions,
        tools: realtimeTools,
        tool_choice: "auto",
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      logger.error("REALTIME_SESSION_ERROR", { userId: session.user.id, status: res.status, body: text });
      return NextResponse.json<ApiResponse>(
        { success: false, error: `Realtime session creation failed: ${res.status}` },
        { status: 502 },
      );
    }

    const data = await res.json();
    const clientSecret: string = data?.client_secret?.value;

    if (!clientSecret) {
      logger.error("REALTIME_SESSION_NO_SECRET", { userId: session.user.id });
      return NextResponse.json<ApiResponse>(
        { success: false, error: "No client secret returned from Realtime API" },
        { status: 502 },
      );
    }

    logger.info("REALTIME_SESSION_CREATED", { userId: session.user.id, model: ep.realtimeModel });

    return NextResponse.json<ApiResponse>({
      success: true,
      data: {
        clientSecret,
        realtimeModel: ep.realtimeModel,
        // The WebRTC SDP exchange URL — derived from baseUrl
        rtcBaseUrl: baseUrl,
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    logger.error("REALTIME_SESSION_ERROR", { userId: session.user.id, error: msg });
    return NextResponse.json<ApiResponse>(
      { success: false, error: msg },
      { status: 500 },
    );
  }
}
