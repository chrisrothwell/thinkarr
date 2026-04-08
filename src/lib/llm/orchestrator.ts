import { v4 as uuidv4 } from "uuid";
import { getLlmClient, getLlmModel, getLlmClientForEndpoint } from "./client";
import { buildSystemPrompt } from "./system-prompt";
import { getDb, schema } from "@/lib/db";
import { eq, asc, inArray } from "drizzle-orm";
import { initializeTools } from "@/lib/tools/init";
import { getOpenAITools, executeTool, hasTools, getToolLlmContent, getRegisteredToolNames } from "@/lib/tools/registry";
import { logger } from "@/lib/logger";
import { startTrace, flushLangfuse } from "./langfuse";
import type { LangfuseTraceClient } from "./langfuse";
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
  userId?: number;
}

type ChatMessage = OpenAI.ChatCompletionMessageParam;

const MAX_TOOL_ROUNDS = 8;
const MAX_EMPTY_RESPONSE_RETRIES = 2;

/**
 * Retry an LLM API call on 429 rate-limit responses with exponential backoff.
 * The OpenAI TPM limit resets on a sliding window — a short wait is usually
 * enough (e.g. the API itself says "retry in 50ms" for brief spikes).
 * Two retries: 1 s then 3 s. On any other error, throws immediately.
 */
async function callWithRateLimitRetry<T>(
  fn: () => Promise<T>,
  conversationId: string,
  round: number,
): Promise<T> {
  const delays = [1000, 3000];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "";
      if (/429|rate.?limit/i.test(msg) && attempt < delays.length) {
        const delayMs = delays[attempt];
        logger.warn("LLM rate limit hit, retrying after delay", {
          conversationId,
          round,
          attempt: attempt + 1,
          delayMs,
        });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      throw e;
    }
  }
  // Unreachable, but TypeScript requires it
  throw new Error("Rate limit retry exhausted");
}

/** Map raw LLM API errors to user-friendly messages. Raw error is preserved in server logs. */
function sanitizeLlmError(raw: string): string {
  if (/429|quota|rate.?limit/i.test(raw)) {
    return "The AI service is temporarily unavailable. Please try again in a moment.";
  }
  if (/401|403|unauthorized|forbidden/i.test(raw)) {
    return "The AI service is not properly configured. Please contact the administrator.";
  }
  return "The AI service encountered an error. Please try again.";
}

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
          const toolCalls = JSON.parse(row.toolCalls) as OpenAI.ChatCompletionMessageToolCall[];
          // Compact display_titles call arguments: strip summary, thumbPath, and cast
          // from each title entry. These are the bulky repeated fields (a 20-season show
          // repeats a 300-char summary 20 times). The tool result (via llmSummary) already
          // confirms which cards were shown, so the full args are not needed in history.
          msg.tool_calls = toolCalls.map((tc) => {
            if (
              tc.type === "function" &&
              tc.function.name === "display_titles" &&
              tc.function.arguments
            ) {
              try {
                const args = JSON.parse(tc.function.arguments) as {
                  titles: Record<string, unknown>[];
                };
                // Strip only decorative fields (summary, cast) — NOT thumbPath.
                // thumbPath is needed so the LLM can reuse the poster URL in
                // follow-up display_titles calls without re-searching.
                // seasonNumber, overseerrId, overseerrMediaType, plexKey and
                // mediaStatus are all preserved so season-specific request and
                // watch buttons remain functional.
                const compacted = {
                  titles: args.titles.map(
                    ({ summary: _s, cast: _c, ...rest }) => rest,
                  ),
                };
                return {
                  ...tc,
                  function: { ...tc.function, arguments: JSON.stringify(compacted) },
                };
              } catch {
                return tc;
              }
            }
            return tc;
          });
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
          const toolName = "function" in tc ? (tc as { function?: { name?: string } }).function?.name : undefined;
          const syntheticContent = JSON.stringify({ error: "Tool call did not complete. Please try again." });
          repaired.push({
            role: "tool",
            tool_call_id: tc.id,
            content: syntheticContent,
          });
          seenToolResultIds.add(tc.id);
          // Persist the synthetic result so subsequent loadHistory calls find it
          // in the DB and don't re-trigger this repair on every request.
          saveMessage(conversationId, "tool", syntheticContent, {
            toolCallId: tc.id,
            toolName,
          });
          logger.warn("Repaired orphaned tool call in conversation history", {
            conversationId,
            toolCallId: tc.id,
            toolName,
            synthetic: true,
          });
        }
      }
    }
  }

  // Collapse consecutive user messages: if a user message is immediately followed
  // by another user message with no assistant response in between, the earlier one
  // is a "ghost" from a prior failed request (the request failed after saving its
  // user message but before saving any assistant response). Skip it from the LLM
  // context so the model never sees invalid consecutive user turns.
  //
  // The ghost message is intentionally kept in the DB — it represents a real
  // request the user made and is shown in the UI as "sent, no reply received".
  // Only the most recent user message in any consecutive run is sent to the LLM.
  const withoutGhosts: ChatMessage[] = [];
  for (let i = 0; i < repaired.length; i++) {
    const msg = repaired[i];
    const next = repaired[i + 1];
    if (msg.role === "user" && next?.role === "user") {
      logger.warn("Skipping ghost user message from prior failed request", {
        conversationId,
      });
      continue;
    }
    withoutGhosts.push(msg);
  }

  return capConversationHistory(trimToolHistory(withoutGhosts, conversationId), conversationId);
}

