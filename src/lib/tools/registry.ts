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

/** Register a tool with name, description, Zod parameter schema, and handler. */
export function defineTool<T extends z.ZodType>(def: {
  name: string;
  description: string;
  schema: T;
  handler: (args: z.infer<T>) => Promise<unknown>;
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

/** Execute a tool by name with the given arguments string (JSON). */
export async function executeTool(
  name: string,
  argsString: string,
): Promise<string> {
  const tool = tools.get(name);
  if (!tool) {
    return JSON.stringify({ error: `Unknown tool: ${name}` });
  }

  try {
    const args = JSON.parse(argsString);
    const parsed = tool.schema.parse(args);
    const result = await tool.handler(parsed);
    return JSON.stringify(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Tool execution failed";
    logger.error("Tool execution error", { toolName: name, error: msg });
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
