/**
 * Unit tests for POST /api/conversations/[id]/messages
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "@/lib/db/schema";
import { eq } from "drizzle-orm";
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
// generateTitle mock
// ---------------------------------------------------------------------------
const mockGenerateTitle = vi.fn();
vi.mock("@/lib/llm/orchestrator", () => ({
  generateTitle: (...args: unknown[]) => mockGenerateTitle(...args),
}));

// ---------------------------------------------------------------------------
// Route handler (imported after mocks)
// ---------------------------------------------------------------------------
import { POST } from "@/app/api/conversations/[id]/messages/route";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
function makeRequest(body: unknown, conversationId: string): Request {
  return new Request(`http://localhost/api/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
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
  mockGenerateTitle.mockResolvedValue(null);
});

afterEach(() => {
  sqlite.close();
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
describe("POST /api/conversations/[id]/messages — auth", () => {
  it("returns 401 when not authenticated", async () => {
    const res = await POST(makeRequest({ role: "user", content: "hi" }, "c1"), makeParams("c1"));
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
describe("POST /api/conversations/[id]/messages — validation", () => {
  it("returns 400 for invalid role", async () => {
    const uid = seedUser(testDb);
    mockState.sessionCookie = seedSession(testDb, uid);
    const convId = seedConversation(testDb, uid);

    const res = await POST(makeRequest({ role: "system", content: "hi" }, convId), makeParams(convId));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/role/i);
  });

  it("returns 400 when content is missing", async () => {
    const uid = seedUser(testDb);
    mockState.sessionCookie = seedSession(testDb, uid);
    const convId = seedConversation(testDb, uid);

    const res = await POST(makeRequest({ role: "user" }, convId), makeParams(convId));
    expect(res.status).toBe(400);
  });

  it("returns 400 when content is blank", async () => {
    const uid = seedUser(testDb);
    mockState.sessionCookie = seedSession(testDb, uid);
    const convId = seedConversation(testDb, uid);

    const res = await POST(makeRequest({ role: "user", content: "   " }, convId), makeParams(convId));
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------
describe("POST /api/conversations/[id]/messages — access control", () => {
  it("returns 404 for a non-existent conversation", async () => {
    const uid = seedUser(testDb);
    mockState.sessionCookie = seedSession(testDb, uid);

    const res = await POST(makeRequest({ role: "user", content: "hi" }, "nonexistent"), makeParams("nonexistent"));
    expect(res.status).toBe(404);
  });

  it("returns 404 when saving to another user's conversation", async () => {
    const uid1 = seedUser(testDb, { plexId: "u1" });
    const uid2 = seedUser(testDb, { plexId: "u2" });
    mockState.sessionCookie = seedSession(testDb, uid1);
    const convId = seedConversation(testDb, uid2);

    const res = await POST(makeRequest({ role: "user", content: "hi" }, convId), makeParams(convId));
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Successful saves
// ---------------------------------------------------------------------------
describe("POST /api/conversations/[id]/messages — success", () => {
  it("saves a user message and returns 200 with the message id", async () => {
    const uid = seedUser(testDb);
    mockState.sessionCookie = seedSession(testDb, uid);
    const convId = seedConversation(testDb, uid);

    const res = await POST(makeRequest({ role: "user", content: "Hello from realtime" }, convId), makeParams(convId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.data.id).toBe("string");

    // Verify it's actually in the DB
    const saved = testDb.select().from(schema.messages).where(eq(schema.messages.id, body.data.id)).get();
    expect(saved).toBeDefined();
    expect(saved!.role).toBe("user");
    expect(saved!.content).toBe("Hello from realtime");
    expect(saved!.conversationId).toBe(convId);
  });

  it("saves an assistant message", async () => {
    const uid = seedUser(testDb);
    mockState.sessionCookie = seedSession(testDb, uid);
    const convId = seedConversation(testDb, uid);

    const res = await POST(
      makeRequest({ role: "assistant", content: "Here are the results..." }, convId),
      makeParams(convId),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    const saved = testDb.select().from(schema.messages).where(eq(schema.messages.id, body.data.id)).get();
    expect(saved!.role).toBe("assistant");
    expect(saved!.content).toBe("Here are the results...");
  });

  it("trims whitespace from content before saving", async () => {
    const uid = seedUser(testDb);
    mockState.sessionCookie = seedSession(testDb, uid);
    const convId = seedConversation(testDb, uid);

    const res = await POST(
      makeRequest({ role: "user", content: "  padded content  " }, convId),
      makeParams(convId),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const saved = testDb.select().from(schema.messages).where(eq(schema.messages.id, body.data.id)).get();
    expect(saved!.content).toBe("padded content");
  });
});

// ---------------------------------------------------------------------------
// Title generation (#252)
// ---------------------------------------------------------------------------
describe("POST /api/conversations/[id]/messages — title generation", () => {
  it("calls generateTitle on the first user message and returns newTitle", async () => {
    const uid = seedUser(testDb);
    mockState.sessionCookie = seedSession(testDb, uid);
    const convId = seedConversation(testDb, uid, "New Chat");

    mockGenerateTitle.mockResolvedValue("Ghostbusters (1984)");

    const res = await POST(
      makeRequest({ role: "user", content: "Is Ghostbusters on Plex?" }, convId),
      makeParams(convId),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.newTitle).toBe("Ghostbusters (1984)");
    expect(mockGenerateTitle).toHaveBeenCalledWith(convId, "Is Ghostbusters on Plex?");
  });

  it("does not call generateTitle for assistant messages", async () => {
    const uid = seedUser(testDb);
    mockState.sessionCookie = seedSession(testDb, uid);
    const convId = seedConversation(testDb, uid, "New Chat");

    const res = await POST(
      makeRequest({ role: "assistant", content: "Yes, it is available." }, convId),
      makeParams(convId),
    );
    expect(res.status).toBe(200);
    expect(mockGenerateTitle).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.data.newTitle).toBeNull();
  });

  it("returns newTitle as null when generateTitle returns null", async () => {
    const uid = seedUser(testDb);
    mockState.sessionCookie = seedSession(testDb, uid);
    const convId = seedConversation(testDb, uid, "New Chat");

    mockGenerateTitle.mockResolvedValue(null);

    const res = await POST(
      makeRequest({ role: "user", content: "What is on TV tonight?" }, convId),
      makeParams(convId),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.newTitle).toBeNull();
  });
});
