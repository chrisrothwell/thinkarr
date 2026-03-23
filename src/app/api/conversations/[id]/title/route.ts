import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getDb, schema } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { checkUserApiRateLimit } from "@/lib/security/api-rate-limit";
import { logger } from "@/lib/logger";
import type { ApiResponse } from "@/types/api";

const TITLE_MAX_LENGTH = 200;

export async function PATCH(
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

  let body: { title: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  if (!body.title) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "title is required" },
      { status: 400 },
    );
  }

  if (body.title.length > TITLE_MAX_LENGTH) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: `title must not exceed ${TITLE_MAX_LENGTH} characters` },
      { status: 400 },
    );
  }

  const db = getDb();

  try {
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

    db.update(schema.conversations)
      .set({ title: body.title, updatedAt: new Date() })
      .where(eq(schema.conversations.id, id))
      .run();
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : "Database error";
    logger.error("Failed to update conversation title", { conversationId: id, userId: session.user.id, error });
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Failed to update title" },
      { status: 500 },
    );
  }

  logger.info("Conversation title updated", { conversationId: id, userId: session.user.id });
  return NextResponse.json<ApiResponse>({ success: true });
}
