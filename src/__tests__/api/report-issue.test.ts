/**
 * Unit tests for POST /api/report-issue
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
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
// GitHub fetch mock — capture calls and return configurable responses
// ---------------------------------------------------------------------------
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ---------------------------------------------------------------------------
// Logger mock
// ---------------------------------------------------------------------------
import * as loggerModule from "@/lib/logger";
let logInfoSpy: MockInstance;

// ---------------------------------------------------------------------------
// Route handler (imported after mocks)
// ---------------------------------------------------------------------------
import { POST } from "@/app/api/report-issue/route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function seedMessage(
  db: ReturnType<typeof drizzle<typeof schema>>,
  conversationId: string,
  overrides: Partial<typeof schema.messages.$inferInsert> = {},
) {
  const id = `msg-${Math.random().toString(36).slice(2)}`;
  const now = new Date();
  db.insert(schema.messages)
    .values({
      id,
      conversationId,
      role: "user",
      content: "Hello assistant",
      createdAt: now,
      ...overrides,
    })
    .run();
  return id;
}

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/report-issue", {
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
  mockFetch.mockReset();
  // Default: GITHUB_TOKEN unset so we test the no-token path by default
  delete process.env.GITHUB_TOKEN;
  logInfoSpy = vi.spyOn(loggerModule.logger, "info").mockClear();
});

afterEach(() => {
  sqlite.close();
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------
describe("POST /api/report-issue — auth", () => {
  it("returns 401 when not authenticated", async () => {
    const res = await POST(makeRequest({ conversationId: "x", description: "test" }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------
describe("POST /api/report-issue — validation", () => {
  it("returns 400 when conversationId is missing", async () => {
    const uid = seedUser(testDb);
    mockState.sessionCookie = seedSession(testDb, uid);

    const res = await POST(makeRequest({ description: "something broke" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/conversationId/i);
  });

  it("returns 400 when description is missing", async () => {
    const uid = seedUser(testDb);
    mockState.sessionCookie = seedSession(testDb, uid);

    const res = await POST(makeRequest({ conversationId: "c1" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/description/i);
  });

  it("returns 400 when description is blank", async () => {
    const uid = seedUser(testDb);
    mockState.sessionCookie = seedSession(testDb, uid);

    const res = await POST(makeRequest({ conversationId: "c1", description: "   " }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Conversation access control
// ---------------------------------------------------------------------------
describe("POST /api/report-issue — access control", () => {
  it("returns 404 for a conversation that doesn't exist", async () => {
    const uid = seedUser(testDb);
    mockState.sessionCookie = seedSession(testDb, uid);

    const res = await POST(makeRequest({ conversationId: "nonexistent", description: "broken" }));
    expect(res.status).toBe(404);
  });

  it("returns 404 when a regular user tries to report another user's conversation", async () => {
    const uid1 = seedUser(testDb, { plexId: "u1", plexUsername: "user1" });
    const uid2 = seedUser(testDb, { plexId: "u2", plexUsername: "user2" });
    mockState.sessionCookie = seedSession(testDb, uid1);
    const convId = seedConversation(testDb, uid2, "Other's chat");

    const res = await POST(makeRequest({ conversationId: convId, description: "broken" }));
    expect(res.status).toBe(404);
  });

  it("allows admin to report on another user's conversation", async () => {
    const adminId = seedUser(testDb, { plexId: "admin", plexUsername: "admin", isAdmin: true });
    const userId = seedUser(testDb, { plexId: "u2", plexUsername: "user2" });
    mockState.sessionCookie = seedSession(testDb, adminId);
    const convId = seedConversation(testDb, userId, "User's chat");
    seedMessage(testDb, convId);

    // No GitHub token — fallback path
    const res = await POST(makeRequest({ conversationId: convId, description: "something wrong" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Successful report — no GitHub token configured
// ---------------------------------------------------------------------------
describe("POST /api/report-issue — no GitHub token", () => {
  it("returns 200 and logs the report when no GitHub token is set", async () => {
    const uid = seedUser(testDb, { plexUsername: "reporter" });
    mockState.sessionCookie = seedSession(testDb, uid);
    const convId = seedConversation(testDb, uid, "My conversation");
    seedMessage(testDb, convId, { role: "user", content: "Hello" });
    seedMessage(testDb, convId, { role: "assistant", content: "Hi there!" });

    const res = await POST(makeRequest({ conversationId: convId, description: "AI gave wrong answer" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.message).toMatch(/logged/i);
    // No fetch calls should have been made
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Successful report — GitHub token configured
// ---------------------------------------------------------------------------
describe("POST /api/report-issue — GitHub integration", () => {
  beforeEach(() => {
    process.env.GITHUB_TOKEN = "ghp_test_token";
    process.env.GITHUB_OWNER = "testowner";
    process.env.GITHUB_REPO = "testrepo";
  });

  afterEach(() => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_OWNER;
    delete process.env.GITHUB_REPO;
  });

  it("creates a GitHub issue and returns the issue URL", async () => {
    const uid = seedUser(testDb, { plexUsername: "reporter" });
    mockState.sessionCookie = seedSession(testDb, uid);
    const convId = seedConversation(testDb, uid, "Broken chat");
    seedMessage(testDb, convId, { role: "user", content: "What movies?" });
    seedMessage(testDb, convId, { role: "assistant", content: "Here are some movies..." });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ html_url: "https://github.com/testowner/testrepo/issues/1", number: 1 }),
    });

    const res = await POST(makeRequest({ conversationId: convId, description: "Response was wrong" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.issueUrl).toBe("https://github.com/testowner/testrepo/issues/1");

    // Verify GitHub API was called correctly
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/testowner/testrepo/issues");
    const requestBody = JSON.parse(init.body as string);
    expect(requestBody.labels).toContain("user-reported");
    expect(requestBody.title).toContain("reporter");
    expect(requestBody.body).toContain(convId);
    expect(requestBody.body).toContain("Response was wrong");
  });

  it("includes transcript content in the GitHub issue body", async () => {
    const uid = seedUser(testDb, { plexUsername: "alice" });
    mockState.sessionCookie = seedSession(testDb, uid);
    const convId = seedConversation(testDb, uid, "Test conv");
    seedMessage(testDb, convId, { role: "user", content: "Can you find Inception?" });
    seedMessage(testDb, convId, { role: "assistant", content: "Here is Inception..." });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ html_url: "https://github.com/testowner/testrepo/issues/2", number: 2 }),
    });

    await POST(makeRequest({ conversationId: convId, description: "Wrong result" }));

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const requestBody = JSON.parse(init.body as string);
    expect(requestBody.body).toContain("Can you find Inception?");
    expect(requestBody.body).toContain("Here is Inception...");
  });

  it("returns 502 when the GitHub API responds with an error", async () => {
    const uid = seedUser(testDb, { plexUsername: "reporter" });
    mockState.sessionCookie = seedSession(testDb, uid);
    const convId = seedConversation(testDb, uid, "Chat");
    seedMessage(testDb, convId);

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "Bad credentials",
    });

    const res = await POST(makeRequest({ conversationId: convId, description: "broken" }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("returns 502 when fetch throws a network error", async () => {
    const uid = seedUser(testDb, { plexUsername: "reporter" });
    mockState.sessionCookie = seedSession(testDb, uid);
    const convId = seedConversation(testDb, uid, "Chat");
    seedMessage(testDb, convId);

    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const res = await POST(makeRequest({ conversationId: convId, description: "broken" }));
    expect(res.status).toBe(502);
  });

  it("logs full issue details before attempting GitHub even when GitHub fails", async () => {
    const uid = seedUser(testDb, { plexUsername: "alice" });
    mockState.sessionCookie = seedSession(testDb, uid);
    const convId = seedConversation(testDb, uid, "Broken chat");
    seedMessage(testDb, convId, { role: "user", content: "What is 2+2?" });

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => "Forbidden",
    });

    const res = await POST(makeRequest({ conversationId: convId, description: "Wrong answer given" }));
    expect(res.status).toBe(502);

    // Full report must have been logged before the GitHub call
    const submittedCall = logInfoSpy.mock.calls.find(
      (args) => typeof args[0] === "string" && args[0].includes("report-issue: report logged"),
    );
    expect(submittedCall).toBeDefined();
    const meta = submittedCall![1] as Record<string, unknown>;
    expect(meta.description).toBe("Wrong answer given");
    expect(typeof meta.issueBody).toBe("string");
    expect((meta.issueBody as string)).toContain("What is 2+2?");
    expect((meta.issueBody as string)).toContain(convId);
    // version and baseUrl must appear in log metadata and issue body
    expect(typeof meta.version).toBe("string");
    expect(typeof meta.baseUrl).toBe("string");
    expect((meta.issueBody as string)).toContain("Version");
    expect((meta.issueBody as string)).toContain("Base URL");
  });
});
