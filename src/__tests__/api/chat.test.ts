/**
 * Integration tests for POST /api/chat
 *
 * Tests the route-level concerns:
 *   - Authentication and conversation ownership
 *   - Rate limit enforcement (emitted as an SSE error stream, not a 4xx)
 *   - SSE event streaming (text_delta, done, tool_call_start, error)
 *   - Auto-title generation on first message
 *
 * The LLM orchestrator is mocked so tests are fast and deterministic.
 * Orchestrator internals (message persistence, tool execution) are tested
 * separately in orchestrator.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "@/lib/db/schema";
import path from "path";
import { mockState } from "../helpers/mock-state";
import { seedUser, seedSession, seedConversation } from "../helpers/db";

// ---------------------------------------------------------------------------
// DB mock
// ---------------------------------------------------------------------------
let sqlite: Database.Database;
let testDb: ReturnType<typeof drizzle<typeof schema>>;

vi.mock("@/lib/db", () => ({ getDb: () => testDb, schema }));

// ---------------------------------------------------------------------------
// next/headers mock
// ---------------------------------------------------------------------------
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) =>
      name === "thinkarr_session" && mockState.sessionCookie
        ? { value: mockState.sessionCookie }
        : undefined,
    set: vi.fn(),
    delete: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Orchestrator mock — the route calls orchestrate() and generateTitle()
// ---------------------------------------------------------------------------
vi.mock("@/lib/llm/orchestrator", () => ({
  orchestrate: vi.fn(),
  generateTitle: vi.fn(),
}));

import { POST } from "@/app/api/chat/route";
import { orchestrate, generateTitle } from "@/lib/llm/orchestrator";
import { setRateLimit } from "@/lib/config";

// ---------------------------------------------------------------------------
// SSE parsing helper
// ---------------------------------------------------------------------------
function parseSseEvents(text: string): Record<string, unknown>[] {
  return text
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => chunk.slice(6).trim())
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data) as Record<string, unknown>);
}

function chatRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  testDb = drizzle(sqlite, { schema });
  migrate(testDb, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  mockState.sessionCookie = undefined;

  // Default: orchestrate yields a simple text response and done
  vi.mocked(orchestrate).mockImplementation(async function* () {
    yield { type: "text_delta", content: "Hello!" };
    yield { type: "done", messageId: "msg-default" };
  } as unknown as typeof orchestrate);

  vi.mocked(generateTitle).mockResolvedValue(null);
});

afterEach(() => {
  sqlite.close();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Auth and input validation
// ---------------------------------------------------------------------------

describe("POST /api/chat — authentication", () => {
  it("returns 401 when no session cookie is present", async () => {
    const res = await POST(chatRequest({ conversationId: "c1", message: "hello" }));
    expect(res.status).toBe(401);
  });

  it("returns 401 for an expired session", async () => {
    const uid = seedUser(testDb);
    const expiredId = "expired-session";
    testDb
      .insert(schema.sessions)
      .values({ id: expiredId, userId: uid, expiresAt: new Date(Date.now() - 1000), createdAt: new Date() })
      .run();
    mockState.sessionCookie = expiredId;

    const res = await POST(chatRequest({ conversationId: "c1", message: "hello" }));
    expect(res.status).toBe(401);
  });
});

describe("POST /api/chat — input validation", () => {
  beforeEach(() => {
    const uid = seedUser(testDb);
    mockState.sessionCookie = seedSession(testDb, uid);
  });

  it("returns 400 when conversationId is missing", async () => {
    const res = await POST(chatRequest({ message: "hello" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when message is missing", async () => {
    const res = await POST(chatRequest({ conversationId: "c1" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when message is blank whitespace", async () => {
    const res = await POST(chatRequest({ conversationId: "c1", message: "   " }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when message exceeds 4000 characters", async () => {
    const res = await POST(chatRequest({ conversationId: "c1", message: "a".repeat(4001) }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/too long/i);
  });

  it("accepts a message of exactly 4000 characters", async () => {
    const uid = seedUser(testDb);
    const convId = seedConversation(testDb, uid);
    mockState.sessionCookie = seedSession(testDb, uid);
    const res = await POST(chatRequest({ conversationId: convId, message: "a".repeat(4000) }));
    // 200 OK with SSE stream — not a validation error
    expect(res.status).toBe(200);
  });
});

describe("POST /api/chat — conversation ownership", () => {
  it("returns 404 when the conversation does not exist", async () => {
    const uid = seedUser(testDb);
    mockState.sessionCookie = seedSession(testDb, uid);

    const res = await POST(chatRequest({ conversationId: "does-not-exist", message: "hello" }));
    expect(res.status).toBe(404);
  });

  it("returns 404 when the conversation belongs to another user", async () => {
    const uid1 = seedUser(testDb, { plexId: "u1", plexUsername: "user1" });
    const uid2 = seedUser(testDb, { plexId: "u2", plexUsername: "user2" });
    const convId = seedConversation(testDb, uid2); // owned by user2

    mockState.sessionCookie = seedSession(testDb, uid1); // logged in as user1

    const res = await POST(chatRequest({ conversationId: convId, message: "hello" }));
    expect(res.status).toBe(404);
    expect(orchestrate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe("POST /api/chat — rate limiting", () => {
  function seedUserMessages(convId: string, count: number) {
    for (let i = 0; i < count; i++) {
      testDb
        .insert(schema.messages)
        .values({
          id: `rl-msg-${i}`,
          conversationId: convId,
          role: "user",
          createdAt: new Date(),
        })
        .run();
    }
  }

  it("streams a rate limit error event (not a 4xx) when the limit is exceeded", async () => {
    const uid = seedUser(testDb);
    const convId = seedConversation(testDb, uid);
    mockState.sessionCookie = seedSession(testDb, uid);

    setRateLimit(uid, { messages: 3, period: "day" });
    seedUserMessages(convId, 3); // exactly at the limit

    const res = await POST(chatRequest({ conversationId: convId, message: "over the limit" }));

    // Rate limit is sent as an SSE stream, not a 4xx, so the client can
    // display the message inline in the chat UI
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");

    const events = parseSseEvents(await res.text());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error",
      message: expect.stringContaining("Session Limit"),
    });
  });

  it("does not call the orchestrator when the limit is exceeded", async () => {
    const uid = seedUser(testDb);
    const convId = seedConversation(testDb, uid);
    mockState.sessionCookie = seedSession(testDb, uid);

    setRateLimit(uid, { messages: 1, period: "day" });
    seedUserMessages(convId, 1);

    await POST(chatRequest({ conversationId: convId, message: "blocked" }));
    expect(orchestrate).not.toHaveBeenCalled();
  });

  it("allows the chat when the user is under their limit", async () => {
    const uid = seedUser(testDb);
    const convId = seedConversation(testDb, uid);
    mockState.sessionCookie = seedSession(testDb, uid);

    setRateLimit(uid, { messages: 10, period: "day" });
    seedUserMessages(convId, 3); // well under 10

    await POST(chatRequest({ conversationId: convId, message: "allowed" }));
    expect(orchestrate).toHaveBeenCalledOnce();
  });

  it("includes a reset timestamp in the rate limit error message", async () => {
    const uid = seedUser(testDb);
    const convId = seedConversation(testDb, uid);
    mockState.sessionCookie = seedSession(testDb, uid);

    setRateLimit(uid, { messages: 1, period: "day" });
    seedUserMessages(convId, 1);

    const res = await POST(chatRequest({ conversationId: convId, message: "blocked" }));
    const events = parseSseEvents(await res.text());
    // The error message should contain a date/time string (e.g. "08/Mar/26 00:00")
    expect(String(events[0].message)).toMatch(/\d{2}\/\w{3}\/\d{2}/);
  });

  it("only counts messages within the current rate-limit window", async () => {
    const uid = seedUser(testDb);
    const convId = seedConversation(testDb, uid);
    mockState.sessionCookie = seedSession(testDb, uid);

    setRateLimit(uid, { messages: 2, period: "day" });

    // Seed one old message (yesterday — outside today's window)
    const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000);
    testDb.insert(schema.messages).values({
      id: "old-msg",
      conversationId: convId,
      role: "user",
      createdAt: yesterday,
    }).run();

    // Only 1 message today — under the limit of 2
    testDb.insert(schema.messages).values({
      id: "today-msg",
      conversationId: convId,
      role: "user",
      createdAt: new Date(),
    }).run();

    await POST(chatRequest({ conversationId: convId, message: "should be allowed" }));
    expect(orchestrate).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// SSE streaming
// ---------------------------------------------------------------------------

describe("POST /api/chat — SSE streaming", () => {
  let uid: number;
  let convId: string;

  beforeEach(() => {
    uid = seedUser(testDb);
    convId = seedConversation(testDb, uid);
    mockState.sessionCookie = seedSession(testDb, uid);
  });

  it("responds with text/event-stream content type", async () => {
    const res = await POST(chatRequest({ conversationId: convId, message: "hello" }));
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
  });

  it("streams text_delta events from the orchestrator", async () => {
    vi.mocked(orchestrate).mockImplementation(async function* () {
      yield { type: "text_delta", content: "The " };
      yield { type: "text_delta", content: "answer " };
      yield { type: "text_delta", content: "is 42." };
      yield { type: "done", messageId: "final" };
    } as unknown as typeof orchestrate);

    const res = await POST(chatRequest({ conversationId: convId, message: "what is the answer?" }));
    const events = parseSseEvents(await res.text());

    const deltas = events.filter((e) => e.type === "text_delta");
    expect(deltas).toHaveLength(3);
    expect(deltas.map((e) => e.content).join("")).toBe("The answer is 42.");
  });

  it("forwards the done event with the message id", async () => {
    vi.mocked(orchestrate).mockImplementation(async function* () {
      yield { type: "text_delta", content: "ok" };
      yield { type: "done", messageId: "stored-msg-id" };
    } as unknown as typeof orchestrate);

    const events = parseSseEvents(
      await (await POST(chatRequest({ conversationId: convId, message: "hi" }))).text(),
    );
    expect(events).toContainEqual({ type: "done", messageId: "stored-msg-id" });
  });

  it("forwards tool_call_start and tool_result events", async () => {
    vi.mocked(orchestrate).mockImplementation(async function* () {
      yield { type: "tool_call_start", toolCallId: "tc1", toolName: "search_sonarr", arguments: "{}" };
      yield { type: "tool_result", toolCallId: "tc1", toolName: "search_sonarr", result: "[]" };
      yield { type: "done", messageId: "after-tools" };
    } as unknown as typeof orchestrate);

    const events = parseSseEvents(
      await (await POST(chatRequest({ conversationId: convId, message: "find me a show" }))).text(),
    );
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_call_start", toolName: "search_sonarr" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_result", toolName: "search_sonarr" }));
  });

  it("streams the orchestrator error event when the LLM fails", async () => {
    vi.mocked(orchestrate).mockImplementation(async function* () {
      yield { type: "error", message: "LLM endpoint unreachable" };
    } as unknown as typeof orchestrate);

    const events = parseSseEvents(
      await (await POST(chatRequest({ conversationId: convId, message: "hello" }))).text(),
    );
    expect(events).toContainEqual({ type: "error", message: "LLM endpoint unreachable" });
  });

  it("passes conversationId, userMessage, and optional modelId to the orchestrator", async () => {
    await POST(chatRequest({ conversationId: convId, message: "specific question", modelId: "gpt-4o" }));
    expect(orchestrate).toHaveBeenCalledWith({
      conversationId: convId,
      userMessage: "specific question",
      modelId: "gpt-4o",
    });
  });
});

// ---------------------------------------------------------------------------
// Auto-title generation
// ---------------------------------------------------------------------------

describe("POST /api/chat — auto-title on first message", () => {
  it("emits a title_update event when the conversation title is 'New Chat'", async () => {
    const uid = seedUser(testDb);
    // seedConversation defaults to "Test Chat" — use "New Chat" to trigger title gen
    const convId = seedConversation(testDb, uid, "New Chat");
    mockState.sessionCookie = seedSession(testDb, uid);

    vi.mocked(generateTitle).mockResolvedValue("Ghostbusters (1984)");

    const events = parseSseEvents(
      await (await POST(chatRequest({ conversationId: convId, message: "Find Ghostbusters" }))).text(),
    );

    expect(events).toContainEqual({
      type: "title_update",
      conversationId: convId,
      title: "Ghostbusters (1984)",
    });
  });

  it("does NOT emit title_update when the conversation already has a custom title", async () => {
    const uid = seedUser(testDb);
    const convId = seedConversation(testDb, uid, "My Movie List"); // not "New Chat"
    mockState.sessionCookie = seedSession(testDb, uid);

    const events = parseSseEvents(
      await (await POST(chatRequest({ conversationId: convId, message: "hello" }))).text(),
    );

    const titleEvents = events.filter((e) => e.type === "title_update");
    expect(titleEvents).toHaveLength(0);
    expect(generateTitle).not.toHaveBeenCalled();
  });

  it("does NOT emit title_update if generateTitle returns null (LLM failure)", async () => {
    const uid = seedUser(testDb);
    const convId = seedConversation(testDb, uid, "New Chat");
    mockState.sessionCookie = seedSession(testDb, uid);

    vi.mocked(generateTitle).mockResolvedValue(null);

    const events = parseSseEvents(
      await (await POST(chatRequest({ conversationId: convId, message: "Find me something" }))).text(),
    );

    expect(events.filter((e) => e.type === "title_update")).toHaveLength(0);
  });

  it("still streams the chat response even if title generation fails", async () => {
    const uid = seedUser(testDb);
    const convId = seedConversation(testDb, uid, "New Chat");
    mockState.sessionCookie = seedSession(testDb, uid);

    vi.mocked(generateTitle).mockRejectedValue(new Error("title gen crashed"));

    // Should not throw — route handles title errors gracefully
    const res = await POST(chatRequest({ conversationId: convId, message: "hello" }));
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    const events = parseSseEvents(await res.text());
    expect(events).toContainEqual(expect.objectContaining({ type: "done" }));
  });
});
