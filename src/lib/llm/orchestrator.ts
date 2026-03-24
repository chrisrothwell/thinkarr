import { v4 as uuidv4 } from "uuid";
import { getLlmClient, getLlmModel, getLlmClientForEndpoint } from "./client";
import { buildSystemPrompt } from "./system-prompt";
import { getDb, schema } from "@/lib/db";
import { eq, asc } from "drizzle-orm";
import { initializeTools } from "@/lib/tools/init";
import { getOpenAITools, executeTool, hasTools, getToolLlmContent } from "@/lib/tools/registry";
import { logger } from "@/lib/logger";
import type {
  TextDeltaEvent,
  ToolCallStartEvent,
  ToolResultEvent,
  ErrorEvent,
  DoneEvent,
} from "@/types/chat";
import type OpenAI from "openai";

export type OrchestratorEvent =
  | TextDeltaEvent
  | ToolCallStartEvent
  | ToolResultEvent
  | ErrorEvent
  | DoneEvent;

interface OrchestratorParams {
  conversationId: string;
  userMessage: string;
  modelId?: string;
}

type ChatMessage = OpenAI.ChatCompletionMessageParam;

const MAX_TOOL_ROUNDS = 5;

/** Load conversation history from DB, formatted for the OpenAI API. */
function loadHistory(conversationId: string): ChatMessage[] {
  const db = getDb();
  const rows = db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.conversationId, conversationId))
    .orderBy(asc(schema.messages.createdAt))
    .all();

  const messages: ChatMessage[] = [];

  for (const row of rows) {
    if (row.role === "user" || row.role === "system") {
      if (row.content) {
        messages.push({ role: row.role, content: row.content });
      }
    } else if (row.role === "assistant") {
      const msg: OpenAI.ChatCompletionAssistantMessageParam = { role: "assistant" };
      if (row.content) msg.content = row.content;
      if (row.toolCalls) {
        try {
          msg.tool_calls = JSON.parse(row.toolCalls);
        } catch {
          // Skip malformed tool calls
        }
      }
      messages.push(msg);
    } else if (row.role === "tool") {
      if (row.toolCallId && row.content) {
        messages.push({
          role: "tool",
          tool_call_id: row.toolCallId,
          // Use the compact LLM summary if the tool defines one, so large
          // tool results (e.g. display_titles) don't bloat the context window.
          content: row.toolName
            ? getToolLlmContent(row.toolName, row.content)
            : row.content,
        });
      }
    }
  }

  // Repair orphaned tool calls: if the server crashed between saving the
  // assistant message (with tool_calls) and saving the tool results, the
  // conversation will have an unmatched tool_call_id. Every subsequent LLM
  // request fails with HTTP 400. Inject a synthetic error result for each
  // orphaned call so the sequence is valid and the LLM can recover.
  const seenToolResultIds = new Set<string>(
    messages
      .filter((m): m is OpenAI.ChatCompletionToolMessageParam => m.role === "tool")
      .map((m) => m.tool_call_id),
  );

  const repaired: ChatMessage[] = [];
  for (const msg of messages) {
    repaired.push(msg);
    if (msg.role === "assistant" && "tool_calls" in msg && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (!seenToolResultIds.has(tc.id)) {
          repaired.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({ error: "Tool call did not complete. Please try again." }),
          });
          seenToolResultIds.add(tc.id);
          logger.warn("Repaired orphaned tool call in conversation history", {
            conversationId,
            toolCallId: tc.id,
            toolName: "function" in tc ? (tc as { function?: { name?: string } }).function?.name : undefined,
          });
        }
      }
    }
  }

  return repaired;
}

