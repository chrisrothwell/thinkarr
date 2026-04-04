import { z } from "zod";
import { logger } from "@/lib/logger";
import type OpenAI from "openai";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolHandler = (args: any) => Promise<unknown>;

export interface ToolDefinition {
  name: string;
  description: string;
  schema: z.ZodType;
  handler: ToolHandler;
  /** Optional: produce a compact summary of the result for the LLM context.
   *  When provided, the orchestrator sends this to the LLM instead of the full
   *  result (which may be large). The full result is still saved to DB and
   *  streamed to the frontend. */
  llmSummary?: (result: unknown) => unknown;
}

const tools: Map<string, ToolDefinition> = new Map();

/** Levenshtein distance — used to suggest close tool name matches. */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/** Register a tool with name, description, Zod parameter schema, and handler. */
export function defineTool<T extends z.ZodType>(def: {
  name: string;
  description: string;
  schema: T;
  handler: (args: z.infer<T>) => Promise<unknown>;
  llmSummary?: (result: unknown) => unknown;
}): void {
  tools.set(def.name, def as ToolDefinition);
}

/** Get all registered tools as OpenAI function definitions. */
export function getOpenAITools(): OpenAI.ChatCompletionTool[] {
  return Array.from(tools.values()).map((tool) => {
    const jsonSchema = z.toJSONSchema(tool.schema) as Record<string, unknown>;
    // Remove $schema that OpenAI doesn't want
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { $schema: _schema, ...parameters } = jsonSchema;
    return {
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters,
      },
    };
  });
}

/**
 * Convert PascalCase or camelCase to snake_case.
 * e.g. "DisplayTitlesTitles" → "display_titles_titles"
 */
function toSnakeCase(s: string): string {
  return s
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

/**
 * Try to resolve a (possibly mangled) tool name to a registered tool.
 *
 * Gemini Flash sometimes emits PascalCase names or appends parameter names to
 * the tool name (e.g. "DisplayTitlesTitles" instead of "display_titles").
 * Strategy:
 *   1. Direct lookup — fastest path.
 *   2. Case-insensitive / underscore-stripped exact match — catches minor casing drift.
 *   3. snake_case conversion — "DisplayTitles" → "display_titles".
 *   4. Prefix match after snake_case conversion — "DisplayTitlesTitles" →
 *      "display_titles_titles" starts with registered name "display_titles".
 * Returns [resolvedName, tool] or undefined if no match.
 */
function resolveToolName(name: string): [string, ToolDefinition] | undefined {
  // 1. Direct
  const direct = tools.get(name);
  if (direct) return [name, direct];

  const registered = Array.from(tools.entries());

  // 2. Case-insensitive / stripped
  const stripped = name.replace(/_/g, "").toLowerCase();
  for (const [k, v] of registered) {
    if (k.replace(/_/g, "").toLowerCase() === stripped) return [k, v];
  }

  // 3. snake_case conversion exact match
  const snake = toSnakeCase(name);
  const snakeTool = tools.get(snake);
  if (snakeTool) return [snake, snakeTool];

  // 4. Prefix match: snake_case name starts with a registered tool name
  // e.g. "display_titles_titles" starts with "display_titles"
  // Sort by descending name length to prefer the longest (most specific) match
  const byLength = [...registered].sort((a, b) => b[0].length - a[0].length);
  for (const [k, v] of byLength) {
    if (snake.startsWith(k + "_") || snake === k) return [k, v];
  }

  return undefined;
}

/** Execute a tool by name with the given arguments string (JSON). */
export async function executeTool(
  name: string,
  argsString: string,
): Promise<string> {
  const resolved = resolveToolName(name);
  if (!resolved) {
    // Suggest the closest registered name so the LLM can self-correct on the next round.
    const registered = Array.from(tools.keys());
    const suggestion = registered.find((k) => levenshtein(k, name) <= 2);
    const hint = suggestion ? ` Did you mean "${suggestion}"?` : ` Available tools: ${registered.join(", ")}.`;
    logger.warn("Unknown tool called", { name, suggestion });
    return JSON.stringify({ error: `Unknown tool: "${name}".${hint}` });
  }

  const [resolvedName, tool] = resolved;
  if (resolvedName !== name) {
    logger.warn("Tool name normalized", { original: name, resolved: resolvedName });
  }

  try {
    let args = JSON.parse(argsString);

    // Fix Gemini flat-argument hallucination for display_titles.
    // Gemini sometimes calls display_titles with the contents of a single title
    // object spread at the top level (e.g. { title: "...", seasonNumber: 1 })
    // instead of the correct { titles: [{ title: "...", seasonNumber: 1 }] }.
    if (
      resolvedName === "display_titles" &&
      !Array.isArray(args.titles) &&
      typeof args.title === "string"
    ) {
      logger.warn("display_titles: flat args detected, wrapping into {titles: [...]}", {
        original: name,
      });
      args = { titles: [args] };
    }

    const parsed = tool.schema.parse(args);
    const result = await tool.handler(parsed);
    return JSON.stringify(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Tool execution failed";
    logger.error("Tool execution error", { toolName: resolvedName, error: msg });
    return JSON.stringify({ error: msg });
  }
}

/**
 * Return the content string that should be fed back to the LLM for a given
 * tool result. If the tool defines an llmSummary, that compact form is used;
 * otherwise the full result JSON is returned unchanged.
 */
export function getToolLlmContent(name: string, fullResultJson: string): string {
  const tool = tools.get(name);
  if (!tool?.llmSummary) return fullResultJson;
  try {
    const full = JSON.parse(fullResultJson);
    return JSON.stringify(tool.llmSummary(full));
  } catch {
    return fullResultJson;
  }
}

/** Check if any tools are registered. */
export function hasTools(): boolean {
  return tools.size > 0;
}

/** Get the names of all registered tools. */
export function getRegisteredToolNames(): string[] {
  return Array.from(tools.keys());
}
