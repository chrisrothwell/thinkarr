import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { hasSessionCookie } from "@/lib/auth/session";

export function middleware(request: NextRequest) {
  // Defence-in-depth: block the header used in CVE-2025-29927 style middleware
  // bypass attacks. Next.js uses this header internally for subrequests — it
  // must never arrive from an external client.
  if (request.headers.get("x-middleware-subrequest")) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }

  const { pathname } = request.nextUrl;

  // UX-only redirect: send unauthenticated browsers to the login page.
  // This is NOT the auth gate — every API route calls getSession() directly.
  // API routes are excluded from this matcher so they self-authenticate and
  // return proper 401/403 JSON rather than an HTML redirect.
  if (!hasSessionCookie(request.headers.get("cookie"))) {
    if (pathname.startsWith("/chat") || pathname.startsWith("/settings")) {
      return NextResponse.redirect(new URL("/login", request.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  // Exclude Next.js internals, static assets, and all API routes.
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|api/).*)" ],
};
