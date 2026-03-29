/**
 * Unit tests for the LLM orchestrator — specifically the orphaned tool call
 * repair logic in loadHistory() (issue #151).
 *
 * When the server crashes between saving an assistant message (with tool_calls)
 * and saving the corresponding tool results, subsequent requests to the LLM
 * fail with HTTP 400: "An assistant message with 'tool_calls' must be followed
 * by tool messages responding to each 'tool_call_id'."
 *
 * The fix in loadHistory() detects missing tool results and injects synthetic
 * error messages so the conversation sequence stays valid.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "@/lib/db/schema";
import path from "path";
import { v4 as uuidv4 } from "uuid";

// ---------------------------------------------------------------------------
// DB mock
// ---------------------------------------------------------------------------
let sqlite: Database.Database;
let testDb: ReturnType<typeof drizzle<typeof schema>>;

vi.mock("@/lib/db", () => ({ getDb: () => testDb, schema }));

// ---------------------------------------------------------------------------
// System prompt + tools: minimal stubs
// ---------------------------------------------------------------------------
vi.mock("@/lib/llm/system-prompt", () => ({ buildSystemPrompt: () => "You are a helpful assistant." }));
vi.mock("@/lib/tools/init", () => ({ initializeTools: vi.fn() }));
vi.mock("@/lib/tools/registry", () => ({
  hasTools: () => false,
  getOpenAITools: () => [],
  executeTool: vi.fn(),
  getToolLlmContent: (_name: string, result: string) => result,
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ---------------------------------------------------------------------------
// LLM client mock — captures messages sent to it
// ---------------------------------------------------------------------------
let capturedMessages: unknown[] = [];

vi.mock("@/lib/llm/client", () => ({
  getLlmClient: () => ({
    chat: {
      completions: {
        create: vi.fn(async ({ messages }: { messages: unknown[] }) => {
          capturedMessages = messages;
          // Return an async iterable that yields a single text chunk then usage
          return (async function* () {
            yield {
              choices: [{ delta: { content: "Here are the results." } }],
              usage: null,
            };
            yield {
              choices: [{ delta: {} }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            };
          })();
        }),
      },
    },
  }),
  getLlmModel: () => "gpt-4o",
  getLlmClientForEndpoint: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function insertMessage(
  db: ReturnType<typeof drizzle<typeof schema>>,
  conversationId: string,
  role: "user" | "assistant" | "tool",
  content: string | null,
  extra: {
    toolCalls?: string;
    toolCallId?: string;
    toolName?: string;
    durationMs?: number;
    createdAtOffset?: number; // ms offset from epoch for ordering
  } = {},
) {
  const id = uuidv4();
  db.insert(schema.messages)
    .values({
      id,
      conversationId,
      role,
      content,
      toolCalls: extra.toolCalls ?? null,
      toolCallId: extra.toolCallId ?? null,
      toolName: extra.toolName ?? null,
      durationMs: extra.durationMs ?? null,
      createdAt: new Date(1000 + (extra.createdAtOffset ?? 0)),
    })
    .run();
  return id;
}

function seedConversation(db: ReturnType<typeof drizzle<typeof schema>>, userId: number) {
  const id = `conv-${uuidv4()}`;
  const now = new Date();
  db.insert(schema.conversations).values({ id, userId, title: "Test", createdAt: now, updatedAt: now }).run();
  return id;
}

function seedUser(db: ReturnType<typeof drizzle<typeof schema>>) {
  const result = db
    .insert(schema.users)
    .values({
      plexId: `plex-${uuidv4()}`,
      plexUsername: "testuser",
      plexEmail: "test@example.com",
      isAdmin: false,
      createdAt: new Date(),
    })
    .run();
  return Number(result.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  testDb = drizzle(sqlite, { schema });
  migrate(testDb, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  capturedMessages = [];
  vi.resetModules();
});

afterEach(() => {
  sqlite.close();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("orchestrator — orphaned tool call repair (issue #151)", () => {
  it("injects a synthetic error result for an orphaned tool call so the LLM receives a valid message sequence", async () => {
    const userId = seedUser(testDb);
    const conversationId = seedConversation(testDb, userId);

    // Seed a prior exchange: user → assistant with tool call → NO tool result (crash scenario)
    const orphanedToolCallId = "call_QzV245P4LPot3vFOGK4Xdl55";
    const toolCallsJson = JSON.stringify([
      { id: orphanedToolCallId, type: "function", function: { name: "display_titles", arguments: "{}" } },
    ]);

    insertMessage(testDb, conversationId, "user", "Find me Star Trek", { createdAtOffset: 0 });
    insertMessage(testDb, conversationId, "assistant", null, {
      toolCalls: toolCallsJson,
      createdAtOffset: 100,
    });
    // Deliberately NOT inserting the tool result (simulating the crash)

    const { orchestrate } = await import("@/lib/llm/orchestrator");

    // Drain the generator — new user message being sent
    const events = [];
    for await (const event of orchestrate({ conversationId, userMessage: "Try again please" })) {
      events.push(event);
    }

    // Verify the generator completed without an error event
    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents).toHaveLength(0);

    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();

    // Verify the messages sent to the LLM include a synthetic tool result
    // immediately after the orphaned assistant message
    const assistantIdx = capturedMessages.findIndex(
      (m: unknown) =>
        (m as { role: string }).role === "assistant" &&
        (m as { tool_calls?: unknown[] }).tool_calls != null,
    );
    expect(assistantIdx).toBeGreaterThanOrEqual(0);

    const toolResultMsg = capturedMessages[assistantIdx + 1] as {
      role: string;
      tool_call_id: string;
      content: string;
    };
    expect(toolResultMsg).toBeDefined();
    expect(toolResultMsg.role).toBe("tool");
    expect(toolResultMsg.tool_call_id).toBe(orphanedToolCallId);

    const parsedResult = JSON.parse(toolResultMsg.content) as { error: string };
    expect(parsedResult.error).toMatch(/did not complete/);
  });

  it("does not inject synthetic results when all tool calls have matching results", async () => {
    const userId = seedUser(testDb);
    const conversationId = seedConversation(testDb, userId);

    const completedToolCallId = "call_completed_abc123";
    const toolCallsJson = JSON.stringify([
      { id: completedToolCallId, type: "function", function: { name: "display_titles", arguments: "{}" } },
    ]);

    // Full, healthy exchange: user → assistant with tool call → tool result → done
    insertMessage(testDb, conversationId, "user", "Find me movies", { createdAtOffset: 0 });
    insertMessage(testDb, conversationId, "assistant", null, {
      toolCalls: toolCallsJson,
      createdAtOffset: 100,
    });
    insertMessage(testDb, conversationId, "tool", JSON.stringify({ displayTitles: [] }), {
      toolCallId: completedToolCallId,
      toolName: "display_titles",
      createdAtOffset: 200,
    });
    insertMessage(testDb, conversationId, "assistant", "Here are some movies.", { createdAtOffset: 300 });

    const { orchestrate } = await import("@/lib/llm/orchestrator");

    const events = [];
    for await (const event of orchestrate({ conversationId, userMessage: "Any sci-fi ones?" })) {
      events.push(event);
    }

    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents).toHaveLength(0);

    // Count tool messages in what was sent to the LLM — should be exactly one (the real one)
    const toolMessages = (capturedMessages as { role: string }[]).filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(1);
    const toolMsg = toolMessages[0] as { role: string; tool_call_id: string };
    expect(toolMsg.tool_call_id).toBe(completedToolCallId);
  });

  it("handles a partial crash: one tool result saved but a second tool call result is missing", async () => {
    const userId = seedUser(testDb);
    const conversationId = seedConversation(testDb, userId);

    const savedId = "call_saved_111";
    const orphanedId = "call_orphaned_222";
    const toolCallsJson = JSON.stringify([
      { id: savedId, type: "function", function: { name: "plex_search_library", arguments: "{}" } },
      { id: orphanedId, type: "function", function: { name: "display_titles", arguments: "{}" } },
    ]);

    insertMessage(testDb, conversationId, "user", "Search Star Trek", { createdAtOffset: 0 });
    insertMessage(testDb, conversationId, "assistant", null, {
      toolCalls: toolCallsJson,
      createdAtOffset: 100,
    });
    // Only the first tool result was saved before the crash
    insertMessage(testDb, conversationId, "tool", JSON.stringify({ results: [] }), {
      toolCallId: savedId,
      toolName: "plex_search_library",
      createdAtOffset: 200,
    });
    // Second result (orphanedId) was NOT saved

    const { orchestrate } = await import("@/lib/llm/orchestrator");

    const events = [];
    for await (const event of orchestrate({ conversationId, userMessage: "Try again" })) {
      events.push(event);
    }

    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents).toHaveLength(0);

    // Exactly two tool messages should appear in captured messages: the saved one + synthetic
    const toolMessages = (capturedMessages as { role: string; tool_call_id: string }[]).filter(
      (m) => m.role === "tool",
    );
    expect(toolMessages).toHaveLength(2);

    const savedMsg = toolMessages.find((m) => m.tool_call_id === savedId);
    const syntheticMsg = toolMessages.find((m) => m.tool_call_id === orphanedId);

    expect(savedMsg).toBeDefined();
    expect(syntheticMsg).toBeDefined();
    const parsed = JSON.parse((syntheticMsg as unknown as { content: string }).content) as { error: string };
    expect(parsed.error).toMatch(/did not complete/);
  });

  it("persists the synthetic result to DB so the repair does not repeat on subsequent requests", async () => {
    const userId = seedUser(testDb);
    const conversationId = seedConversation(testDb, userId);

    const orphanedToolCallId = "call_persistent_repair_test";
    const toolCallsJson = JSON.stringify([
      { id: orphanedToolCallId, type: "function", function: { name: "display_titles", arguments: "{}" } },
    ]);

    insertMessage(testDb, conversationId, "user", "Find me a film", { createdAtOffset: 0 });
    insertMessage(testDb, conversationId, "assistant", null, {
      toolCalls: toolCallsJson,
      createdAtOffset: 100,
    });

    const { orchestrate } = await import("@/lib/llm/orchestrator");
    const { eq } = await import("drizzle-orm");

    // First request — triggers the repair and should persist the synthetic result
    for await (const _ of orchestrate({ conversationId, userMessage: "Hello" })) { /* drain */ }

    // Exactly one synthetic tool result row should exist in the DB
    const rowsAfterFirst = testDb
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.toolCallId, orphanedToolCallId))
      .all();

    expect(rowsAfterFirst).toHaveLength(1);
    expect(rowsAfterFirst[0].role).toBe("tool");
    const content = JSON.parse(rowsAfterFirst[0].content!) as { error: string };
    expect(content.error).toMatch(/did not complete/);

    // Second request — no new synthetic row should be added (repair does not repeat)
    for await (const _ of orchestrate({ conversationId, userMessage: "Go on" })) { /* drain */ }

    const rowsAfterSecond = testDb
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.toolCallId, orphanedToolCallId))
      .all();

    expect(rowsAfterSecond).toHaveLength(1); // still exactly 1, not 2
  });
});

