import { NextResponse } from "next/server";
import { getSession, destroySession } from "@/lib/auth/session";
import { logger } from "@/lib/logger";
import type { ApiResponse } from "@/types/api";

export async function GET() {
  const session = await getSession();

  if (!session) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Not authenticated" },
      { status: 401 },
    );
  }

  return NextResponse.json<ApiResponse>({
    success: true,
    data: { user: session.user },
  });
}

export async function DELETE() {
  const session = await getSession();
  if (session) {
    logger.info("User logout", { userId: session.user.id, plexUsername: session.user.plexUsername });
  }
  await destroySession();

  return NextResponse.json<ApiResponse>({ success: true });
}