export const MAX_TOOL_ROUNDS_IN_HISTORY = 5;

/**
 * Maximum number of user + assistant turns kept in conversation history.
 * Older turns are dropped to keep per-request token cost predictable.
 * Tool messages are kept only if their tool_call_id is still referenced
 * by a kept assistant message.
 */
export const MAX_CONVERSATION_TURNS = 20;

/**
 * Slide the history window so at most MAX_CONVERSATION_TURNS user/assistant
 * messages are sent to the LLM per request.
 */
export function capConversationHistory(
  messages: ChatMessage[],
  conversationId: string,
): ChatMessage[] {
  // Count user + assistant messages from the end to find the cutoff index
  let turnCount = 0;
  let cutoffIdx = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const role = (messages[i] as { role: string }).role;
    if (role === "user" || role === "assistant") {
      turnCount++;
      if (turnCount === MAX_CONVERSATION_TURNS) {
        cutoffIdx = i;
        break;
      }
    }
  }

  if (turnCount < MAX_CONVERSATION_TURNS) return messages;

  logger.info("Capping conversation history", {
    conversationId,
    totalTurns: turnCount,
    keptTurns: MAX_CONVERSATION_TURNS,
    droppedMessages: cutoffIdx,
  });

  const kept = messages.slice(cutoffIdx);

  // Collect tool_call IDs referenced by assistant messages in the kept window
  const keptToolCallIds = new Set<string>();
  for (const msg of kept) {
    if (msg.role === "assistant" && "tool_calls" in msg) {
      const aMsg = msg as OpenAI.ChatCompletionAssistantMessageParam;
      for (const tc of aMsg.tool_calls ?? []) keptToolCallIds.add(tc.id);
    }
  }

  // Drop tool messages whose call is no longer in the kept window
  return kept.filter((msg) => {
    if (msg.role !== "tool") return true;
    return keptToolCallIds.has(
      (msg as OpenAI.ChatCompletionToolMessageParam).tool_call_id,
    );
  });
}

/**
 * Cap the number of tool-calling rounds kept in conversation history.
 * For rounds beyond the most recent MAX_TOOL_ROUNDS_IN_HISTORY, the
 * tool result messages are dropped and the assistant message's tool_calls
 * array is replaced with a compact inline note (e.g. "[searched: plex_search_library]").
 * This prevents unbounded token growth in long conversations while keeping
 * all assistant text responses intact.
 */
