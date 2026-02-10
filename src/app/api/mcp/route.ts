import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { initializeTools } from "@/lib/tools/init";
import { getOpenAITools, executeTool, hasTools } from "@/lib/tools/registry";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";

type McpPermission = "admin" | "user";

/**
 * Authenticate an MCP request via Bearer token.
 * Returns the permission level, or null if unauthorized.
 */
function authenticateMcp(request: Request): { permission: McpPermission; userId?: number } | null {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  const token = authHeader.slice(7);
  const storedToken = getConfig("mcp.bearerToken");

  if (!storedToken || token !== storedToken) return null;

  // Check for X-User-Id header for user-scoped operations
  const userIdHeader = request.headers.get("x-user-id");
  if (userIdHeader) {
    const db = getDb();
    const user = db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, parseInt(userIdHeader, 10)))
      .get();
    if (user) {
      return {
        permission: user.isAdmin ? "admin" : "user",
        userId: user.id,
      };
    }
  }

  // No user context — treat as admin (bearer token is admin-level)
  return { permission: "admin" };
}

/**
 * Check if a user has permission to execute a tool.
 * Admin: all tools. User: query-only tools (no delete, no acting on behalf of others).
 */
function canExecuteTool(toolName: string, permission: McpPermission): boolean {
  if (permission === "admin") return true;

  // Users can use all query/read tools
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

  // Users can also request content on their own behalf
  const userActionTools = [
    "overseerr_request_movie",
    "overseerr_request_tv",
    "sonarr_monitor_series",
    "radarr_monitor_movie",
  ];

  return readOnlyTools.includes(toolName) || userActionTools.includes(toolName);
}

/**
 * MCP endpoint — supports both tool listing and tool execution.
 *
 * GET  /api/mcp          → List available tools (OpenAI function format)
 * POST /api/mcp          → Execute a tool (JSON-RPC style)
 * POST /api/mcp (list)   → List tools via POST
 */
export async function GET(request: Request) {
  const auth = authenticateMcp(request);
  if (!auth) {
    return NextResponse.json(
      { error: "Unauthorized. Provide a valid Bearer token." },
      { status: 401 },
    );
  }

  initializeTools();

  if (!hasTools()) {
    return NextResponse.json({ tools: [] });
  }

  const allTools = getOpenAITools();

  // Filter based on permission
  const tools = auth.permission === "admin"
    ? allTools
    : allTools.filter((t) => t.type === "function" && canExecuteTool(t.function.name, auth.permission));

  return NextResponse.json({ tools });
}

export async function POST(request: Request) {
  const auth = authenticateMcp(request);
  if (!auth) {
    return NextResponse.json(
      { error: "Unauthorized. Provide a valid Bearer token." },
      { status: 401 },
    );
  }

  initializeTools();

  let body: {
    method?: string;
    tool?: string;
    arguments?: Record<string, unknown> | string;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  // Handle "list" method
  if (body.method === "list" || body.method === "tools/list") {
    const allTools = getOpenAITools();
    const tools = auth.permission === "admin"
      ? allTools
      : allTools.filter((t) => t.type === "function" && canExecuteTool(t.function.name, auth.permission));
    return NextResponse.json({ tools });
  }

  // Handle tool execution
  if (body.method === "execute" || body.method === "tools/call" || body.tool) {
    const toolName = body.tool || "";
    if (!toolName) {
      return NextResponse.json(
        { error: "tool name is required" },
        { status: 400 },
      );
    }

    // Permission check
    if (!canExecuteTool(toolName, auth.permission)) {
      return NextResponse.json(
        { error: `Permission denied: ${auth.permission} cannot execute ${toolName}` },
        { status: 403 },
      );
    }

    const args = typeof body.arguments === "string"
      ? body.arguments
      : JSON.stringify(body.arguments || {});

    try {
      const result = await executeTool(toolName, args);
      return NextResponse.json({
        tool: toolName,
        result: JSON.parse(result),
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Tool execution failed";
      return NextResponse.json(
        { error: msg },
        { status: 500 },
      );
    }
  }

  return NextResponse.json(
    { error: "Unknown method. Use 'list', 'execute', or provide a 'tool' field." },
    { status: 400 },
  );
}
