import { NextResponse } from "next/server";
import { getDelegationAudience } from "@/lib/mcp/delegation";

export const dynamic = "force-dynamic";

/** Public connection metadata; independent of user login and credential issuance. */
export function GET() {
  try {
    return NextResponse.json({ version: 1, audience: getDelegationAudience() }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "MCP connection information is unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