export function trimToolHistory(messages: ChatMessage[], conversationId: string): ChatMessage[] {
  // Find the index of every assistant message that has tool_calls
  const toolRoundIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "assistant" && "tool_calls" in msg && (msg as OpenAI.ChatCompletionAssistantMessageParam).tool_calls?.length) {
      toolRoundIndices.push(i);
    }
  }

  if (toolRoundIndices.length <= MAX_TOOL_ROUNDS_IN_HISTORY) return messages;

  const dropCount = toolRoundIndices.length - MAX_TOOL_ROUNDS_IN_HISTORY;
  const dropIndices = new Set(toolRoundIndices.slice(0, dropCount));

  // Collect all tool_call_ids that belong to dropped rounds
  const dropToolCallIds = new Set<string>();
  for (const idx of dropIndices) {
    const msg = messages[idx] as OpenAI.ChatCompletionAssistantMessageParam;
    for (const tc of msg.tool_calls ?? []) dropToolCallIds.add(tc.id);
  }

  logger.info("Trimming old tool rounds from history", {
    conversationId,
    totalRounds: toolRoundIndices.length,
    droppingRounds: dropCount,
    keptRounds: MAX_TOOL_ROUNDS_IN_HISTORY,
  });

  return messages
    .filter((msg) => {
      // Drop tool result messages whose call was in a trimmed round
      if (msg.role === "tool") {
        const toolMsg = msg as OpenAI.ChatCompletionToolMessageParam;
        return !dropToolCallIds.has(toolMsg.tool_call_id);
      }
      return true;
    })
    .map((msg) => {
      // For assistant messages in trimmed rounds: replace tool_calls with an inline note
      if (msg.role !== "assistant") return msg;
      const assistantMsg = msg as OpenAI.ChatCompletionAssistantMessageParam;
      if (!assistantMsg.tool_calls?.some((tc) => dropToolCallIds.has(tc.id))) return msg;
      const toolNames = [
        ...new Set(
          assistantMsg.tool_calls
            .filter((tc): tc is OpenAI.ChatCompletionMessageToolCall & { type: "function" } => tc.type === "function")
            .map((tc) => tc.function.name),
        ),
      ].join(", ");
      const note = `[searched: ${toolNames}]`;
      const content = assistantMsg.content ? `${assistantMsg.content} ${note}` : note;
      return { role: "assistant" as const, content };
    });
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

/** Delete a set of messages by ID (used to clean up dangling tool-round messages on error). */
function deleteMessages(messageIds: string[]): void {
  if (messageIds.length === 0) return;
  const db = getDb();
  db.delete(schema.messages)
    .where(inArray(schema.messages.id, messageIds))
    .run();
}

type RawToolCall = { id: string; function: { name: string; arguments: string } };

/**
 * Find the boundary between two back-to-back JSON objects in a string.
 * Gemini occasionally concatenates parallel tool-call argument objects, e.g.
 * '{"term":"X"}{"query":"X"}'. Returns [first, second] when found, null otherwise.
 */
export function trySplitJsonArgs(args: string): [string, string] | null {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\" && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") { depth++; continue; }
    if (ch === "}") {
      depth--;
      if (depth === 0 && i < args.length - 1) {
        const second = args.slice(i + 1).trimStart();
        if (second.startsWith("{")) {
          return [args.slice(0, i + 1), second];
        }
      }
    }
  }
  return null;
}

/**
 * Detect and repair the Gemini parallel-tool-call concatenation bug.
 * Some Gemini variants emit two tool calls as a single call with a concatenated
 * name (e.g. "sonarr_search_seriesplex_search_library") and concatenated JSON
 * arguments. This splits those back into two correct calls.
 * Returns the split pair on match, null if no split is needed.
 */