// ---------------------------------------------------------------------------
// LLM error sanitization tests
// ---------------------------------------------------------------------------

describe("orchestrator — LLM error sanitization", () => {
  it("yields a friendly message for a 429 quota error and does not expose the raw API error", async () => {
    vi.doMock("@/lib/llm/client", () => ({
      getLlmClient: () => ({
        chat: {
          completions: {
            create: vi.fn().mockRejectedValue(
              new Error("429 You exceeded your current quota, please check your plan and billing details."),
            ),
          },
        },
      }),
      getLlmModel: () => "gpt-4o",
      getLlmClientForEndpoint: vi.fn(),
    }));

    const userId = seedUser(testDb);
    const conversationId = seedConversation(testDb, userId);

    const { orchestrate } = await import("@/lib/llm/orchestrator");
    const events = [];
    for await (const event of orchestrate({ conversationId, userMessage: "Hello" })) {
      events.push(event);
    }

    const errorEvent = events.find((e) => e.type === "error") as { type: string; message: string } | undefined;
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.message).toBe("The AI service is temporarily unavailable. Please try again in a moment.");
    expect(errorEvent!.message).not.toMatch(/quota/);
    expect(errorEvent!.message).not.toMatch(/429/);
  });

  it("yields a friendly message for a generic LLM error and does not expose internal details", async () => {
    vi.doMock("@/lib/llm/client", () => ({
      getLlmClient: () => ({
        chat: {
          completions: {
            create: vi.fn().mockRejectedValue(new Error("Connection reset by peer")),
          },
        },
      }),
      getLlmModel: () => "gpt-4o",
      getLlmClientForEndpoint: vi.fn(),
    }));

    const userId = seedUser(testDb);
    const conversationId = seedConversation(testDb, userId);

    const { orchestrate } = await import("@/lib/llm/orchestrator");
    const events = [];
    for await (const event of orchestrate({ conversationId, userMessage: "Hello" })) {
      events.push(event);
    }

    const errorEvent = events.find((e) => e.type === "error") as { type: string; message: string } | undefined;
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.message).toBe("The AI service encountered an error. Please try again.");
    expect(errorEvent!.message).not.toMatch(/Connection reset/);
  });
});

