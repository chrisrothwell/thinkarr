import { NextResponse } from "next/server";

/** Retirement response only: never reads credentials or starts unsigned linking. */
export function legacyMcpAccessRemoved() {
  return NextResponse.json(
    { success: false, error: "Legacy MCP access has been removed. Use a registered service integration and the Thinkarr companion." },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}
