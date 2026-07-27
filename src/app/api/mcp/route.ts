import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { getConfig, getUserIdByMcpToken } from "@/lib/config";
import { initializeTools } from "@/lib/tools/init";
import { getOpenAITools, executeTool, hasTools } from "@/lib/tools/registry";
import { getDb, schema } from "@/lib/db";
import { logger } from "@/lib/logger";
import { getClientIp } from "@/lib/auth/rate-limit";
import { eq, and } from "drizzle-orm";
import { formatDisplayTitlesAsText } from "@/lib/tools/display-titles-text";
import { createBasket, resolveBasket } from "@/lib/tools/pending-basket";
import * as overseerr from "@/lib/services/overseerr";
import type { DisplayTitle } from "@/types/titles";
import type OpenAI from "openai";

type McpPermission = "admin" | "user";

interface AuthResult {
  permission: McpPermission;
  userId?: number;
}

type JsonRpcId = string | number | null;

/** Default protocol version echoed back when the client's `initialize` call omits one. */
const MCP_PROTOCOL_VERSION = "2025-06-18";

function jsonRpcResult(id: JsonRpcId, result: unknown) {
  return NextResponse.json({ jsonrpc: "2.0", id, result });
}

function jsonRpcError(id: JsonRpcId, code: number, message: string) {
  return NextResponse.json({ jsonrpc: "2.0", id, error: { code, message } }, { status: 400 });
}

/** Convert internal OpenAI-function-shaped tool defs to the MCP `tools/list` schema. */
function toMcpTools(tools: OpenAI.ChatCompletionTool[]) {
  return tools
    .filter((t) => t.type === "function")
    .map((t) => ({
      name: t.function.name,
      description: t.function.description,
      inputSchema: t.function.parameters,
    }));
}

/**
 * Authenticate an MCP request via Bearer token.
 * Returns the permission level, or null if unauthorized.
 */
function authenticateMcp(request: Request): AuthResult | null {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  const token = authHeader.slice(7);
  const storedToken = getConfig("mcp.bearerToken");

  // Check global admin token (backward compat)
  if (storedToken && token === storedToken) {
    // Admin token — can optionally scope to a user via X-User-Id
    const userIdHeader = request.headers.get("x-user-id");
    if (userIdHeader) {
      const parsedUserId = parseInt(userIdHeader, 10);
      if (!Number.isSafeInteger(parsedUserId) || parsedUserId <= 0 || parsedUserId > 2_147_483_647) {
        return null;
      }
      const db = getDb();
      const user = db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, parsedUserId))
        .get();
      if (user) {
        return { permission: user.isAdmin ? "admin" : "user", userId: user.id };
      }
    }
    return { permission: "admin" };
  }

  // Check per-user tokens — token automatically scopes to that user's permission level
  const userId = getUserIdByMcpToken(token);
  if (userId !== null) {
    const db = getDb();
    const user = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
    if (user) {
      return { permission: user.isAdmin ? "admin" : "user", userId: user.id };
    }
  }

  return null;
}

/**
 * Resolve channel identity headers to a Thinkarr user.
 * Returns the resolved AuthResult on match, "unregistered" if headers present but no mapping,
 * or null if no channel headers (caller should use the base auth result).
 */
function resolveChannelIdentity(
  request: Request,
): AuthResult | "unregistered" | null {
  const channelType = request.headers.get("x-channel-type");
  const channelUserId = request.headers.get("x-channel-user-id");
  if (!channelType || !channelUserId) return null;

  const db = getDb();
  const identity = db
    .select()
    .from(schema.mcpChannelIdentities)
    .where(
      and(
        eq(schema.mcpChannelIdentities.channelType, channelType),
        eq(schema.mcpChannelIdentities.channelUserId, channelUserId),
      ),
    )
    .get();

  if (!identity) {
    // Issue a short-lived registration token and return the link
    const token = randomBytes(16).toString("hex");
    const expiresAt = Math.floor(Date.now() / 1000) + 900; // 15 min
    db.insert(schema.mcpRegistrationTokens)
      .values({ token, channelType, channelUserId, expiresAt })
      .run();
    logger.info("MCP_CHANNEL_UNREGISTERED", { channelType, registrationToken: token });
    return "unregistered";
  }

  const user = db.select().from(schema.users).where(eq(schema.users.id, identity.userId)).get();
  if (!user) return "unregistered";
  return { permission: user.isAdmin ? "admin" : "user", userId: user.id };
}

