/**
 * Server-side proxy for Plex thumbnail images.
 *
 * Clients request thumbnails via /api/plex/thumb?path=/library/metadata/123/thumb/456
 * The server fetches the image from Plex using the stored admin token and streams it
 * back, so the Plex token is never exposed to the browser.
 *
 * Security:
 *   - Requires a valid user session (any authenticated user)
 *   - Path is validated to only allow /library/... Plex metadata paths
 *   - Token is never returned to the client
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getConfig } from "@/lib/config";

/** Only allow Plex library metadata paths to prevent open-proxy abuse. */
const ALLOWED_PATH_RE = /^\/library\/[a-zA-Z0-9/_-]+$/;

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const thumbPath = searchParams.get("path");

  if (!thumbPath || !ALLOWED_PATH_RE.test(thumbPath)) {
    return new NextResponse("Invalid path", { status: 400 });
  }

  const plexUrl = getConfig("plex.url");
  const plexToken = getConfig("plex.token");

  if (!plexUrl || !plexToken) {
    return new NextResponse("Plex not configured", { status: 503 });
  }

  const base = plexUrl.replace(/\/$/, "");
  const targetUrl = `${base}${thumbPath}`;

  try {
    const res = await fetch(targetUrl, {
      headers: { "X-Plex-Token": plexToken },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      return new NextResponse("Plex error", { status: res.status });
    }

    const contentType = res.headers.get("content-type") ?? "image/jpeg";
    const body = await res.arrayBuffer();

    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        // Cache for 24 h; serve stale for another 24 h while revalidating in the background.
        // This prevents broken thumbnails when returning to a tab or switching windows.
        "Cache-Control": "private, max-age=86400, stale-while-revalidate=86400",
      },
    });
  } catch {
    return new NextResponse("Failed to fetch thumbnail", { status: 502 });
  }
}
