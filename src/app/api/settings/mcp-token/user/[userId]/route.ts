import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { getSession } from "@/lib/auth/session";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { getUserMcpToken, setUserMcpToken } from "@/lib/config";
import { logger } from "@/lib/logger";
import type { ApiResponse } from "@/types/api";

async function resolveTargetUser(userId: number) {
  const db = getDb();
  try {
    return db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : "Database error";
    logger.error("Failed to resolve user", { userId, error });
    return null;
  }
}

/** GET — return the per-user MCP token (auto-generate if missing). Admin or the user themselves. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Authentication required" },
      { status: 401 },
    );
  }

  const { userId: userIdStr } = await params;
  const userId = parseInt(userIdStr, 10);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    return NextResponse.json<ApiResponse>({ success: false, error: "Invalid userId" }, { status: 400 });
  }

  // Allow admins to access any user's token; non-admins can only access their own
  if (!session.user.isAdmin && session.user.id !== userId) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Access denied" },
      { status: 403 },
    );
  }

  const user = await resolveTargetUser(userId);
  if (!user) {
    return NextResponse.json<ApiResponse>({ success: false, error: "User not found" }, { status: 404 });
  }

  let token = getUserMcpToken(userId);
  if (!token) {
    token = randomBytes(32).toString("hex");
    setUserMcpToken(userId, token);
  }

  return NextResponse.json<ApiResponse>({ success: true, data: { token } });
}

/** POST — regenerate the per-user MCP token. Admin or the user themselves. */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Authentication required" },
      { status: 401 },
    );
  }

  const { userId: userIdStr } = await params;
  const userId = parseInt(userIdStr, 10);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    return NextResponse.json<ApiResponse>({ success: false, error: "Invalid userId" }, { status: 400 });
  }

  // Allow admins to regenerate any user's token; non-admins can only regenerate their own
  if (!session.user.isAdmin && session.user.id !== userId) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Access denied" },
      { status: 403 },
    );
  }

  const user = await resolveTargetUser(userId);
  if (!user) {
    return NextResponse.json<ApiResponse>({ success: false, error: "User not found" }, { status: 404 });
  }

  const token = randomBytes(32).toString("hex");
  setUserMcpToken(userId, token);

  return NextResponse.json<ApiResponse>({ success: true, data: { token } });
}
