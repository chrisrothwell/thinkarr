import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { getSession } from "@/lib/auth/session";
import { getDb, schema } from "@/lib/db";
import { initializeTools } from "@/lib/tools/init";
import { executeTool } from "@/lib/tools/registry";
import { checkUserApiRateLimit } from "@/lib/security/api-rate-limit";
import { logger } from "@/lib/logger";
import { eq, and } from "drizzle-orm";
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

  let body: {
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    conversationId?: string;
    callId?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const { toolName, toolArgs, conversationId, callId } = body;
  if (!toolName) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "toolName is required" },
      { status: 400 },
    );
  }

  // Verify the conversation belongs to this user before writing to it
  const db = getDb();
  if (conversationId) {
    const conversation = db
      .select()
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.id, conversationId),
          eq(schema.conversations.userId, session.user.id),
        ),
      )
      .get();

    if (!conversation) {
      return NextResponse.json<ApiResponse>(
        { success: false, error: "Conversation not found" },
        { status: 404 },
      );
    }
  }

  initializeTools();

  const startTime = Date.now();
  try {
    const argsJson = JSON.stringify(toolArgs ?? {});
    const result = await executeTool(toolName, argsJson);
    const durationMs = Date.now() - startTime;

    logger.info("REALTIME_TOOL_CALL", { userId: session.user.id, toolName, conversationId });

    // Persist the tool call and its result so they appear in the main chat
    // window (MessageList reads from DB; display_titles cards render from these rows).
    if (conversationId && callId) {
      const assistantMsgId = uuidv4();
      db.insert(schema.messages)
        .values({
          id: assistantMsgId,
          conversationId,
          role: "assistant",
          content: null,
          toolCalls: JSON.stringify([
            {
              id: callId,
              type: "function",
              function: { name: toolName, arguments: argsJson },
            },
          ]),
          createdAt: new Date(),
        })
        .run();

      db.insert(schema.messages)
        .values({
          id: uuidv4(),
          conversationId,
          role: "tool",
          content: result,
          toolCallId: callId,
          toolName,
          durationMs,
          createdAt: new Date(),
        })
        .run();

      db.update(schema.conversations)
        .set({ updatedAt: new Date() })
        .where(eq(schema.conversations.id, conversationId))
        .run();
    }

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
