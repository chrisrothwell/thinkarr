import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getConfig } from "@/lib/config";
import { logger } from "@/lib/logger";
import type { ApiResponse } from "@/types/api";

/**
 * POST /api/settings/plex-access-test
 * Admin-only diagnostic endpoint. Tests Plex library access for a given user token
 * and also queries the server's user list via the admin token for comparison.
 *
 * Body: { userToken?: string }  — omit to test with admin token only
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session?.user.isAdmin) {
    return NextResponse.json<ApiResponse>({ success: false, error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({})) as { userToken?: string };

  const plexUrl = getConfig("plex.url");
  const adminToken = getConfig("plex.token");

  if (!plexUrl || !adminToken) {
    return NextResponse.json<ApiResponse>({ success: false, error: "Plex not configured" }, { status: 400 });
  }

  const baseUrl = plexUrl.replace(/\/$/, "");
  const results: Record<string, unknown> = {};

  // 1. Fetch server users list via admin token
  try {
    const usersUrl = `${baseUrl}/home/users`;
    logger.info("Plex access test: fetching server users", { url: usersUrl });
    const res = await fetch(usersUrl, {
      headers: { "X-Plex-Token": adminToken, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    const status = res.status;
    const text = await res.text();
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    results.serverUsers = { status, data: parsed };
    logger.info("Plex access test: server users response", { status, body: text.slice(0, 1000) });
  } catch (err) {
    results.serverUsers = { error: err instanceof Error ? err.message : String(err) };
    logger.error("Plex access test: server users fetch failed", { error: String(err) });
  }

  // 2. Fetch library sections via admin token (baseline — should always work)
  try {
    const sectionsUrl = `${baseUrl}/library/sections`;
    const res = await fetch(sectionsUrl, {
      headers: { "X-Plex-Token": adminToken, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    const status = res.status;
    const text = await res.text();
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    results.adminSections = { status, data: parsed };
    logger.info("Plex access test: admin sections response", { status, body: text.slice(0, 1000) });
  } catch (err) {
    results.adminSections = { error: err instanceof Error ? err.message : String(err) };
  }

  // 3. If a user token was supplied, test it against /library/sections
  if (body.userToken) {
    const tokenHint = body.userToken.slice(0, 4) + "…";
    try {
      const sectionsUrl = `${baseUrl}/library/sections`;
      const res = await fetch(sectionsUrl, {
        headers: { "X-Plex-Token": body.userToken, Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      const status = res.status;
      const text = await res.text();
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { parsed = text; }
      results.userSections = { status, tokenHint, data: parsed };
      logger.info("Plex access test: user sections response", { status, tokenHint, body: text.slice(0, 1000) });
    } catch (err) {
      results.userSections = { error: err instanceof Error ? err.message : String(err), tokenHint };
    }
  }

  return NextResponse.json<ApiResponse>({ success: true, data: results });
}
