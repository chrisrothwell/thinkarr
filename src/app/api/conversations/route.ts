import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { getSession } from "@/lib/auth/session";
import { getDb, schema } from "@/lib/db";
import { eq, desc } from "drizzle-orm";
import { checkUserApiRateLimit } from "@/lib/security/api-rate-limit";
import type { ApiResponse } from "@/types/api";

const TITLE_MAX_LENGTH = 200;

export async function GET(request: Request) {
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
        ownerAvatarUrl: schema.users.plexAvatarUrl,
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

  if (!checkUserApiRateLimit(session.user.id)) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Too many requests. Please slow down." },
      { status: 429 },
    );
  }

  let body: { title?: string } = {};
  try {
    body = await request.json();
  } catch {
    // No body is fine — use default title
  }

  if (body.title && body.title.length > TITLE_MAX_LENGTH) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: `title must not exceed ${TITLE_MAX_LENGTH} characters` },
      { status: 400 },
    );
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
    data: {
      id,
      userId: session.user.id,
      title: body.title || "New Chat",
      createdAt: now,
      updatedAt: now,
      ownerName: session.user.plexUsername,
      ownerAvatarUrl: session.user.plexAvatarUrl,
    },
  });
}
