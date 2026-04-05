import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { getSession } from "@/lib/auth/session";
import { getDb, schema } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { checkUserApiRateLimit } from "@/lib/security/api-rate-limit";
import { generateTitle } from "@/lib/llm/orchestrator";
import { logger } from "@/lib/logger";
import type { ApiResponse } from "@/types/api";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
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

  const { id } = await params;

  let body: { role?: string; content?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Invalid request body" },
      { status: 400 },
    );
  }

  const { role, content } = body;

  if (role !== "user" && role !== "assistant") {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "role must be user or assistant" },
      { status: 400 },
    );
  }

  if (!content || typeof content !== "string" || !content.trim()) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "content is required" },
      { status: 400 },
    );
  }

  const db = getDb();

  const conversation = db
    .select()
    .from(schema.conversations)
    .where(and(eq(schema.conversations.id, id), eq(schema.conversations.userId, session.user.id)))
    .get();

  if (!conversation) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Conversation not found" },
      { status: 404 },
    );
  }

  try {
    const messageId = uuidv4();
    db.insert(schema.messages)
      .values({
        id: messageId,
        conversationId: id,
        role: role as "user" | "assistant",
        content: content.trim(),
        createdAt: new Date(),
      })
      .run();

    logger.info("Realtime message saved", {
      conversationId: id,
      userId: session.user.id,
      role,
      messageId,
    });

    // Generate a title on the first user message (conversation still called "New Chat")
    let newTitle: string | null = null;
    if (role === "user" && conversation.title === "New Chat") {
      newTitle = await generateTitle(id, content.trim());
    }

    return NextResponse.json<ApiResponse>({ success: true, data: { id: messageId, newTitle } });
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : "Database error";
    logger.error("Failed to save realtime message", { conversationId: id, userId: session.user.id, error });
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Failed to save message" },
      { status: 500 },
    );
  }
}