// ---------------------------------------------------------------------------
// trimToolHistory — pure unit tests (no DB or LLM mock needed)
// ---------------------------------------------------------------------------

import type OpenAI from "openai";

type AssistantMsg = OpenAI.ChatCompletionAssistantMessageParam;
type ToolMsg = OpenAI.ChatCompletionToolMessageParam;
type UserMsg = OpenAI.ChatCompletionUserMessageParam;

/** Build a minimal assistant message that has tool_calls. */
function assistantWithCalls(id: string, toolName: string, content?: string): AssistantMsg {
  const msg: AssistantMsg = {
    role: "assistant",
    tool_calls: [{ id, type: "function", function: { name: toolName, arguments: "{}" } }],
  };
  if (content) msg.content = content;
  return msg;
}

/** Build a tool result message. */
function toolResult(toolCallId: string): ToolMsg {
  return { role: "tool", tool_call_id: toolCallId, content: '{"ok":true}' };
}

/** Build a plain user message. */
function userMsg(text: string): UserMsg {
  return { role: "user", content: text };
}

/** Build N rounds of: user → assistant(tool_calls) → tool(result) → assistant(text). */
function buildRounds(n: number) {
  const msgs: (AssistantMsg | ToolMsg | UserMsg)[] = [];
  for (let i = 0; i < n; i++) {
    msgs.push(userMsg(`query ${i}`));
    msgs.push(assistantWithCalls(`call_${i}`, "plex_search_library"));
    msgs.push(toolResult(`call_${i}`));
    msgs.push({ role: "assistant", content: `Response ${i}` });
  }
  return msgs;
}