/** Save a message to the DB. */
function saveMessage(
  conversationId: string,
  role: "user" | "assistant" | "tool",
  content: string | null,
  extra?: { toolCalls?: string; toolCallId?: string; toolName?: string; durationMs?: number },
): string {
  const db = getDb();
  const id = uuidv4();
  db.insert(schema.messages)
    .values({
      id,
      conversationId,
      role,
      content,
      toolCalls: extra?.toolCalls ?? null,
      toolCallId: extra?.toolCallId ?? null,
      toolName: extra?.toolName ?? null,
      durationMs: extra?.durationMs ?? null,
    })
    .run();

  db.update(schema.conversations)
    .set({ updatedAt: new Date() })
    .where(eq(schema.conversations.id, conversationId))
    .run();

  return id;
}

/**
 * Chat orchestrator: streams LLM response with tool call support.
 * Yields SSE-compatible events.
 */
export async function* orchestrate(
  params: OrchestratorParams,
): AsyncGenerator<OrchestratorEvent> {
  const { conversationId, userMessage } = params;

  // Ensure tools are registered
  initializeTools();

  // 1. Save user message
  saveMessage(conversationId, "user", userMessage);

  // 2. Build messages array
  // Resolve client and model — use override if provided
  let client;
  let model;
  let endpointSystemPrompt: string | undefined;
  if (params.modelId) {
    const resolved = getLlmClientForEndpoint(params.modelId);
    client = resolved.client;
    model = resolved.model;
    endpointSystemPrompt = resolved.systemPrompt;
  } else {
    client = getLlmClient();
    model = getLlmModel();
  }

  const systemPrompt = buildSystemPrompt(endpointSystemPrompt);
  const history = loadHistory(conversationId);
  const apiMessages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...history,
  ];
  const tools = hasTools() ? getOpenAITools() : undefined;

  // 3. Tool call loop
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let fullContent = "";
    const toolCalls: { id: string; function: { name: string; arguments: string } }[] = [];
    let llmDurationMs: number | undefined;
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    let totalTokens: number | undefined;

    try {
      const llmStart = Date.now();
      const stream = await client.chat.completions.create({
        model,
        messages: apiMessages,
        stream: true,
        stream_options: { include_usage: true },
        ...(tools && tools.length > 0 ? { tools } : {}),
      });

      // Accumulate streaming chunks
      const toolCallDeltas: Map<number, { id: string; name: string; args: string }> = new Map();

      for await (const chunk of stream) {
        // Token usage is sent in the final chunk
        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens;
          completionTokens = chunk.usage.completion_tokens;
          totalTokens = chunk.usage.total_tokens;
        }

        const choice = chunk.choices[0];
        if (!choice) continue;

        const delta = choice.delta;

        // Text content
        if (delta?.content) {
          fullContent += delta.content;
          yield { type: "text_delta", content: delta.content };
        }

        // Tool call deltas
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (!toolCallDeltas.has(idx)) {
              toolCallDeltas.set(idx, { id: tc.id || "", name: "", args: "" });
            }
            const entry = toolCallDeltas.get(idx)!;
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name += tc.function.name;
            if (tc.function?.arguments) entry.args += tc.function.arguments;
          }
        }
      }

      llmDurationMs = Date.now() - llmStart;

      // Collect completed tool calls
      for (const [, tc] of toolCallDeltas) {
        if (tc.id && tc.name) {
          toolCalls.push({
            id: tc.id,
            function: { name: tc.name, arguments: tc.args },
          });
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "LLM request failed";
      logger.error("LLM request failed", { conversationId, error: msg });
      yield { type: "error", message: msg };
      return;
    }

    // If no tool calls, save the final assistant message and we're done
    if (toolCalls.length === 0) {
      const messageId = saveMessage(conversationId, "assistant", fullContent);
      logger.info("LLM response complete", {
        conversationId,
        llmDurationMs,
        promptTokens,
        completionTokens,
        totalTokens,
      });
      yield { type: "done", messageId, llmDurationMs, promptTokens, completionTokens, totalTokens };
      return;
    }

    logger.info("LLM tool round complete", {
      conversationId,
      round,
      llmDurationMs,
      promptTokens,
      completionTokens,
      totalTokens,
      toolCallCount: toolCalls.length,
    });

    // Save assistant message with tool calls (may have partial content too)
    const serializedToolCalls = JSON.stringify(
      toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: tc.function,
      })),
    );
    saveMessage(conversationId, "assistant", fullContent || null, {
      toolCalls: serializedToolCalls,
    });

    // Add assistant message to conversation for next round
    apiMessages.push({
      role: "assistant",
      content: fullContent || null,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: tc.function,
      })),
    });

    // 4. Execute each tool call
    const TOOL_TIMEOUT_MS = 30_000;
    for (const tc of toolCalls) {
      logger.info("Tool call", { conversationId, toolName: tc.function.name, toolCallId: tc.id });
      const startedAt = Date.now();
      yield {
        type: "tool_call_start",
        toolCallId: tc.id,
        toolName: tc.function.name,
        arguments: tc.function.arguments,
        startedAt,
      };

      let result: string;
      let isError = false;
      try {
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Tool call timed out after ${TOOL_TIMEOUT_MS / 1000}s`)), TOOL_TIMEOUT_MS),
        );
        result = await Promise.race([
          executeTool(tc.function.name, tc.function.arguments),
          timeoutPromise,
        ]);
      } catch (e: unknown) {
        isError = true;
        const timedOut = e instanceof Error && e.message.startsWith("Tool call timed out");
        result = JSON.stringify({ error: e instanceof Error ? e.message : "Tool execution failed" });
        logger.warn("Tool call error", { conversationId, toolName: tc.function.name, toolCallId: tc.id, error: result, timedOut, durationMs: Date.now() - startedAt });
      }

      const durationMs = Date.now() - startedAt;

      // Save tool result to DB (even on error — ensures the API message sequence stays valid)
      logger.info("Saving tool result", { conversationId, toolCallId: tc.id, toolName: tc.function.name, durationMs, isError });
      try {
        saveMessage(conversationId, "tool", result, {
          toolCallId: tc.id,
          toolName: tc.function.name,
          durationMs,
        });
        logger.info("Tool result saved", { conversationId, toolCallId: tc.id, toolName: tc.function.name });
      } catch (e: unknown) {
        logger.error("Failed to save tool result — conversation will be broken", {
          conversationId,
          toolCallId: tc.id,
          toolName: tc.function.name,
          error: e instanceof Error ? e.message : "Unknown error",
        });
      }

      // Add to conversation for next round — the LLM needs a tool message for every tool_calls entry.
      // Use the compact LLM summary so large tool results don't bloat the context window.
      apiMessages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: getToolLlmContent(tc.function.name, result),
      });

      yield {
        type: "tool_result",
        toolCallId: tc.id,
        toolName: tc.function.name,
        result,
        durationMs,
        error: isError,
      };
    }

    // Loop continues — LLM will see tool results and either respond or call more tools
  }

  // Safety: if we exhausted max rounds, yield what we have
  yield { type: "error", message: "Tool call limit reached" };
}

/**
 * Generate a short title for a conversation from the first user message.
 * Returns the generated title, or null if generation fails.
 */
export async function generateTitle(
  conversationId: string,
  firstUserMessage: string,
): Promise<string | null> {
  try {
    const client = getLlmClient();
    const model = getLlmModel();

    const response = await client.chat.completions.create({
      model,
      messages: [
        {
          role: "system",
          content:
            "Generate a very short summary (3-6 words, no quotes) summarizing this chat message. Most conversations will be about TV and Movies and/or their avaialability in a Media Library so assume this is the case.  If the chat was about a specific title, reply with ONLY the title and the year e.g. Ghostbusters (1984), nothing else.  If the chat as about multiple titles or something else, reply with ONLY the short summary, nothing else.",
        },
        { role: "user", content: firstUserMessage },
      ],
      max_tokens: 20,
    });

    const title = response.choices[0]?.message?.content?.trim();
    if (title) {
      const db = getDb();
      db.update(schema.conversations)
        .set({ title, updatedAt: new Date() })
        .where(eq(schema.conversations.id, conversationId))
        .run();
      return title;
    }
  } catch {
    // Title generation is best-effort
  }
  return null;
}
