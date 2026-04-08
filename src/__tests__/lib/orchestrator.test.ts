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
  executeTool: vi.fn().mockResolvedValue(JSON.stringify({ displayTitles: [] })),
  getToolLlmContent: (_name: string, result: string) => result,
  getRegisteredToolNames: () => ["display_titles"],
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ---------------------------------------------------------------------------
// LLM client mock — captures messages sent to it
// Supports a per-test response queue: push factory functions before calling
// orchestrate() and the mock will consume them in order. Falls back to a
// default text response when the queue is empty.
// ---------------------------------------------------------------------------
let capturedMessages: unknown[] = [];
type AsyncGenFactory = () => AsyncGenerator<unknown, void, unknown>;
let llmResponseQueue: AsyncGenFactory[] = [];

vi.mock("@/lib/llm/client", () => ({
  getLlmClient: () => ({
    chat: {
      completions: {
        create: vi.fn(async ({ messages }: { messages: unknown[] }) => {
          capturedMessages = messages;
          const factory = llmResponseQueue.shift();
          if (factory) return factory();
          // Default: return a plain text response
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
  llmResponseQueue = [];
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
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
// Empty response retry tests (issues #301/#302 — Gemini Flash hang)
// ---------------------------------------------------------------------------

describe("orchestrator — empty response retry", () => {
  it("retries and recovers when the LLM returns 0 tokens on the first attempt", async () => {
    let callCount = 0;
    vi.doMock("@/lib/llm/client", () => ({
      getLlmClient: () => ({
        chat: {
          completions: {
            create: vi.fn(async () => {
              callCount++;
              if (callCount === 1) {
                // First call: simulate Gemini empty response (0 output tokens, no content)
                return (async function* () {
                  yield { choices: [{ delta: {} }], usage: null };
                  yield {
                    choices: [],
                    usage: { prompt_tokens: 100, completion_tokens: 0, total_tokens: 100 },
                  };
                })();
              }
              // Second call: real response
              return (async function* () {
                yield { choices: [{ delta: { content: "The Testaments has not been requested yet." } }], usage: null };
                yield {
                  choices: [],
                  usage: { prompt_tokens: 100, completion_tokens: 12, total_tokens: 112 },
                };
              })();
            }),
          },
        },
      }),
      getLlmModel: () => "gemini-2.5-flash-lite",
      getLlmClientForEndpoint: vi.fn(),
    }));

    const userId = seedUser(testDb);
    const conversationId = seedConversation(testDb, userId);

    const { orchestrate } = await import("@/lib/llm/orchestrator");
    const events: { type: string; content?: string; message?: string }[] = [];
    for await (const event of orchestrate({ conversationId, userMessage: "Is the testaments requested?" })) {
      events.push(event as { type: string; content?: string; message?: string });
    }

    // Should have retried and yielded the real text response
    expect(callCount).toBe(2);
    const textEvent = events.find((e) => e.type === "text_delta");
    expect(textEvent).toBeDefined();
    expect(textEvent!.content).toMatch(/Testaments/);
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents).toHaveLength(0);
  });

  it("yields an error after all retries are exhausted with empty responses", async () => {
    vi.doMock("@/lib/llm/client", () => ({
      getLlmClient: () => ({
        chat: {
          completions: {
            create: vi.fn(async () => {
              // Always return empty
              return (async function* () {
                yield { choices: [{ delta: {} }], usage: null };
                yield {
                  choices: [],
                  usage: { prompt_tokens: 100, completion_tokens: 0, total_tokens: 100 },
                };
              })();
            }),
          },
        },
      }),
      getLlmModel: () => "gemini-2.5-flash-lite",
      getLlmClientForEndpoint: vi.fn(),
    }));

    const userId = seedUser(testDb);
    const conversationId = seedConversation(testDb, userId);

    const { orchestrate } = await import("@/lib/llm/orchestrator");
    const events: { type: string; message?: string }[] = [];
    for await (const event of orchestrate({ conversationId, userMessage: "Hello" })) {
      events.push(event as { type: string; message?: string });
    }

    // Should yield an error, not a silent empty done
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.message).toBe("The AI service encountered an error. Please try again.");
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeUndefined();
  });

  it("keeps user message but deletes tool-round messages when round-1 exhausts retries (issues #305, #308)", async () => {
    // Round 0 returns a tool call; round 1 always returns empty.
    // The tool-round messages (assistant(tool_calls) + tool results) must be deleted
    // on error so they don't accumulate as dangling sequences. The user message is
    // intentionally kept — it was a real request and the UI shows it as "sent, no reply".
    // loadHistory collapses consecutive user messages so the ghost is never resent to LLM.
    let callCount = 0;
    vi.doMock("@/lib/llm/client", () => ({
      getLlmClient: () => ({
        chat: {
          completions: {
            create: vi.fn(async () => {
              callCount++;
              if (callCount === 1) {
                // Round 0: return a tool call
                return (async function* () {
                  yield {
                    choices: [{
                      delta: {
                        tool_calls: [{ index: 0, id: "call_test_123", function: { name: "overseerr_search", arguments: '{"term":"The Testaments"}' } }],
                      },
                    }],
                    usage: null,
                  };
                  yield {
                    choices: [],
                    usage: { prompt_tokens: 100, completion_tokens: 19, total_tokens: 119 },
                  };
                })();
              }
              // Round 1 (and all retries): always empty
              return (async function* () {
                yield { choices: [{ delta: {} }], usage: null };
                yield {
                  choices: [],
                  usage: { prompt_tokens: 200, completion_tokens: 0, total_tokens: 200 },
                };
              })();
            }),
          },
        },
      }),
      getLlmModel: () => "gemini-2.5-flash-lite",
      getLlmClientForEndpoint: vi.fn(),
    }));
    vi.doMock("@/lib/tools/registry", () => ({
      hasTools: () => true,
      getOpenAITools: () => [{ type: "function", function: { name: "overseerr_search", description: "Search", parameters: {} } }],
      executeTool: vi.fn(async () => JSON.stringify({ results: [{ title: "The Testaments", mediaStatus: "not_requested" }] })),
      getToolLlmContent: (_name: string, result: string) => result,
      getRegisteredToolNames: () => ["overseerr_search"],
    }));

    const userId = seedUser(testDb);
    const conversationId = seedConversation(testDb, userId);

    const { orchestrate } = await import("@/lib/llm/orchestrator");
    const { eq: drizzleEq } = await import("drizzle-orm");
    const events: { type: string; message?: string }[] = [];
    for await (const event of orchestrate({ conversationId, userMessage: "Is the testaments requested?" })) {
      events.push(event as { type: string; message?: string });
    }

    // Should yield an error
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();

    // User message must remain in DB (shown in UI as "sent, no reply").
    // Tool-round messages (assistant + tool results) must be deleted.
    const remaining = testDb
      .select()
      .from(schema.messages)
      .where(drizzleEq(schema.messages.conversationId, conversationId))
      .all();

    const roles = remaining.map((m) => m.role);
    expect(roles).toEqual(["user"]);
    expect(remaining.filter((m) => m.role === "assistant")).toHaveLength(0);
    expect(remaining.filter((m) => m.role === "tool")).toHaveLength(0);
  });

  it("yields done (not error) when LLM returns empty after an exclusive display_titles round (issue #324)", async () => {
    // Round 0: LLM calls display_titles — the card is the response.
    // Round 1 (and retries): LLM returns empty — this is correct; no text needed after a card.
    // The orchestrator must treat this as a clean completion, not an error.
    vi.doMock("@/lib/llm/client", () => ({
      getLlmClient: () => ({
        chat: {
          completions: {
            create: vi.fn(async () => {
              // Consume from the outer llmResponseQueue (set by the test below)
              const factory = llmResponseQueue.shift();
              if (factory) return factory();
              // Fallback empty response for unexpected extra calls
              return (async function* () {
                yield { choices: [{ delta: {} }], usage: { prompt_tokens: 50, completion_tokens: 0, total_tokens: 50 } };
              })();
            }),
          },
        },
      }),
      getLlmModel: () => "gemini-2.5-flash-lite",
      getLlmClientForEndpoint: vi.fn(),
    }));
    vi.doMock("@/lib/tools/registry", () => ({
      hasTools: () => true,
      getOpenAITools: () => [{ type: "function", function: { name: "display_titles", description: "Show cards", parameters: {} } }],
      executeTool: vi.fn(async () => JSON.stringify({ displayTitles: [{ title: "Song to Song", mediaStatus: "available" }] })),
      getToolLlmContent: (_name: string, result: string) => result,
      getRegisteredToolNames: () => ["display_titles"],
    }));

    // Round 0: display_titles tool call
    llmResponseQueue.push(async function* () {
      yield {
        choices: [{
          delta: {
            tool_calls: [{ index: 0, id: "call_display_123", function: { name: "display_titles", arguments: '{"titles":[{"title":"Song to Song","mediaType":"movie","mediaStatus":"available"}]}' } }],
          },
        }],
        usage: null,
      };
      yield { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } };
    });
    // Round 1 (and retries): always empty — model has nothing to add after showing the card
    const emptyResponse: AsyncGenFactory = async function* () {
      yield { choices: [{ delta: {} }], usage: { prompt_tokens: 200, completion_tokens: 0, total_tokens: 200 } };
    };
    llmResponseQueue.push(emptyResponse, emptyResponse, emptyResponse); // cover all retries

    const userId = seedUser(testDb);
    const conversationId = seedConversation(testDb, userId);

    const { orchestrate } = await import("@/lib/llm/orchestrator");
    const { eq: drizzleEq } = await import("drizzle-orm");
    const events: { type: string; message?: string }[] = [];
    for await (const event of orchestrate({ conversationId, userMessage: "Render a title card?" })) {
      events.push(event as { type: string; message?: string });
    }

    // Must complete without error
    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents).toHaveLength(0);

    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();

    // Tool-round messages (the display_titles call + result) must be kept in DB
    const remaining = testDb
      .select()
      .from(schema.messages)
      .where(drizzleEq(schema.messages.conversationId, conversationId))
      .all();

    const roles = remaining.map((m) => m.role);
    // user + assistant(tool_calls) + tool(display_titles result) + assistant(empty follow-up)
    expect(roles).toContain("user");
    expect(remaining.filter((m) => m.role === "assistant")).toHaveLength(2);
    expect(remaining.filter((m) => m.role === "tool")).toHaveLength(1);
  });
}); // end "orchestrator — empty response retry"

// ---------------------------------------------------------------------------
// Tool-round message building — assistant messages sent to LLM after tool calls
// ---------------------------------------------------------------------------

describe("orchestrator — tool-round assistant message format (issue #328)", () => {
  it("omits content from the assistant message when the tool call had no text (Gemini null-content fix)", async () => {
    // Round 0: LLM emits a tool call with NO text content (fullContent === "").
    // Round 1: LLM returns a plain text response after seeing the tool result.
    // We capture the messages sent in round 1 and assert the assistant message
    // from round 0 does NOT have content:null — Gemini rejects null content in
    // assistant messages that contain tool_calls, causing an llm_error.
    let capturedRound1Messages: unknown[] = [];
    let callCount = 0;

    vi.doMock("@/lib/db", () => ({ getDb: () => testDb, schema }));
    vi.doMock("@/lib/config", () => ({
      getConfig: vi.fn(() => null),
      getRateLimit: vi.fn(() => ({ messages: 100, period: "day" })),
    }));
    vi.doMock("@/lib/llm/langfuse", () => ({
      startTrace: () => null,
      flushLangfuse: () => {},
      isLangfuseEnabled: () => false,
    }));
    vi.doMock("@/lib/llm/client", () => ({
      getLlmClient: () => ({
        chat: {
          completions: {
            create: vi.fn(async (params: { messages: unknown[] }) => {
              callCount++;
              if (callCount === 2) {
                capturedRound1Messages = params.messages;
              }
              if (callCount === 1) {
                // Round 0: tool call only, no text
                return (async function* () {
                  yield {
                    choices: [{
                      delta: {
                        tool_calls: [{ index: 0, id: "call_plex_123", function: { name: "plex_search_library", arguments: '{"query":"Malcolm in the Middle"}' } }],
                      },
                    }],
                    usage: null,
                  };
                  yield { choices: [], usage: { prompt_tokens: 100, completion_tokens: 21, total_tokens: 121 } };
                })();
              }
              // Round 1: plain text response
              return (async function* () {
                yield { choices: [{ delta: { content: "Malcolm in the Middle is not available." } }], usage: null };
                yield { choices: [], usage: { prompt_tokens: 200, completion_tokens: 10, total_tokens: 210 } };
              })();
            }),
          },
        },
      }),
      getLlmModel: () => "gemini-3.1-flash-lite-preview",
      getLlmClientForEndpoint: vi.fn(),
    }));
    vi.doMock("@/lib/tools/registry", () => ({
      hasTools: () => true,
      getOpenAITools: () => [{ type: "function", function: { name: "plex_search_library", description: "Search Plex", parameters: {} } }],
      executeTool: vi.fn(async () => JSON.stringify({ results: [], hasMore: false })),
      getToolLlmContent: (_name: string, result: string) => result,
      getRegisteredToolNames: () => ["plex_search_library"],
    }));
    vi.doMock("@/lib/tools/init", () => ({ initializeTools: vi.fn() }));
    vi.doMock("@/lib/llm/system-prompt", () => ({ buildSystemPrompt: () => "You are helpful." }));

    const userId = seedUser(testDb);
    const conversationId = seedConversation(testDb, userId);

    const { orchestrate } = await import("@/lib/llm/orchestrator");
    const events: { type: string; message?: string }[] = [];
    for await (const event of orchestrate({ conversationId, userMessage: "Is Malcolm in the middle available?" })) {
      events.push(event as { type: string; message?: string });
    }

    // Must complete without error
    expect(events.find((e) => e.type === "error")).toBeUndefined();
    expect(events.find((e) => e.type === "done")).toBeDefined();

    // The assistant message from round 0 sent to round 1 must NOT have content:null.
    // It should either be absent or be an empty string — never null.
    const assistantMsg = (capturedRound1Messages as { role: string; content?: unknown; tool_calls?: unknown[] }[])
      .find((m) => m.role === "assistant" && m.tool_calls != null);
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.content).not.toBe(null);
  });
});

// ---------------------------------------------------------------------------
// loadHistory — skips phantom empty assistant messages (issue #328 follow-on)
// ---------------------------------------------------------------------------

describe("loadHistory — phantom empty assistant message suppression", () => {
  it("skips an assistant message with no content and no tool_calls so Gemini does not get { role:'assistant' } with null content", async () => {
    // Reproduces the round-0 failure pattern: a prior request ended with
    // saveMessage(conversationId, "assistant", "") (display_titles empty-response
    // special case). loadHistory must not send that phantom message to the LLM.
    vi.doMock("@/lib/db", () => ({ getDb: () => testDb, schema }));
    vi.doMock("@/lib/config", () => ({
      getConfig: vi.fn(() => null),
      getRateLimit: vi.fn(() => ({ messages: 100, period: "day" })),
    }));
    vi.doMock("@/lib/llm/langfuse", () => ({
      startTrace: () => null,
      flushLangfuse: () => {},
      isLangfuseEnabled: () => false,
    }));

    let capturedMsgs: unknown[] = [];
    vi.doMock("@/lib/llm/client", () => ({
      getLlmClient: () => ({
        chat: {
          completions: {
            create: vi.fn(async (params: { messages: unknown[] }) => {
              capturedMsgs = params.messages;
              return (async function* () {
                yield { choices: [{ delta: { content: "Here are your results." } }], usage: null };
                yield { choices: [], usage: { prompt_tokens: 50, completion_tokens: 8, total_tokens: 58 } };
              })();
            }),
          },
        },
      }),
      getLlmModel: () => "gemini-3.1-flash-lite-preview",
      getLlmClientForEndpoint: vi.fn(),
    }));
    vi.doMock("@/lib/tools/registry", () => ({
      hasTools: () => false,
      getOpenAITools: () => [],
      executeTool: vi.fn(),
      getToolLlmContent: (_name: string, result: string) => result,
      getRegisteredToolNames: () => [],
    }));
    vi.doMock("@/lib/tools/init", () => ({ initializeTools: vi.fn() }));
    vi.doMock("@/lib/llm/system-prompt", () => ({ buildSystemPrompt: () => "You are helpful." }));

    const userId = seedUser(testDb);
    const conversationId = seedConversation(testDb, userId);

    // Plant the prior exchange: user → assistant(tool_calls) → tool(result) → assistant("") phantom
    const toolCallId = "call_display_phantom_1";
    insertMessage(testDb, conversationId, "user", "What movies do you have?", { createdAtOffset: 0 });
    insertMessage(testDb, conversationId, "assistant", null, {
      toolCalls: JSON.stringify([{ id: toolCallId, type: "function", function: { name: "display_titles", arguments: "{}" } }]),
      createdAtOffset: 100,
    });
    insertMessage(testDb, conversationId, "tool", JSON.stringify({ displayTitles: [] }), {
      toolCallId,
      toolName: "display_titles",
      createdAtOffset: 200,
    });
    // Phantom empty assistant message saved by the display_titles empty-response special case
    insertMessage(testDb, conversationId, "assistant", "", { createdAtOffset: 300 });

    const { orchestrate } = await import("@/lib/llm/orchestrator");
    const events: { type: string; message?: string }[] = [];
    for await (const event of orchestrate({ conversationId, userMessage: "Which ones are new?" })) {
      events.push(event as { type: string; message?: string });
    }

    // Must complete without error
    expect(events.find((e) => e.type === "error")).toBeUndefined();
    expect(events.find((e) => e.type === "done")).toBeDefined();

    // The phantom { role:"assistant" } (no content, no tool_calls) must not appear
    // in what was sent to the LLM — Gemini rejects it as content:null.
    const phantomMsg = (capturedMsgs as { role: string; content?: unknown; tool_calls?: unknown[] }[])
      .find((m) => m.role === "assistant" && !m.content && !m.tool_calls?.length);
    expect(phantomMsg).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Ghost-user collapse — loadHistory skips consecutive user messages from prior
// failed requests so the LLM never sees invalid consecutive user turns (#308)
// ---------------------------------------------------------------------------

describe("ghost user message collapse in loadHistory", () => {
  it("skips ghost user message from failed prior request when next request is made", async () => {
    // Simulate: first request failed (kept user#1 in DB, no assistant saved).
    // Second request sends user#2. loadHistory must skip user#1 so LLM sees only [user#2].
    vi.doMock("@/lib/db", () => ({ getDb: () => testDb, schema }));
    vi.doMock("@/lib/config", () => ({
      getConfig: vi.fn(() => null),
      getRateLimit: vi.fn(() => ({ messages: 100, period: "day" })),
    }));
    vi.doMock("@/lib/llm/langfuse", () => ({
      startTrace: () => null,
      flushLangfuse: () => {},
      isLangfuseEnabled: () => false,
    }));
    vi.doMock("@/lib/llm/client", () => ({
      getLlmClient: () => ({
        chat: {
          completions: {
            create: vi.fn(async (params: { messages: { role: string }[] }) => {
              // Capture messages so test can assert on them
              capturedMessages = params.messages;
              return (async function* () {
                yield { choices: [{ delta: { content: "The Testaments is pending." } }], usage: null };
                yield { choices: [], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } };
              })();
            }),
          },
        },
      }),
      getLlmModel: () => "gemini-2.5-flash-lite",
      getLlmClientForEndpoint: vi.fn(),
    }));
    vi.doMock("@/lib/tools/registry", () => ({
      hasTools: () => false,
      getOpenAITools: () => [],
      executeTool: vi.fn(),
      getToolLlmContent: (_name: string, result: string) => result,
      getRegisteredToolNames: () => [],
    }));
    vi.doMock("@/lib/tools/init", () => ({ initializeTools: vi.fn() }));
    vi.doMock("@/lib/llm/system-prompt", () => ({ buildSystemPrompt: () => "You are helpful." }));

    const userId = seedUser(testDb);
    const conversationId = seedConversation(testDb, userId);

    // Plant user#1 (ghost from a failed prior request) directly in DB
    const { getDb } = await import("@/lib/db");
    const db = getDb();
    db.insert(schema.messages).values({
      id: "ghost-user-msg-1",
      conversationId,
      role: "user",
      content: "Is the testaments requested?",
      toolCalls: null,
      toolCallId: null,
      toolName: null,
      durationMs: null,
    }).run();

    // Second request (retry)
    const { orchestrate } = await import("@/lib/llm/orchestrator");
    const events: { type: string }[] = [];
    for await (const event of orchestrate({ conversationId, userMessage: "Is the testaments requested?" })) {
      events.push(event as { type: string });
    }

    // Must succeed (not error)
    expect(events.find((e) => e.type === "done")).toBeDefined();
    expect(events.find((e) => e.type === "error")).toBeUndefined();

    // LLM must not have received consecutive user messages — only system + user#2
    const userMsgs = (capturedMessages as { role: string }[]).filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// trimToolHistory — pure unit tests (no DB or LLM mock needed)
// ---------------------------------------------------------------------------

import type OpenAI from "openai";

type AssistantMsg = OpenAI.ChatCompletionAssistantMessageParam;
type ToolMsg = OpenAI.ChatCompletionToolMessageParam;
type UserMsg = OpenAI.ChatCompletionUserMessageParam;
type ChatMessage = OpenAI.ChatCompletionMessageParam;

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
// capConversationHistory — pure unit tests
// ---------------------------------------------------------------------------

// MAX_CONVERSATION_TURNS = 20 individual messages (user or assistant).
// That is 10 back-and-forth exchanges.
describe("capConversationHistory — pure unit", () => {
  let cap: typeof import("@/lib/llm/orchestrator").capConversationHistory;
  let MAX_TURNS: number;

  beforeEach(async () => {
    vi.resetModules();
    ({ capConversationHistory: cap, MAX_CONVERSATION_TURNS: MAX_TURNS } =
      await import("@/lib/llm/orchestrator"));
  });

  it("returns messages unchanged when individual message count < MAX_CONVERSATION_TURNS", () => {
    // 9 exchanges = 18 individual messages < 20
    const msgs: (UserMsg | AssistantMsg)[] = [];
    for (let i = 0; i < 9; i++) {
      msgs.push(userMsg(`q${i}`));
      msgs.push({ role: "assistant", content: `a${i}` });
    }
    expect(cap(msgs, "c")).toHaveLength(18);
  });

  it("returns messages unchanged when individual message count equals MAX_CONVERSATION_TURNS", () => {
    // 10 exchanges = 20 individual messages — exactly at the limit, nothing dropped
    const msgs: (UserMsg | AssistantMsg)[] = [];
    for (let i = 0; i < 10; i++) {
      msgs.push(userMsg(`q${i}`));
      msgs.push({ role: "assistant", content: `a${i}` });
    }
    expect(cap(msgs, "c")).toHaveLength(MAX_TURNS);
  });

  it("drops oldest messages when individual count exceeds MAX_CONVERSATION_TURNS", () => {
    // 12 exchanges = 24 individual messages > 20
    const msgs: (UserMsg | AssistantMsg)[] = [];
    for (let i = 0; i < 12; i++) {
      msgs.push(userMsg(`q${i}`));
      msgs.push({ role: "assistant", content: `a${i}` });
    }
    const result = cap(msgs, "c");
    const turns = result.filter((m) => m.role === "user" || m.role === "assistant");
    expect(turns).toHaveLength(MAX_TURNS); // 20
  });

  it("keeps the most recent messages, not the oldest", () => {
    // 12 exchanges = 24 messages. Capping to 20 drops the first 4 (q0, a0, q1, a1).
    const msgs: (UserMsg | AssistantMsg)[] = [];
    for (let i = 0; i < 12; i++) {
      msgs.push(userMsg(`q${i}`));
      msgs.push({ role: "assistant", content: `a${i}` });
    }
    const result = cap(msgs, "c");
    const userMsgs = result.filter((m) => m.role === "user") as UserMsg[];
    expect((userMsgs[0].content as string)).toBe("q2"); // q0 and q1 dropped
  });

  it("retains tool messages whose call_id is referenced in the kept window", () => {
    // Build 9 plain exchanges (18 messages) then add a tool-call exchange,
    // giving 21 individual messages — 1 over the limit.
    // The tool-call exchange is the most recent so it must be kept.
    const msgs: ChatMessage[] = [];
    for (let i = 0; i < 9; i++) {
      msgs.push(userMsg(`q${i}`));
      msgs.push({ role: "assistant", content: `a${i}` });
    }
    const callId = "call_keep_me";
    msgs.push(userMsg("latest"));
    msgs.push({
      role: "assistant",
      tool_calls: [{ id: callId, type: "function", function: { name: "plex_search_library", arguments: "{}" } }],
    } as AssistantMsg);
    msgs.push(toolResult(callId)); // tool messages don't count toward the cap

    const result = cap(msgs, "c");
    const toolMsgs = result.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(1);
    expect((toolMsgs[0] as ToolMsg).tool_call_id).toBe(callId);
  });

  it("drops tool messages whose call_id is no longer in the kept window", () => {
    // Old exchange with tool call (3 messages: user + assistant_with_call + tool_result)
    // followed by 10 plain exchanges (20 messages) — old exchange is pushed out.
    const msgs: ChatMessage[] = [];
    const oldCallId = "call_drop_me";
    msgs.push(userMsg("old query"));
    msgs.push({
      role: "assistant",
      tool_calls: [{ id: oldCallId, type: "function", function: { name: "plex_search_library", arguments: "{}" } }],
    } as AssistantMsg);
    msgs.push(toolResult(oldCallId));

    for (let i = 0; i < 10; i++) {
      msgs.push(userMsg(`q${i}`));
      msgs.push({ role: "assistant", content: `a${i}` });
    }
    // Total: 2 old user/assistant + 20 new user/assistant = 22 turns — cap drops old 2
    const result = cap(msgs, "c");
    const toolMsgs = result.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(0);
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
      getRegisteredToolNames: () => ["plex_search_library"],
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
    vi.doMock("@/lib/tools/registry", () => ({
      hasTools: () => false,
      getOpenAITools: () => [],
      executeTool: vi.fn(),
      getToolLlmContent: (_name: string, result: string) => result,
      getRegisteredToolNames: () => [],
    }));
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

    vi.doMock("@/lib/tools/registry", () => ({
      hasTools: () => false,
      getOpenAITools: () => [],
      executeTool: vi.fn(),
      getToolLlmContent: (_name: string, result: string) => result,
      getRegisteredToolNames: () => [],
    }));
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

// ---------------------------------------------------------------------------
// Gemini parallel tool calls at index 0 (trace 84002b4f)
// ---------------------------------------------------------------------------

describe("orchestrator — Gemini parallel tool calls at same index", () => {
  beforeEach(() => {
    vi.resetModules();
    sqlite = new Database(":memory:");
    testDb = drizzle(sqlite, { schema });
    migrate(testDb, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
  });
  afterEach(() => {
    sqlite.close();
  });

  it("executes both tool calls separately when Gemini sends parallel calls at index 0", async () => {
    // Gemini sends two tool calls both at index: 0 with distinct ids.
    // The fix keys by id (not index) so each call gets its own entry.
    let llmCallCount = 0;
    vi.doMock("@/lib/llm/client", () => ({
      getLlmClient: () => ({
        chat: {
          completions: {
            create: vi.fn(async () => {
              llmCallCount++;
              if (llmCallCount === 1) {
                // Round 1: two parallel tool calls, both at index 0
                return (async function* () {
                  yield {
                    choices: [{
                      delta: {
                        tool_calls: [{
                          index: 0,
                          id: "call_sonarr",
                          function: { name: "sonarr_search_series", arguments: '{"term":"The Young Offenders"}' },
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
                          id: "call_plex",
                          function: { name: "plex_search_library", arguments: '{"query":"The Young Offenders"}' },
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
              } else {
                // Round 2+: text response after seeing tool results
                return (async function* () {
                  yield { choices: [{ delta: { content: "The Young Offenders is available." } }], usage: null };
                  yield { choices: [{ delta: {} }], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } };
                })();
              }
            }),
          },
        },
      }),
      getLlmModel: () => "gemini-2.5-flash-lite",
      getLlmClientForEndpoint: vi.fn(),
    }));

    const mockExecuteTool = vi.fn().mockResolvedValue(JSON.stringify({ results: [] }));
    vi.doMock("@/lib/tools/registry", () => ({
      hasTools: () => true,
      getOpenAITools: () => [
        { type: "function", function: { name: "sonarr_search_series", description: "", parameters: {} } },
        { type: "function", function: { name: "plex_search_library", description: "", parameters: {} } },
      ],
      executeTool: mockExecuteTool,
      getToolLlmContent: (_name: string, result: string) => result,
      getRegisteredToolNames: () => ["sonarr_search_series", "plex_search_library"],
    }));

    const userId = seedUser(testDb);
    const conversationId = seedConversation(testDb, userId);
    const { orchestrate } = await import("@/lib/llm/orchestrator");

    const events: { type: string; toolName?: string }[] = [];
    for await (const event of orchestrate({ conversationId, userMessage: "Is there a new series of young offenders?" })) {
      events.push(event as { type: string; toolName?: string });
    }

    const toolStartEvents = events.filter((e) => e.type === "tool_call_start");
    // Both tool calls must be executed separately — not concatenated into one
    expect(toolStartEvents).toHaveLength(2);
    const toolNames = toolStartEvents.map((e) => e.toolName).sort();
    expect(toolNames).toEqual(["plex_search_library", "sonarr_search_series"]);

    // executeTool must be called with each individual tool name
    const calledNames = mockExecuteTool.mock.calls.map((c: unknown[]) => c[0]).sort();
    expect(calledNames).toEqual(["plex_search_library", "sonarr_search_series"]);
  });
});