describe("trimToolHistory — pure unit", () => {
  // Import under test — no mocking needed for the pure function
  let trim: typeof import("@/lib/llm/orchestrator").trimToolHistory;

  beforeEach(async () => {
    vi.resetModules();
    ({ trimToolHistory: trim } = await import("@/lib/llm/orchestrator"));
  });

  it("returns messages unchanged when rounds ≤ MAX_TOOL_ROUNDS_IN_HISTORY", async () => {
    const msgs = buildRounds(5);
    const result = trim(msgs, "conv-1");
    expect(result).toHaveLength(msgs.length);
    const toolMsgs = result.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(5);
    const assistantWithCalls = result.filter(
      (m) => m.role === "assistant" && "tool_calls" in m && (m as AssistantMsg).tool_calls != null,
    );
    expect(assistantWithCalls).toHaveLength(5);
  });

  it("trims oldest rounds when count exceeds MAX_TOOL_ROUNDS_IN_HISTORY", async () => {
    const msgs = buildRounds(7);
    const result = trim(msgs, "conv-2");

    // Only 5 tool messages should remain (2 oldest dropped)
    const toolMsgs = result.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(5);

    // Only 5 assistant messages with tool_calls should remain
    const withCalls = result.filter(
      (m) => m.role === "assistant" && "tool_calls" in m && (m as AssistantMsg).tool_calls != null,
    );
    expect(withCalls).toHaveLength(5);
  });

  it("replaces trimmed assistant tool_calls with a [searched: ...] note", async () => {
    const msgs = buildRounds(6); // round 0 will be trimmed
    const result = trim(msgs, "conv-3");

    // Round 0's assistant message should have become plain text with a note
    const trimmedAssistant = result.find(
      (m) => m.role === "assistant" && typeof (m as AssistantMsg).content === "string" &&
        ((m as AssistantMsg).content as string).includes("[searched:"),
    ) as AssistantMsg | undefined;

    expect(trimmedAssistant).toBeDefined();
    expect(trimmedAssistant!.content).toContain("plex_search_library");
    expect(trimmedAssistant!.tool_calls).toBeUndefined();
  });

  it("preserves existing assistant text content when replacing tool_calls", async () => {
    const msgs: (AssistantMsg | ToolMsg | UserMsg)[] = [
      userMsg("hi"),
      assistantWithCalls("call_0", "plex_search_library", "Let me check that for you!"),
      toolResult("call_0"),
      { role: "assistant", content: "Found nothing." },
      ...buildRounds(5), // push total tool rounds to 6, trimming round 0
    ];

    const result = trim(msgs, "conv-4");

    const trimmedMsg = result.find(
      (m) => m.role === "assistant" &&
        typeof (m as AssistantMsg).content === "string" &&
        ((m as AssistantMsg).content as string).includes("Let me check that for you!"),
    ) as AssistantMsg | undefined;

    expect(trimmedMsg).toBeDefined();
    expect(trimmedMsg!.content).toBe("Let me check that for you! [searched: plex_search_library]");
    expect(trimmedMsg!.tool_calls).toBeUndefined();
  });

  it("keeps all user and plain assistant messages when trimming", async () => {
    const msgs = buildRounds(7);
    const result = trim(msgs, "conv-5");

    // All 7 user messages should survive
    const userMsgs = result.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(7);

    // All 7 plain-text assistant responses + 2 converted tool-calling messages = 9 plain assistants
    const plainAssistant = result.filter(
      (m) => m.role === "assistant" && !("tool_calls" in m && (m as AssistantMsg).tool_calls),
    );
    expect(plainAssistant).toHaveLength(9);
  });

  it("handles exactly MAX_TOOL_ROUNDS_IN_HISTORY+1 rounds (boundary case)", async () => {
    const { MAX_TOOL_ROUNDS_IN_HISTORY } = await import("@/lib/llm/orchestrator");
    const msgs = buildRounds(MAX_TOOL_ROUNDS_IN_HISTORY + 1);
    const result = trim(msgs, "conv-6");

    const toolMsgs = result.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(MAX_TOOL_ROUNDS_IN_HISTORY);
  });
});

