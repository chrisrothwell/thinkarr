import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { getClientIp } from "@/lib/auth/rate-limit";
import type { ServiceMcpContext } from "@/lib/mcp/auth-context";
import { authenticateServiceMcpToken, isServiceMcpToken, recordServiceMcpDenial } from "@/lib/mcp/service-principals";
import { handleServiceLinkPost } from "@/lib/mcp/link-dispatch";
import { createMcpRequestTiming, type McpRequestTiming } from "@/lib/mcp/request-timing";

/** External MCP is exclusively for registered, signed service integrations.
 * Legacy administrator/user tokens and unsigned identity headers grant no access.
 * The web app's in-process tool registry is independent of this endpoint.
 */
function authenticateMcp(request: Request): ServiceMcpContext | null {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice(7);
  return isServiceMcpToken(token) ? authenticateServiceMcpToken(token) : null;
}

function unauthorized(request: Request) {
  logger.warn("MCP_AUTH_FAILURE", { ip: getClientIp(request), path: `${request.method} /api/mcp` });
  return NextResponse.json(
    { error: "Unauthorized. A registered service credential is required." },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
}

function denied(auth: ServiceMcpContext) {
  recordServiceMcpDenial(auth);
  return NextResponse.json(
    { error: "MCP requires an enabled service integration and signed POST requests." },
    { status: 403, headers: { "Cache-Control": "no-store" } },
  );
}

// Discovery is a signed JSON-RPC POST too; GET never exposes a generic catalog.
export async function GET(request: Request) {
  const auth = authenticateMcp(request);
  return auth ? denied(auth) : unauthorized(request);
}

export async function POST(request: Request) {
  const bearer = request.headers.get("authorization");
  const timing = (bearer?.startsWith("Bearer ") && isServiceMcpToken(bearer.slice(7))) || request.headers.has("Thinkarr-Delegation")
    ? createMcpRequestTiming(request) : undefined;
  try {
    const response = await handleMcpPost(request, timing);
    return timing ? timing.finish(response) : response;
  } catch (error) { timing?.fail(); throw error; }
}

async function handleMcpPost(request: Request, timing?: McpRequestTiming) {
  const auth = timing ? timing.spanSync("authentication", () => authenticateMcp(request)) : authenticateMcp(request);
  if (!auth) return unauthorized(request);
  if (!auth.enabled) return denied(auth);
  // Verifies the signature, instance audience, current key/policy and replay
  // binding for every exchange, including initialize, discovery and execution.
  return handleServiceLinkPost(request, auth, timing);
}
