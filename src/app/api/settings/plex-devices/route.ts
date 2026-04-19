import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { getPlexDevices } from "@/lib/services/plex-auth";
import type { ApiResponse } from "@/types/api";

export async function GET(): Promise<NextResponse> {
  const session = await getSession();
  if (!session || !session.user.isAdmin) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Admin access required" },
      { status: 403 },
    );
  }

  const db = getDb();
  let user: { plexToken: string | null } | undefined;
  try {
    user = db
      .select({ plexToken: schema.users.plexToken })
      .from(schema.users)
      .where(eq(schema.users.id, session.user.id))
      .get();
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : "Database error";
    logger.error("Failed to fetch user for plex-devices", { userId: session.user.id, error });
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Failed to retrieve user data" },
      { status: 500 },
    );
  }

  if (!user?.plexToken) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "No Plex account linked — log in with Plex first" },
      { status: 400 },
    );
  }

  try {
    const servers = await getPlexDevices(user.plexToken);
    return NextResponse.json<ApiResponse>({ success: true, data: servers });
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : "Unknown error";
    logger.error("Failed to fetch Plex devices", { userId: session.user.id, error });
    return NextResponse.json<ApiResponse>(
      { success: false, error },
      { status: 502 },
    );
  }
}
