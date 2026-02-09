import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { getSession } from "@/lib/auth/session";
import { getDb, schema } from "@/lib/db";
import { eq, desc } from "drizzle-orm";
import type { ApiResponse } from "@/types/api";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Not authenticated" },
      { status: 401 },
    );
  }

  const db = getDb();
  const conversations = db
    .select({
      id: schema.conversations.id,
      title: schema.conversations.title,
      createdAt: schema.conversations.createdAt,
      updatedAt: schema.conversations.updatedAt,
    })
    .from(schema.conversations)
    .where(eq(schema.conversations.userId, session.user.id))
    .orderBy(desc(schema.conversations.updatedAt))
    .all();

  return NextResponse.json<ApiResponse>({ success: true, data: conversations });
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Not authenticated" },
      { status: 401 },
    );
  }

  let body: { title?: string } = {};
  try {
    body = await request.json();
  } catch {
    // No body is fine — use default title
  }

  const db = getDb();
  const id = uuidv4();
  const now = new Date();

  db.insert(schema.conversations)
    .values({
      id,
      userId: session.user.id,
      title: body.title || "New Chat",
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return NextResponse.json<ApiResponse>({
    success: true,
    data: { id, title: body.title || "New Chat", createdAt: now, updatedAt: now },
  });
}
