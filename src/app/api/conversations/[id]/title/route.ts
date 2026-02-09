import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getDb, schema } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import type { ApiResponse } from "@/types/api";

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

  db.update(schema.conversations)
    .set({ title: body.title, updatedAt: new Date() })
    .where(eq(schema.conversations.id, id))
    .run();

  return NextResponse.json<ApiResponse>({ success: true });
}
