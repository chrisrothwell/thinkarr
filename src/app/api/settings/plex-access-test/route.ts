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

  async function plexGet(label: string, url: string, token: string) {
    try {
      logger.info(`Plex access test: ${label}`, { url });
      const res = await fetch(url, {
        headers: { "X-Plex-Token": token, Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      const status = res.status;
      const text = await res.text();
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { parsed = text; }
      logger.info(`Plex access test: ${label} response`, { status, body: text.slice(0, 1000) });
      return { status, data: parsed };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error(`Plex access test: ${label} failed`, { url, error });
      return { error };
    }
  }

  // 1. /accounts — server-linked user accounts (the correct endpoint for this Plex version)
  results.serverAccounts = await plexGet("serverAccounts", `${baseUrl}/accounts`, adminToken);

  // 2. /home/users — alternative user list endpoint (older Plex versions)
  results.homeUsers = await plexGet("homeUsers", `${baseUrl}/home/users`, adminToken);

  // 3. /library/sections via admin token (baseline — should always work)
  results.adminSections = await plexGet("adminSections", `${baseUrl}/library/sections`, adminToken);

  // 4. If a user token was supplied, test it against /library/sections
  if (body.userToken) {
    const tokenHint = body.userToken.slice(0, 4) + "…";
    const r = await plexGet("userSections", `${baseUrl}/library/sections`, body.userToken);
    results.userSections = { ...r, tokenHint };
  }

  return NextResponse.json<ApiResponse>({ success: true, data: results });
}
