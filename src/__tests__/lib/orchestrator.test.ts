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
    const parsed = JSON.parse((syntheticMsg as { content: string }).content) as { error: string };
    expect(parsed.error).toMatch(/did not complete/);
  });
});