// ---------------------------------------------------------------------------
// Text suppression when the LLM emits text alongside tool calls (issue #239)
// ---------------------------------------------------------------------------

describe("orchestrator — premature text suppression (issue #239)", () => {
  beforeEach(() => {
    vi.resetModules();
    sqlite = new Database(":memory:");
    testDb = drizzle(sqlite, { schema });
    migrate(testDb, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
  });
  afterEach(() => {
    sqlite.close();
  });

  it("suppresses text_delta events when the LLM emits text and tool calls in the same response", async () => {
    // Simulate an LLM that streams "I'm not sure..." text *and* a tool call
    // in the same response — the premature text must not reach the client.
    vi.doMock("@/lib/llm/client", () => ({
      getLlmClient: () => ({
        chat: {
          completions: {
            create: vi.fn(async () => {
              return (async function* () {
                // Round 1: text + tool call in the same response
                yield {
                  choices: [{
                    delta: {
                      content: "I'm not seeing any results right now.",
                      tool_calls: [{
                        index: 0,
                        id: "call_abc123",
                        function: { name: "plex_search_library", arguments: "" },
                      }],
                    },
                  }],
                  usage: null,
                };
                yield {
                  choices: [{
                    delta: {
                      tool_calls: [{
                        index: 0,
                        id: "",
                        function: { name: "", arguments: '{"query":"apprentice"}' },
                      }],
                    },
                  }],
                  usage: null,
                };
                yield {
                  choices: [{ delta: {} }],
                  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
                };
              })();
            }),
          },
        },
      }),
      getLlmModel: () => "gpt-4o",
      getLlmClientForEndpoint: vi.fn(),
    }));

    vi.doMock("@/lib/tools/registry", () => ({
      hasTools: () => true,
      getOpenAITools: () => [{ type: "function", function: { name: "plex_search_library", description: "", parameters: {} } }],
      executeTool: vi.fn().mockResolvedValue(JSON.stringify({ results: [] })),
      getToolLlmContent: (_name: string, result: string) => result,
    }));

    const userId = seedUser(testDb);
    const conversationId = seedConversation(testDb, userId);
    const { orchestrate } = await import("@/lib/llm/orchestrator");

    const events: { type: string }[] = [];
    // Drain only one round (tool_call_start will fire but the test ends after
    // the MAX_TOOL_ROUNDS error since the mock always returns tool calls)
    for await (const event of orchestrate({ conversationId, userMessage: "When is the next apprentice?" })) {
      events.push(event as { type: string });
      // Stop after the first tool_result so we don't need the mock to produce a final text response
      if (event.type === "tool_result") break;
    }

    // The premature text from round 1 must NOT have been yielded
    const textEvents = events.filter((e) => e.type === "text_delta");
    expect(textEvents).toHaveLength(0);

    // Tool call events must still be present
    const toolStartEvents = events.filter((e) => e.type === "tool_call_start");
    expect(toolStartEvents).toHaveLength(1);
  });

  it("yields text_delta when the LLM responds with text only (no tool calls)", async () => {
    vi.doMock("@/lib/llm/client", () => ({
      getLlmClient: () => ({
        chat: {
          completions: {
            create: vi.fn(async () => {
              return (async function* () {
                yield { choices: [{ delta: { content: "The Apprentice airs on Thursday." } }], usage: null };
                yield { choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
              })();
            }),
          },
        },
      }),
      getLlmModel: () => "gpt-4o",
      getLlmClientForEndpoint: vi.fn(),
    }));

    const userId = seedUser(testDb);
    const conversationId = seedConversation(testDb, userId);
    const { orchestrate } = await import("@/lib/llm/orchestrator");

    const events: { type: string; content?: string }[] = [];
    for await (const event of orchestrate({ conversationId, userMessage: "When is The Apprentice?" })) {
      events.push(event as { type: string; content?: string });
    }

    const textEvents = events.filter((e) => e.type === "text_delta");
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0].content).toBe("The Apprentice airs on Thursday.");

    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
  });
});

