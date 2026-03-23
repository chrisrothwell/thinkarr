/**
 * Unit tests for src/proxy.ts (Next.js 16 middleware)
 *
 * Covers:
 *   - Public paths bypass auth check (no session cookie required)
 *   - /api/health is publicly accessible (required for Docker HEALTHCHECK and CI smoke test)
 *   - Protected paths redirect to /login when no session cookie present
 *   - x-middleware-subrequest header is blocked (CVE-2025-29927 mitigation)
 */

import { describe, it, expect } from "vitest";
import { proxy } from "@/proxy";
import type { NextRequest } from "next/server";

function makeRequest(path: string, opts: { cookie?: string; header?: Record<string, string> } = {}) {
  const url = `http://localhost:3000${path}`;
  const headers = new Headers(opts.header ?? {});
  if (opts.cookie) headers.set("cookie", opts.cookie);
  return {
    nextUrl: new URL(url),
    cookies: { has: (name: string) => !!opts.cookie?.includes(name) },
    headers,
    url,
  } as unknown as NextRequest;
}

describe("proxy middleware", () => {
  it("allows /api/health without a session cookie", () => {
    const res = proxy(makeRequest("/api/health"));
    // NextResponse.next() has no Location header and no redirect status
    expect(res.status).not.toBe(307);
    expect(res.headers.get("location")).toBeNull();
  });

  it.each(["/setup", "/login", "/api/setup", "/api/auth/callback", "/api/mcp"])(
    "allows public path %s without a session cookie",
    (path) => {
      const res = proxy(makeRequest(path));
      expect(res.status).not.toBe(307);
    }
  );

  it("redirects protected path to /login when no session cookie", () => {
    const res = proxy(makeRequest("/"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("allows protected path when session cookie is present", () => {
    const res = proxy(makeRequest("/", { cookie: "thinkarr_session=abc123" }));
    expect(res.status).not.toBe(307);
  });

  it("blocks x-middleware-subrequest header (CVE-2025-29927)", () => {
    const res = proxy(makeRequest("/", { header: { "x-middleware-subrequest": "1" } }));
    expect(res.status).toBe(403);
  });
});
