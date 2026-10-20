import { NextResponse } from "next/server";
import { checkAuthRateLimit, getClientIp } from "@/lib/auth/rate-limit";
import { accountLinkApi, accountLinkToken } from "@/lib/mcp/account-link-api";
import { inspectAccountLink } from "@/lib/mcp/account-linking";

export async function POST(request: Request) {
  if (!checkAuthRateLimit(`account-link:${getClientIp(request)}`)) return NextResponse.json({ success: false, error: "Too many attempts" }, { status: 429, headers: { "Cache-Control": "no-store" } });
  return accountLinkApi(async () => inspectAccountLink(await accountLinkToken(request)));
}
