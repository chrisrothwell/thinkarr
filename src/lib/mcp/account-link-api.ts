import { NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { getSession, type SessionWithUser } from "@/lib/auth/session";
import { checkUserApiRateLimit } from "@/lib/security/api-rate-limit";
import { logger } from "@/lib/logger";
import { AccountLinkError } from "./account-linking";

const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const tokenSchema = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export function accountLinkBrowserOrigin(request: Request): string {
  return request.headers.get("origin") ?? new URL(request.url).origin;
}
export async function accountLinkToken(request: Request): Promise<string> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new AccountLinkError("Account-link requests require JSON", 400);
  }
  const text = await request.text();
  if (Buffer.byteLength(text) > 2048) throw new AccountLinkError("Invalid account-link request", 400);
  return tokenSchema.parse(JSON.parse(text)).token;
}
export async function accountLinkApi(action: () => unknown | Promise<unknown>) {
  try { return NextResponse.json({ success: true, data: await action() }, { headers }); }
  catch (error) {
    if (error instanceof AccountLinkError) return NextResponse.json({ success: false, error: error.message }, { status: error.status, headers });
    if (error instanceof ZodError || error instanceof SyntaxError) return NextResponse.json({ success: false, error: "Invalid account-link request" }, { status: 400, headers });
    logger.error("MCP_ACCOUNT_LINK_API_FAILURE");
    return NextResponse.json({ success: false, error: "Account-link operation failed" }, { status: 500, headers });
  }
}
export async function accountLinkSessionApi(action: (session: SessionWithUser) => unknown | Promise<unknown>) {
  const session = await getSession();
  if (!session) return NextResponse.json({ success: false, error: "Sign in with Plex first" }, { status: 403, headers });
  if (!checkUserApiRateLimit(session.user.id)) return NextResponse.json({ success: false, error: "Too many requests" }, { status: 429, headers });
  return accountLinkApi(() => action(session));
}
