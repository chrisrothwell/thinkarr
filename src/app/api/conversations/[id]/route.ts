import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getDb, schema } from "@/lib/db";
import { eq, and, asc } from "drizzle-orm";
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

  const { id } = await params;
  const db = getDb();

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

  return NextResponse.json<ApiResponse>({
    success: true,
    data: { ...conversation, messages },
  });
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

  const { id } = await params;
  const db = getDb();

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
}
