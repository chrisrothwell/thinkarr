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
    logger.info("Tool call", { toolName: name, args: parsed });
    const result = await tool.handler(parsed);
    const resultStr = JSON.stringify(result);
    logger.info("Tool result", { toolName: name, result: resultStr.slice(0, 2000) });
    return resultStr;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Tool execution failed";
    logger.error("Tool execution error", { toolName: name, error: msg });
    return JSON.stringify({ error: msg });
  }
}

/** Check if any tools are registered. */
export function hasTools(): boolean {
  return tools.size > 0;
}