/**
 * Check if a user has permission to execute a tool.
 * Admin: all tools. User: query-only tools (no delete, no acting on behalf of others).
 */
function canExecuteTool(toolName: string, permission: McpPermission): boolean {
  if (permission === "admin") return true;

  const readOnlyTools = [
    "plex_search_library",
    "plex_get_watch_history",
    "plex_get_on_deck",
    "plex_check_availability",
    "sonarr_search_series",
    "sonarr_get_calendar",
    "sonarr_get_queue",
    "sonarr_list_series",
    "radarr_search_movie",
    "radarr_list_movies",
    "radarr_get_queue",
    "overseerr_search",
    "overseerr_list_requests",
    "display_titles",
  ];

  const userActionTools = [
    "overseerr_request_movie",
    "overseerr_request_tv",
    "sonarr_monitor_series",
    "radarr_monitor_movie",
  ];

  return readOnlyTools.includes(toolName) || userActionTools.includes(toolName);
}

/** Extra tool definition exposed only in text mode. */
const CONFIRM_REQUEST_TOOL = {
  type: "function" as const,
  function: {
    name: "confirm_request",
    description:
      "Submit a media download request that the user has explicitly confirmed. ONLY call this after the user sends a clear positive confirmation (e.g. 'yes', 'request it', 'request #2'). Never call this speculatively.",
    parameters: {
      type: "object",
      properties: {
        pendingKey: {
          type: "string",
          description: "The pendingKey returned by display_titles in this conversation turn.",
        },
        selection: {
          type: "number",
          description: "The 1-based number the user selected from the displayed list.",
        },
      },
      required: ["pendingKey", "selection"],
    },
  },
};

type ToolCallOutcome =
  | { ok: true; payload: unknown }
  | { ok: false; kind: "rejected"; status: number; message: string }
  | { ok: false; kind: "execution_error"; message: string };

/**
 * Shared tool-dispatch logic used by both the legacy ad-hoc method handling
 * and the spec-compliant JSON-RPC `tools/call` handling below, so permission
 * checks, confirm_request, and the text-mode display_titles interception
 * only need to be implemented once.
 */
