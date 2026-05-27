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

type McpPermission = "admin" | "user";

interface AuthResult {
  permission: McpPermission;
  userId?: number;
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
    method?: string;
    tool?: string;
    arguments?: Record<string, unknown> | string;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

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

    // confirm_request: text mode only, handled inline
    if (toolName === "confirm_request") {
      if (!textMode) {
        return NextResponse.json(
          { error: "confirm_request is only available in text mode" },
          { status: 403 },
        );
      }
      if (!auth.userId) {
        return NextResponse.json(
          { error: "User identity required for confirm_request" },
          { status: 403 },
        );
      }

      const args =
        typeof body.arguments === "string"
          ? (JSON.parse(body.arguments) as { pendingKey?: string; selection?: number })
          : (body.arguments as { pendingKey?: string; selection?: number } | undefined) ?? {};

      const { pendingKey, selection } = args;
      if (!pendingKey || typeof selection !== "number") {
        return NextResponse.json({ error: "pendingKey and selection are required" }, { status: 400 });
      }

      const item = resolveBasket(pendingKey, selection, auth.userId);
      if (!item) {
        return NextResponse.json({
          tool: "confirm_request",
          result: { success: false, message: "That selection is no longer valid. Please search again." },
        });
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

      return NextResponse.json({ tool: "confirm_request", result: { ...result, message } });
    }

    // Block direct request tools in text mode — only confirm_request may submit requests
    if (textMode && (toolName === "overseerr_request_movie" || toolName === "overseerr_request_tv")) {
      return NextResponse.json(
        { error: "Use confirm_request in text mode — direct request tools are disabled." },
        { status: 403 },
      );
    }

    if (!canExecuteTool(toolName, auth.permission)) {
      logger.warn("MCP_PERMISSION_DENIED", { tool: toolName, permission: auth.permission, userId: auth.userId });
      return NextResponse.json(
        { error: `Permission denied: ${auth.permission} cannot execute ${toolName}` },
        { status: 403 },
      );
    }

    const args =
      typeof body.arguments === "string"
        ? body.arguments
        : JSON.stringify(body.arguments || {});

    logger.info("MCP_TOOL_EXEC", { tool: toolName, permission: auth.permission, userId: auth.userId });

    try {
      const resultStr = await executeTool(toolName, args);
      const result = JSON.parse(resultStr);

      // In text mode, intercept display_titles and convert to markdown + pending basket
      if (textMode && toolName === "display_titles") {
        const displayTitles: DisplayTitle[] = result?.displayTitles ?? [];
        const { text, requestableItems } = formatDisplayTitlesAsText(displayTitles);

        let pendingKey: string | undefined;
        if (requestableItems.length > 0 && auth.userId != null) {
          pendingKey = createBasket(requestableItems, auth.userId);
        }

        return NextResponse.json({
          tool: toolName,
          result: { text, ...(pendingKey ? { pendingKey } : {}) },
        });
      }

      return NextResponse.json({ tool: toolName, result });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Tool execution failed";
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  }

  return NextResponse.json(
    { error: "Unknown method. Use 'list', 'execute', or provide a 'tool' field." },
    { status: 400 },
  );
}
