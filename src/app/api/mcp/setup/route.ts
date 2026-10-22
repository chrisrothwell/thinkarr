import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { checkAuthRateLimit, getClientIp } from "@/lib/auth/rate-limit";
import { ConnectionSetupError, redeemConnectionSetup } from "@/lib/mcp/connection-setup";
import { IntegrationError } from "@/lib/mcp/service-principals";

async function setupBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new SyntaxError();
  const parts: Uint8Array[] = []; let length = 0; let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); }, 10_000);
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > 16_384) throw new IntegrationError("Connection setup request is too large", 400);
      parts.push(next.value);
    }
    if (timedOut) throw new SyntaxError();
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } finally { clearTimeout(timeout); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function POST(request: Request) {
  const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
  if (!checkAuthRateLimit(`mcp-setup:${getClientIp(request)}`)) return NextResponse.json({ error: "Too many setup attempts" }, { status: 429, headers });
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer thk_setup_")) return NextResponse.json({ error: "An owner-issued setup code is required" }, { status: 401, headers });
  try {
    return NextResponse.json({ success: true, data: redeemConnectionSetup(auth.slice(7), await setupBody(request)) }, { headers });
  } catch (error) {
    if (error instanceof ConnectionSetupError) return NextResponse.json({ error: error.message }, { status: 401, headers });
    if (error instanceof IntegrationError) return NextResponse.json({ error: error.message }, { status: error.status, headers });
    if (error instanceof ZodError || error instanceof SyntaxError) return NextResponse.json({ error: "Invalid connection setup request" }, { status: 400, headers });
    return NextResponse.json({ error: "Connection setup failed" }, { status: 500, headers });
  }
}