async function runToolCall(opts: {
  toolName: string;
  rawArguments: Record<string, unknown> | string | undefined;
  auth: AuthResult;
  textMode: boolean;
}): Promise<ToolCallOutcome> {
  const { toolName, rawArguments, auth, textMode } = opts;

  if (toolName === "confirm_request") {
    if (!textMode) {
      return { ok: false, kind: "rejected", status: 403, message: "confirm_request is only available in text mode" };
    }
    if (!auth.userId) {
      return { ok: false, kind: "rejected", status: 403, message: "User identity required for confirm_request" };
    }

    const args =
      typeof rawArguments === "string"
        ? (JSON.parse(rawArguments) as { pendingKey?: string; selection?: number })
        : (rawArguments as { pendingKey?: string; selection?: number } | undefined) ?? {};

    const { pendingKey, selection } = args;
    if (!pendingKey || typeof selection !== "number") {
      return { ok: false, kind: "rejected", status: 400, message: "pendingKey and selection are required" };
    }

    const item = resolveBasket(pendingKey, selection, auth.userId);
    if (!item) {
      return {
        ok: true,
        payload: { success: false, message: "That selection is no longer valid. Please search again." },
      };
    }

    logger.info("MCP_CONFIRM_REQUEST", { userId: auth.userId, title: item.title, mediaType: item.mediaType });

    const result =
      item.mediaType === "movie"
        ? await overseerr.requestMovie(item.overseerrId)
        : await overseerr.requestTv(
            item.overseerrId,
            item.seasonNumber != null ? [item.seasonNumber] : undefined,
          );

    const message = result.success
      ? `✅ *${item.title}* has been requested.`
      : `❌ Could not request *${item.title}*: ${result.message}`;

    return { ok: true, payload: { ...result, message } };
  }

  if (textMode && (toolName === "overseerr_request_movie" || toolName === "overseerr_request_tv")) {
    return {
      ok: false,
      kind: "rejected",
      status: 403,
      message: "Use confirm_request in text mode — direct request tools are disabled.",
    };
  }

  if (!canExecuteTool(toolName, auth.permission)) {
    logger.warn("MCP_PERMISSION_DENIED", { tool: toolName, permission: auth.permission, userId: auth.userId });
    return {
      ok: false,
      kind: "rejected",
      status: 403,
      message: `Permission denied: ${auth.permission} cannot execute ${toolName}`,
    };
  }

  const argsString = typeof rawArguments === "string" ? rawArguments : JSON.stringify(rawArguments || {});

  logger.info("MCP_TOOL_EXEC", { tool: toolName, permission: auth.permission, userId: auth.userId });

  try {
    const resultStr = await executeTool(toolName, argsString);
    const result = JSON.parse(resultStr);

    // In text mode, intercept display_titles and convert to markdown + pending basket
    if (textMode && toolName === "display_titles") {
      const displayTitles: DisplayTitle[] = result?.displayTitles ?? [];
      const { text, requestableItems } = formatDisplayTitlesAsText(displayTitles);

      let pendingKey: string | undefined;
      if (requestableItems.length > 0 && auth.userId != null) {
        pendingKey = createBasket(requestableItems, auth.userId);
      }

      return { ok: true, payload: { text, ...(pendingKey ? { pendingKey } : {}) } };
    }

    return { ok: true, payload: result };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Tool execution failed";
    return { ok: false, kind: "execution_error", message: msg };
  }
}

function buildToolList(permission: McpPermission, textMode: boolean) {
  const allTools = getOpenAITools();
  const filtered =
    permission === "admin"
      ? allTools
      : allTools.filter((t) => t.type === "function" && canExecuteTool(t.function.name, permission));

  if (textMode) {
    return [...filtered, CONFIRM_REQUEST_TOOL];
  }
  return filtered;
}


export async function GET(request: Request) {
  const auth = authenticateMcp(request);
  if (!auth) {
    logger.warn("MCP_AUTH_FAILURE", { ip: getClientIp(request), path: "GET /api/mcp" });
    return NextResponse.json(
      { error: "Unauthorized. Provide a valid Bearer token." },
      { status: 401 },
    );
  }

  initializeTools();

  if (!hasTools()) {
    return NextResponse.json({ tools: [] });
  }

  const { searchParams } = new URL(request.url);
  const textMode = searchParams.get("mode") === "text";
  const tools = buildToolList(auth.permission, textMode);

  return NextResponse.json({ tools });
}

