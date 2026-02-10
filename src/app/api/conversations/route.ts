import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { getSession } from "@/lib/auth/session";
import { getDb, schema } from "@/lib/db";
import { eq, desc } from "drizzle-orm";
import type { ApiResponse } from "@/types/api";

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Not authenticated" },
      { status: 401 },
    );
  }

  const db = getDb();
  const url = new URL(request.url);
  const viewAll = url.searchParams.get("all") === "true" && session.user.isAdmin;

  if (viewAll) {
    // Admin view: all conversations with owner info
    const rows = db
      .select({
        id: schema.conversations.id,
        userId: schema.conversations.userId,
        title: schema.conversations.title,
        createdAt: schema.conversations.createdAt,
        updatedAt: schema.conversations.updatedAt,
        ownerName: schema.users.plexUsername,
      })
      .from(schema.conversations)
      .leftJoin(schema.users, eq(schema.conversations.userId, schema.users.id))
      .orderBy(desc(schema.conversations.updatedAt))
      .all();

    return NextResponse.json<ApiResponse>({ success: true, data: rows });
  }

  // Regular view: own conversations only
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
