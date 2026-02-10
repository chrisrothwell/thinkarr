import { v4 as uuidv4 } from "uuid";
import { getLlmClient, getLlmModel, getLlmClientForEndpoint } from "./client";
import { buildSystemPrompt } from "./system-prompt";
import { getDb, schema } from "@/lib/db";
import { eq, asc } from "drizzle-orm";
import { initializeTools } from "@/lib/tools/init";
import { getOpenAITools, executeTool, hasTools } from "@/lib/tools/registry";
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
          content: row.content,
        });
      }
    }
  }

  return messages;
}

/** Save a message to the DB. */
function saveMessage(
  conversationId: string,
  role: "user" | "assistant" | "tool",
  content: string | null,
  extra?: { toolCalls?: string; toolCallId?: string; toolName?: string },
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
  const systemPrompt = buildSystemPrompt();
  const history = loadHistory(conversationId);
  const apiMessages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...history,
  ];

  // Resolve client and model — use override if provided
  let client;
  let model;
  if (params.modelId) {
    const resolved = getLlmClientForEndpoint(params.modelId);
    client = resolved.client;
    model = resolved.model;
  } else {
    client = getLlmClient();
    model = getLlmModel();
  }
  const tools = hasTools() ? getOpenAITools() : undefined;

  // 3. Tool call loop
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let fullContent = "";
    const toolCalls: { id: string; function: { name: string; arguments: string } }[] = [];

    try {
      const stream = await client.chat.completions.create({
        model,
        messages: apiMessages,
        stream: true,
        ...(tools && tools.length > 0 ? { tools } : {}),
      });

      // Accumulate streaming chunks
      const toolCallDeltas: Map<number, { id: string; name: string; args: string }> = new Map();

      for await (const chunk of stream) {
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
      yield { type: "error", message: msg };
      return;
    }

    // If no tool calls, save the final assistant message and we're done
    if (toolCalls.length === 0) {
      const messageId = saveMessage(conversationId, "assistant", fullContent);
      yield { type: "done", messageId };
      return;
    }

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
    for (const tc of toolCalls) {
      yield {
        type: "tool_call_start",
        toolCallId: tc.id,
        toolName: tc.function.name,
        arguments: tc.function.arguments,
      };

      const result = await executeTool(tc.function.name, tc.function.arguments);

      // Save tool result to DB
      saveMessage(conversationId, "tool", result, {
        toolCallId: tc.id,
        toolName: tc.function.name,
      });

      // Add to conversation for next round
      apiMessages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: result,
      });

      yield {
        type: "tool_result",
        toolCallId: tc.id,
        toolName: tc.function.name,
        result,
      };
    }

    // Loop continues — LLM will see tool results and either respond or call more tools
  }

  // Safety: if we exhausted max rounds, yield what we have
  yield { type: "error", message: "Tool call limit reached" };
}

/**
 * Generate a short title for a conversation from the first user message.
 * Non-streaming, fire-and-forget.
 */
export async function generateTitle(
  conversationId: string,
  firstUserMessage: string,
): Promise<void> {
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
    }
  } catch {
    // Title generation is best-effort
  }
}
