import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { getSession } from "@/lib/auth/session";
import { checkUserApiRateLimit } from "@/lib/security/api-rate-limit";
import { logger } from "@/lib/logger";
import { IntegrationError } from "./service-principals";
import { AccountLinkError } from "./account-linking";

const headers = { "Cache-Control": "no-store" };

/** Management is web-session/admin-only; an MCP bearer never authorizes it. */
export async function integrationAdminApi(action: (actorUserId: number) => unknown | Promise<unknown>) {
  const session = await getSession();
  if (!session?.user.isAdmin) return NextResponse.json({ success: false, error: "Admin access required" }, { status: 403, headers });
  if (!checkUserApiRateLimit(session.user.id)) return NextResponse.json({ success: false, error: "Too many requests" }, { status: 429, headers });
  try {
    return NextResponse.json({ success: true, data: await action(session.user.id) }, { headers });
  } catch (error) {
    if (error instanceof IntegrationError || error instanceof AccountLinkError) return NextResponse.json({ success: false, error: error.message }, { status: error.status, headers });
    if (error instanceof ZodError || error instanceof SyntaxError) return NextResponse.json({ success: false, error: "Invalid integration request" }, { status: 400, headers });
    // Do not log request bodies, public-key input, tokens or database errors.
    logger.error("MCP_INTEGRATION_API_FAILURE", { actorUserId: session.user.id });
    return NextResponse.json({ success: false, error: "Integration operation failed" }, { status: 500, headers });
  }
}

export async function integrationJson(request: Request): Promise<unknown> {
  const body = await request.text();
  if (Buffer.byteLength(body) > 16384) throw new IntegrationError("Integration request is too large", 400);
  return JSON.parse(body);
}
