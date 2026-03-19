/**
 * Server-side proxy for TMDB thumbnail images.
 *
 * Clients request TMDB thumbnails via /api/tmdb/thumb?url=https://image.tmdb.org/...
 * The server fetches the image and streams it back, so the browser loads it as a
 * same-origin resource. This prevents ad-blocker / browser-extension blocking of
 * third-party embedded images and avoids any cross-origin rendering issues.
 *
 * Security:
 *   - Requires a valid user session
 *   - URL is validated to only allow image.tmdb.org hostnames
 *   - Only GET requests are proxied
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";

const ALLOWED_HOSTNAME = "image.tmdb.org";

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const imageUrl = searchParams.get("url");

  if (!imageUrl) {
    return new NextResponse("Missing url parameter", { status: 400 });
  }

  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch {
    return new NextResponse("Invalid URL", { status: 400 });
  }

  if (parsed.protocol !== "https:" || parsed.hostname !== ALLOWED_HOSTNAME) {
    return new NextResponse("URL not allowed", { status: 400 });
  }

  try {
    // Host is pinned to the ALLOWED_HOSTNAME constant; user only controls the path/query.
    // The scheme and host are hardcoded — this is not exploitable SSRF.
    const safeUrl = `https://${ALLOWED_HOSTNAME}${parsed.pathname}${parsed.search}`;
    // lgtm[js/ssrf] — host is the hardcoded ALLOWED_HOSTNAME constant, not user-supplied
    const res = await fetch(safeUrl, { signal: AbortSignal.timeout(10000) }); // lgtm[js/ssrf]

    if (!res.ok) {
      return new NextResponse("Upstream error", { status: res.status });
    }

    const contentType = res.headers.get("content-type") ?? "image/jpeg";
    const body = await res.arrayBuffer();

    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        // Cache for 24 h; TMDB posters rarely change
        "Cache-Control": "private, max-age=86400, stale-while-revalidate=86400",
      },
    });
  } catch {
    return new NextResponse("Failed to fetch image", { status: 502 });
  }
}
