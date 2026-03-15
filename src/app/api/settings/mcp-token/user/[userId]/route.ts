import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { getSession } from "@/lib/auth/session";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { getUserMcpToken, setUserMcpToken } from "@/lib/config";
import type { ApiResponse } from "@/types/api";

async function resolveTargetUser(userId: number) {
  const db = getDb();
  return db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
}

/** GET — return the per-user MCP token (auto-generate if missing). Admin only. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const session = await getSession();
  if (!session || !session.user.isAdmin) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Admin access required" },
      { status: 403 },
    );
  }

  const { userId: userIdStr } = await params;
  const userId = parseInt(userIdStr, 10);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    return NextResponse.json<ApiResponse>({ success: false, error: "Invalid userId" }, { status: 400 });
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

/** POST — regenerate the per-user MCP token. Admin only. */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const session = await getSession();
  if (!session || !session.user.isAdmin) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Admin access required" },
      { status: 403 },
    );
  }

  const { userId: userIdStr } = await params;
  const userId = parseInt(userIdStr, 10);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    return NextResponse.json<ApiResponse>({ success: false, error: "Invalid userId" }, { status: 400 });
  }

  const user = await resolveTargetUser(userId);
  if (!user) {
    return NextResponse.json<ApiResponse>({ success: false, error: "User not found" }, { status: 404 });
  }

  const token = randomBytes(32).toString("hex");
  setUserMcpToken(userId, token);

  return NextResponse.json<ApiResponse>({ success: true, data: { token } });
}
