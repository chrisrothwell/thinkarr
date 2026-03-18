/**
 * Server-side proxy for Plex user avatar images.
 *
 * Clients request avatars via /api/plex/avatar/{userId}
 * The server fetches the stored avatar URL from the DB and proxies it,
 * optionally including the user's Plex token so Plex.tv auth is handled
 * server-side and the token is never exposed to the browser.
 *
 * Security:
 *   - Requires a valid user session (any authenticated user)
 *   - Only fetches the URL stored in the DB — not an open proxy
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const session = await getSession();
  if (!session) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const { userId } = await params;
  const targetUserId = parseInt(userId, 10);
  if (isNaN(targetUserId)) {
    return new NextResponse("Invalid user ID", { status: 400 });
  }

  const db = getDb();
  const user = db
    .select({ plexAvatarUrl: schema.users.plexAvatarUrl, plexToken: schema.users.plexToken })
    .from(schema.users)
    .where(eq(schema.users.id, targetUserId))
    .get();

  if (!user || !user.plexAvatarUrl) {
    return new NextResponse("No avatar", { status: 404 });
  }

  // Only allow fetching from plex.tv to prevent open-proxy abuse
  let avatarUrl: URL;
  try {
    avatarUrl = new URL(user.plexAvatarUrl);
  } catch {
    return new NextResponse("Invalid avatar URL", { status: 400 });
  }

  if (!avatarUrl.hostname.endsWith("plex.tv") && !avatarUrl.hostname.endsWith("plex.direct")) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  try {
    const headers: Record<string, string> = {
      Accept: "image/*",
      "X-Plex-Product": "Thinkarr",
      "X-Plex-Client-Identifier": "thinkarr",
    };
    if (user.plexToken) {
      headers["X-Plex-Token"] = user.plexToken;
    }

    const res = await fetch(user.plexAvatarUrl, {
      headers,
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      return new NextResponse("Avatar fetch failed", { status: res.status });
    }

    const contentType = res.headers.get("content-type") ?? "image/jpeg";
    const body = await res.arrayBuffer();

    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "private, max-age=3600, stale-while-revalidate=3600",
      },
    });
  } catch {
    return new NextResponse("Failed to fetch avatar", { status: 502 });
  }
}
