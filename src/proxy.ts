import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PUBLIC_PATHS = ["/setup", "/login", "/api/setup", "/api/auth", "/api/mcp", "/api/health"];
const SESSION_COOKIE = "thinkarr_session";

export function proxy(request: NextRequest) {
  // Defence-in-depth: block the header used in CVE-2025-29927 style middleware
  // bypass attacks. Next.js uses this header internally for subrequests — it
  // must never arrive from an external client.
  if (request.headers.get("x-middleware-subrequest")) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }

  const { pathname } = request.nextUrl;

  // Allow public paths
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Allow static assets and Next.js internals
  if (pathname.startsWith("/_next") || pathname.startsWith("/favicon")) {
    return NextResponse.next();
  }

  // Check for session cookie on protected routes
  const hasSession = request.cookies.has(SESSION_COOKIE);
  if (!hasSession) {
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