export async function POST(request: Request) {
  const baseAuth = authenticateMcp(request);
  if (!baseAuth) {
    logger.warn("MCP_AUTH_FAILURE", { ip: getClientIp(request), path: "POST /api/mcp" });
    return NextResponse.json(
      { error: "Unauthorized. Provide a valid Bearer token." },
      { status: 401 },
    );
  }

  initializeTools();

  const { searchParams } = new URL(request.url);
  const textMode = searchParams.get("mode") === "text";

  // Resolve channel identity when in text mode
  let auth = baseAuth;
  if (textMode) {
    const resolved = resolveChannelIdentity(request);
    if (resolved === "unregistered") {
      const url = new URL(request.url);
      // Find the token we just inserted so we can return it
      const channelType = request.headers.get("x-channel-type")!;
      const channelUserId = request.headers.get("x-channel-user-id")!;
      const db = getDb();
      const row = db
        .select()
        .from(schema.mcpRegistrationTokens)
        .where(
          and(
            eq(schema.mcpRegistrationTokens.channelType, channelType),
            eq(schema.mcpRegistrationTokens.channelUserId, channelUserId),
          ),
        )
        .orderBy(schema.mcpRegistrationTokens.expiresAt)
        .get();
      const token = row?.token ?? "";
      return NextResponse.json({
        error: "unregistered",
        registrationUrl: `${url.origin}/mcp/link?token=${token}`,
      });
    }
    if (resolved !== null) {
      auth = resolved;
    }
  }

  let body: {
    jsonrpc?: string;
    id?: JsonRpcId;
    method?: string;
    params?: { name?: string; arguments?: Record<string, unknown> | string };
    tool?: string;
    arguments?: Record<string, unknown> | string;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Spec-compliant MCP Streamable HTTP / JSON-RPC 2.0 envelope. Discriminated on the
  // `jsonrpc` field so this doesn't collide with the legacy ad-hoc dispatch below,
  // which existing integrations (OpenClaw text-channel adapter) rely on (#461).
  if (body.jsonrpc === "2.0") {
    const id = body.id ?? null;
    const hasId = Object.prototype.hasOwnProperty.call(body, "id");

    switch (body.method) {
      case "initialize": {
        const initParams = (body.params as { protocolVersion?: string } | undefined) ?? {};
        return jsonRpcResult(id, {
          protocolVersion: initParams.protocolVersion ?? MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "thinkarr", version: process.env.NEXT_PUBLIC_APP_VERSION ?? "unknown" },
        });
      }

      case "notifications/initialized":
        // JSON-RPC notifications receive no response body.
        return new NextResponse(null, { status: 202 });

      case "tools/list": {
        const tools = buildToolList(auth.permission, textMode);
        return jsonRpcResult(id, { tools: toMcpTools(tools) });
      }

      case "tools/call": {
        const toolName = body.params?.name ?? "";
        if (!toolName) {
          return jsonRpcError(id, -32602, "params.name is required");
        }

        const outcome = await runToolCall({
          toolName,
          rawArguments: body.params?.arguments,
          auth,
          textMode,
        });

        if (!outcome.ok) {
          if (outcome.kind === "rejected") {
            return jsonRpcError(id, -32602, outcome.message);
          }
          // Tool execution failed — surfaced as a tool result error per MCP spec,
          // not a JSON-RPC protocol error, so the caller can see and react to it.
          return jsonRpcResult(id, { content: [{ type: "text", text: outcome.message }], isError: true });
        }

        return jsonRpcResult(id, { content: [{ type: "text", text: JSON.stringify(outcome.payload) }] });
      }

      default:
        if (!hasId) {
          // Unrecognized notification — no response per JSON-RPC spec.
          return new NextResponse(null, { status: 202 });
        }
        return jsonRpcError(id, -32601, `Method not found: ${body.method}`);
    }
  }

  // Legacy ad-hoc dispatch (no `jsonrpc` envelope) — kept for backward compatibility
  // with existing integrations that predate the JSON-RPC handling above.

  // Handle "list" method
  if (body.method === "list" || body.method === "tools/list") {
    const tools = buildToolList(auth.permission, textMode);
    return NextResponse.json({ tools });
  }

  // Handle tool execution
  if (body.method === "execute" || body.method === "tools/call" || body.tool) {
    const toolName = body.tool || "";
    if (!toolName) {
      return NextResponse.json({ error: "tool name is required" }, { status: 400 });
    }

    const outcome = await runToolCall({ toolName, rawArguments: body.arguments, auth, textMode });
    if (!outcome.ok) {
      const status = outcome.kind === "execution_error" ? 500 : outcome.status;
      return NextResponse.json({ error: outcome.message }, { status });
    }

    return NextResponse.json({ tool: toolName, result: outcome.payload });
  }

  return NextResponse.json(
    { error: "Unknown method. Use 'list', 'execute', or provide a 'tool' field." },
    { status: 400 },
  );
}