export function trySplitConcatenatedCall(
  tc: RawToolCall,
  registeredNames: string[],
): RawToolCall[] | null {
  const { name, arguments: args } = tc.function;
  if (registeredNames.includes(name)) return null; // valid tool, nothing to do

  for (const nameA of registeredNames) {
    if (!name.startsWith(nameA)) continue;
    const nameB = name.slice(nameA.length);
    if (!registeredNames.includes(nameB)) continue;
    const argsSplit = trySplitJsonArgs(args);
    if (!argsSplit) continue;
    return [
      { id: `${tc.id}-0`, function: { name: nameA, arguments: argsSplit[0] } },
      { id: `${tc.id}-1`, function: { name: nameB, arguments: argsSplit[1] } },
    ];
  }
  return null;
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

  // 1. Save user message — ID becomes the Langfuse traceId so the report-issue
  //    endpoint can attach a score to this exact trace later.
  const userMessageId = saveMessage(conversationId, "user", userMessage);

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

  // Start a Langfuse trace for this request (no-op if not configured).
  // traceId = userMessageId so the report-issue endpoint can score this trace
  // by querying the last user message ID for the conversation.
  const trace: LangfuseTraceClient | null = startTrace({
    traceId: userMessageId,
    conversationId,
    userId: params.userId !== undefined ? String(params.userId) : conversationId,
    userMessage,
    model,
  });

  // 3. Tool call loop
  // Tracks tool-round message IDs saved during this request (every assistant +
  // tool result message). On any error return path these are deleted from the DB
  // so the conversation history does not accumulate dangling assistant(tool_calls)
  // + tool(result) sequences that break strict models like Gemini.
  //
  // The user message (userMessageId) is intentionally NOT deleted on error: the
  // user genuinely typed and sent it, and keeping it in the DB lets the UI show
  // "message sent, no reply" honestly. loadHistory collapses consecutive user
  // messages (which arise when a prior request fails before saving any assistant
  // response) so they are never resent to the LLM.
  const toolRoundMessageIds: string[] = [];

  // Track the tool names executed in the previous round. When the model calls
  // display_titles and then returns an empty response in the next round, that is
  // correct behaviour (the card is the answer) — not an error to surface.
  let previousRoundToolNames: string[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let fullContent = "";
    const toolCalls: { id: string; function: { name: string; arguments: string } }[] = [];
    let llmDurationMs: number | undefined;
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    let totalTokens: number | undefined;

    // Inner retry loop: some models (e.g. Gemini Flash) occasionally return
    // 0 output tokens with no tool calls — an empty response that leaves the
    // user staring at a spinner forever. Retry up to MAX_EMPTY_RESPONSE_RETRIES
    // times before giving up and yielding an error.
    for (let emptyRetry = 0; emptyRetry <= MAX_EMPTY_RESPONSE_RETRIES; emptyRetry++) {
      if (emptyRetry > 0) {
        // Reset accumulators for the retry attempt
        fullContent = "";
        toolCalls.length = 0;
        llmDurationMs = undefined;
        promptTokens = undefined;
        completionTokens = undefined;
        totalTokens = undefined;
      }

      const roundLabel = emptyRetry === 0 ? `llm-round-${round}` : `llm-round-${round}-retry-${emptyRetry}`;

      try {
        const llmStart = Date.now();
        const generation = trace?.generation({
          name: roundLabel,
          model,
          input: apiMessages,
          startTime: new Date(llmStart),
        }) ?? null;
        const stream = await callWithRateLimitRetry(
          () =>
            client.chat.completions.create({
              model,
              messages: apiMessages,
              stream: true,
              stream_options: { include_usage: true },
              ...(tools && tools.length > 0 ? { tools } : {}),
            }),
          conversationId,
          round,
        );

        // Accumulate streaming chunks
        // Key by tool-call id rather than stream index. OpenAI uses distinct
        // indices for parallel tool calls; Gemini sends all at index 0 with
        // distinct ids. Keying by id handles both — indexToCurrentId maps an
        // index to whichever id arrived most recently at that index, so
        // continuation chunks (empty id) are associated correctly.
        const toolCallDeltas: Map<string, { id: string; name: string; args: string }> = new Map();
        const indexToCurrentId: Map<number, string> = new Map();

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

          // Text content — accumulate but do NOT yield yet.
          // We defer yielding until after the full stream is consumed so we can
          // tell whether the LLM also emitted tool calls in this same response.
          // If it did, the text is a premature / speculative answer produced
          // before the tools ran and should be suppressed entirely (the next LLM
          // turn after seeing the tool results will produce the real answer).
          if (delta?.content) {
            fullContent += delta.content;
          }

          // Tool call deltas
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              // A non-empty id signals the start of a new tool call at this index.
              // Update the index→id mapping so subsequent continuation chunks
              // (which arrive with an empty id) attach to the right entry.
              if (tc.id) {
                indexToCurrentId.set(idx, tc.id);
                if (!toolCallDeltas.has(tc.id)) {
                  toolCallDeltas.set(tc.id, { id: tc.id, name: "", args: "" });
                }
              }
              const currentId = indexToCurrentId.get(idx);
              if (!currentId) continue;
              const entry = toolCallDeltas.get(currentId)!;
              if (tc.function?.name) entry.name += tc.function.name;
              if (tc.function?.arguments) entry.args += tc.function.arguments;
            }
          }
        }

        llmDurationMs = Date.now() - llmStart;

        // Close the Langfuse generation span with output and token usage
        generation?.end({
          output: fullContent || null,
          usage: {
            input: promptTokens,
            output: completionTokens,
            total: totalTokens,
            unit: "TOKENS",
          },
        });

        // Collect completed tool calls, repairing Gemini's concatenation bug
        // where two parallel calls are emitted as one (e.g. name =
        // "sonarr_search_seriesplex_search_library"). trySplitConcatenatedCall
        // detects this pattern and returns the two correct calls instead.
        const registeredNames = getRegisteredToolNames();
        for (const [, tc] of toolCallDeltas) {
          if (tc.id && tc.name) {
            const raw: RawToolCall = { id: tc.id, function: { name: tc.name, arguments: tc.args } };
            const split = trySplitConcatenatedCall(raw, registeredNames);
            if (split) {
              logger.warn("Gemini concatenated tool calls detected, splitting", {
                conversationId,
                concatenated: tc.name,
                into: split.map((s) => s.function.name),
              });
              toolCalls.push(...split);
            } else {
              toolCalls.push(raw);
            }
          }
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "LLM request failed";
        const errorCategory = /429|quota|rate.?limit/i.test(msg) ? "rate_limit"
          : /401|403|unauthorized|forbidden/i.test(msg) ? "auth_error"
          : "llm_error";
        logger.error("LLM request failed", { conversationId, round, error: msg, errorCategory });
        deleteMessages(toolRoundMessageIds);
        trace?.update({ output: `error: ${errorCategory}` });
        flushLangfuse();
        yield { type: "error", message: sanitizeLlmError(msg) };
        return;
      }

      // Detect empty response: 0 output tokens, no text, no tool calls.
      // Some models (notably Gemini Flash variants) silently return nothing
      // after tool calls. Retry before treating it as a final empty response.
      const isEmpty = fullContent === "" && toolCalls.length === 0 && (completionTokens ?? 0) === 0;
      if (isEmpty && emptyRetry < MAX_EMPTY_RESPONSE_RETRIES) {
        logger.warn("LLM returned empty response, retrying", {
          conversationId,
          round,
          emptyRetry: emptyRetry + 1,
          model,
        });
        continue;
      }
      break; // got a real response (or exhausted retries)
    }

    // If no tool calls, this is the final assistant response — yield the
    // accumulated text now that we know no tool calls came in this round.
    if (toolCalls.length === 0) {
      // If retries were exhausted and the response is still empty, surface an
      // error rather than silently yielding nothing (which leaves the user
      // staring at a blank message).
      if (fullContent === "" && (completionTokens ?? 0) === 0) {
        // Special case: if the previous round exclusively called display_titles,
        // an empty follow-up is correct — the card is the answer and the model
        // has nothing more to say. Treat this as a clean completion.
        if (
          previousRoundToolNames.length > 0 &&
          previousRoundToolNames.every((n) => n === "display_titles")
        ) {
          const messageId = saveMessage(conversationId, "assistant", "");
          logger.info("Empty response after display_titles — treating as done", {
            conversationId,
            round,
          });
          trace?.update({ output: "" });
          flushLangfuse();
          yield { type: "done", messageId, llmDurationMs, promptTokens, completionTokens, totalTokens };
          return;
        }
        logger.error("LLM returned empty response after all retries", {
          conversationId,
          round,
          model,
        });
        // Roll back all messages saved during this request (user message + every
        // tool round's assistant and tool result messages). Without this, each
        // failed attempt leaves a dangling user message and unclosed tool sequences
        // in history. On the next retry saveMessage saves another user message,
        // producing consecutive user turns ([user1, user2]) that confuse strict
        // models like Gemini (which requires strictly alternating user/assistant
        // turns) causing every subsequent request in the conversation to fail.
        deleteMessages(toolRoundMessageIds);
        logger.info("Deleted dangling tool-round messages after empty response", {
          conversationId,
          round,
          deletedCount: toolRoundMessageIds.length,
        });
        trace?.update({ output: "error: empty_response" });
        flushLangfuse();
        yield { type: "error", message: "The AI service encountered an error. Please try again." };
        return;
      }
      if (fullContent) {
        yield { type: "text_delta", content: fullContent };
      }
      const messageId = saveMessage(conversationId, "assistant", fullContent);
      logger.info("LLM response complete", {
        conversationId,
        llmDurationMs,
        promptTokens,
        completionTokens,
        totalTokens,
      });
      trace?.update({ output: fullContent });
      flushLangfuse();
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
    const assistantMsgId = saveMessage(conversationId, "assistant", fullContent || null, {
      toolCalls: serializedToolCalls,
    });
    toolRoundMessageIds.push(assistantMsgId);

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

    // 4. Execute tool calls in parallel — multiple tool calls in a single round
    //    (e.g. 10 overseerr_get_details calls) run concurrently rather than
    //    sequentially, reducing the total round-trip time significantly.
    const TOOL_TIMEOUT_MS = 30_000;

    // Emit tool_call_start events immediately (before awaiting results)
    const startedAts: Map<string, number> = new Map();
    for (const tc of toolCalls) {
      const startedAt = Date.now();
      startedAts.set(tc.id, startedAt);
      logger.info("Tool call", { conversationId, toolName: tc.function.name, toolCallId: tc.id });
      yield {
        type: "tool_call_start",
        toolCallId: tc.id,
        toolName: tc.function.name,
        arguments: tc.function.arguments,
        startedAt,
      };
    }

    // Execute all tools concurrently
    const toolResults = await Promise.all(
      toolCalls.map(async (tc) => {
        const startedAt = startedAts.get(tc.id) ?? Date.now();
        const toolSpan = trace?.span({
          name: `tool:${tc.function.name}`,
          input: { arguments: tc.function.arguments },
          startTime: new Date(startedAt),
        }) ?? null;
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
        toolSpan?.end({ output: result!, level: isError ? "ERROR" : "DEFAULT" });
        return { tc, result: result!, isError, durationMs };
      }),
    );

    // Save results and emit events in original tool_calls order
    for (const { tc, result, isError, durationMs } of toolResults) {
      // Save tool result to DB (even on error — ensures the API message sequence stays valid)
      try {
        const toolMsgId = saveMessage(conversationId, "tool", result, {
          toolCallId: tc.id,
          toolName: tc.function.name,
          durationMs,
        });
        toolRoundMessageIds.push(toolMsgId);
        logger.info("Tool result saved", { conversationId, toolCallId: tc.id, toolName: tc.function.name, durationMs, isError });
      } catch (e: unknown) {
        logger.error("Failed to save tool result — conversation will be broken", {
          conversationId,
          toolCallId: tc.id,
          toolName: tc.function.name,
          error: e instanceof Error ? e.message : "Unknown error",
        });
      }

      // Add to conversation for next round — the LLM needs a tool message for every tool_calls entry.
      // Use the full result here so the LLM can read all fields (e.g. summary, thumbPath) to pass to
      // display_titles. The compact llmSummary is only used when loading historical messages (loadHistory),
      // where the LLM only needs a brief reminder of what was found, not the full payload.
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
        durationMs,
        error: isError,
      };
    }

    // Record this round's tool names so the next round can detect the
    // "empty after display_titles" case (see empty response handler above).
    previousRoundToolNames = toolCalls.map((tc) => tc.function.name);

    // Loop continues — LLM will see tool results and either respond or call more tools
  }

  // Safety: if we exhausted max rounds, yield what we have
  deleteMessages(toolRoundMessageIds);
  trace?.update({ output: "error: tool call limit reached" });
  flushLangfuse();
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
