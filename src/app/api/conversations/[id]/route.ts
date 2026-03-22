import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getDb, schema } from "@/lib/db";
import { eq, and, asc } from "drizzle-orm";
import { checkUserApiRateLimit } from "@/lib/security/api-rate-limit";
import { logger } from "@/lib/logger";
import type { ApiResponse } from "@/types/api";

export async function GET(
  _request: Request,
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
  const db = getDb();

  try {
    // Admin can view any conversation; regular users can only view their own
    let conversation;
    if (session.user.isAdmin) {
      conversation = db
        .select()
        .from(schema.conversations)
        .where(eq(schema.conversations.id, id))
        .get();
    } else {
      conversation = db
        .select()
        .from(schema.conversations)
        .where(and(eq(schema.conversations.id, id), eq(schema.conversations.userId, session.user.id)))
        .get();
    }

    if (!conversation) {
      return NextResponse.json<ApiResponse>(
        { success: false, error: "Conversation not found" },
        { status: 404 },
      );
    }

    const messages = db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, id))
      .orderBy(asc(schema.messages.createdAt))
      .all();

    logger.info("Conversation messages loaded", { conversationId: id, userId: session.user.id, messageCount: messages.length });
    return NextResponse.json<ApiResponse>({
      success: true,
      data: { ...conversation, messages },
    });
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : "Database error";
    logger.error("Failed to load conversation messages", { conversationId: id, userId: session.user.id, error });
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Failed to load messages" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: Request,
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
  const db = getDb();

  try {
    // Verify ownership
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

    db.delete(schema.conversations).where(eq(schema.conversations.id, id)).run();

    return NextResponse.json<ApiResponse>({ success: true });
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : "Database error";
    logger.error("Failed to delete conversation", { conversationId: id, userId: session.user.id, error });
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Failed to delete conversation" },
      { status: 500 },
    );
  }
}
