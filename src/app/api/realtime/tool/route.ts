import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { initializeTools } from "@/lib/tools/init";
import { executeTool } from "@/lib/tools/registry";
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

  let body: { toolName?: string; toolArgs?: Record<string, unknown> };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const { toolName, toolArgs } = body;
  if (!toolName) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "toolName is required" },
      { status: 400 },
    );
  }

  initializeTools();

  try {
    const result = await executeTool(toolName, JSON.stringify(toolArgs ?? {}));
    logger.info("REALTIME_TOOL_CALL", { userId: session.user.id, toolName });
    return NextResponse.json<ApiResponse>({
      success: true,
      data: { result },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Tool execution failed";
    logger.error("REALTIME_TOOL_ERROR", { userId: session.user.id, toolName, error: msg });
    return NextResponse.json<ApiResponse>(
      { success: false, error: msg },
      { status: 500 },
    );
  }
}