describe("orchestrator — 429 rate-limit retry", () => {
  beforeEach(() => {
    vi.resetModules();
    sqlite = new Database(":memory:");
    testDb = drizzle(sqlite, { schema });
    migrate(testDb, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
  });
  afterEach(() => {
    sqlite.close();
  });

  it("retries on 429 and succeeds when second attempt works", async () => {
    let callCount = 0;

    vi.doMock("@/lib/llm/client", () => ({
      getLlmClient: () => ({
        chat: {
          completions: {
            create: vi.fn(async () => {
              callCount++;
              if (callCount === 1) {
                throw new Error("429 Rate limit reached for gpt-4.1 on tokens per min (TPM). Please try again in 50ms.");
              }
              return (async function* () {
                yield { choices: [{ delta: { content: "Retry succeeded." } }], usage: null };
                yield { choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
              })();
            }),
          },
        },
      }),
      getLlmModel: () => "gpt-4o",
      getLlmClientForEndpoint: vi.fn(),
    }));

    // Make timer delays instant so the retry doesn't block the test
    const origSetTimeout = globalThis.setTimeout;
    (globalThis as unknown as { setTimeout: (fn: () => void) => number }).setTimeout =
      (fn: () => void) => { Promise.resolve().then(fn); return 0; };

    try {
      const userId = seedUser(testDb);
      const conversationId = seedConversation(testDb, userId);
      const { orchestrate } = await import("@/lib/llm/orchestrator");

      const events: unknown[] = [];
      for await (const event of orchestrate({ conversationId, userMessage: "Hello" })) {
        events.push(event);
      }

      expect(callCount).toBe(2);
      expect(events.some((e) => (e as { type: string }).type === "text_delta")).toBe(true);
      expect(events.some((e) => (e as { type: string }).type === "error")).toBe(false);
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }
  });

  it("surfaces a friendly error after all retries are exhausted", async () => {
    vi.doMock("@/lib/llm/client", () => ({
      getLlmClient: () => ({
        chat: {
          completions: {
            create: vi.fn().mockRejectedValue(
              new Error("429 Rate limit reached. Please try again in 50ms."),
            ),
          },
        },
      }),
      getLlmModel: () => "gpt-4o",
      getLlmClientForEndpoint: vi.fn(),
    }));

    // Make timer delays instant
    const origSetTimeout = globalThis.setTimeout;
    (globalThis as unknown as { setTimeout: (fn: () => void) => number }).setTimeout =
      (fn: () => void) => { Promise.resolve().then(fn); return 0; };

    try {
      const userId = seedUser(testDb);
      const conversationId = seedConversation(testDb, userId);
      const { orchestrate } = await import("@/lib/llm/orchestrator");

      const events: unknown[] = [];
      for await (const event of orchestrate({ conversationId, userMessage: "Hello" })) {
        events.push(event);
      }

      const errorEvents = events.filter(
        (e) => (e as { type: string }).type === "error",
      ) as { type: string; message: string }[];
      expect(errorEvents.length).toBeGreaterThan(0);
      expect(errorEvents[0].message).toBe(
        "The AI service is temporarily unavailable. Please try again in a moment.",
      );
      // No raw API details leaked
      expect(errorEvents[0].message).not.toMatch(/429/);
      expect(errorEvents[0].message).not.toMatch(/TPM/);
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }
  });
});
