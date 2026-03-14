/**
 * Integration tests for /api/conversations
 *
 * These tests call the Next.js route handlers directly with a real
 * in-memory SQLite database.  next/headers is mocked so we can control
 * which session cookie is presented.
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
// DB mock — must be declared before any import that touches @/lib/db
// ---------------------------------------------------------------------------
let sqlite: Database.Database;
let testDb: ReturnType<typeof drizzle<typeof schema>>;

vi.mock("@/lib/db", () => ({ getDb: () => testDb, schema }));

// ---------------------------------------------------------------------------
// next/headers mock — cookies() returns whatever mockState.sessionCookie holds
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
// Route handlers (imported after mocks)
// ---------------------------------------------------------------------------
import { GET, POST } from "@/app/api/conversations/route";

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  testDb = drizzle(sqlite, { schema });
  migrate(testDb, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  mockState.sessionCookie = undefined;
});

afterEach(() => {
  sqlite.close();
});

// ---------------------------------------------------------------------------
// GET /api/conversations
// ---------------------------------------------------------------------------

describe("GET /api/conversations", () => {
  it("returns 401 when no session cookie is present", async () => {
    const req = new Request("http://localhost/api/conversations");
    const res = await GET(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("returns 401 for an expired session", async () => {
    const uid = seedUser(testDb);
    const expiredId = "expired-session";
    testDb
      .insert(schema.sessions)
      .values({
        id: expiredId,
        userId: uid,
        expiresAt: new Date(Date.now() - 1000), // already expired
        createdAt: new Date(),
      })
      .run();
    mockState.sessionCookie = expiredId;

    const req = new Request("http://localhost/api/conversations");
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("returns an empty array when the user has no conversations", async () => {
    const uid = seedUser(testDb);
    mockState.sessionCookie = seedSession(testDb, uid);

    const req = new Request("http://localhost/api/conversations");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(0);
  });

  it("returns the user's own conversations", async () => {
    const uid = seedUser(testDb);
    mockState.sessionCookie = seedSession(testDb, uid);
    seedConversation(testDb, uid, "My Chat");

    const req = new Request("http://localhost/api/conversations");
    const res = await GET(req);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].title).toBe("My Chat");
  });

  it("does not return conversations belonging to other users", async () => {
    const uid1 = seedUser(testDb, { plexId: "p1", plexUsername: "user1" });
    const uid2 = seedUser(testDb, { plexId: "p2", plexUsername: "user2" });
    mockState.sessionCookie = seedSession(testDb, uid1);
    seedConversation(testDb, uid2, "Other User's Chat");

    const req = new Request("http://localhost/api/conversations");
    const res = await GET(req);
    const body = await res.json();
    expect(body.data).toHaveLength(0);
  });

  it("admin with ?all=true sees all users' conversations", async () => {
    const adminId = seedUser(testDb, { plexId: "admin", plexUsername: "admin", isAdmin: true });
    const userId = seedUser(testDb, { plexId: "user", plexUsername: "user", isAdmin: false });
    mockState.sessionCookie = seedSession(testDb, adminId);
    seedConversation(testDb, adminId, "Admin Chat");
    seedConversation(testDb, userId, "User Chat");

    const req = new Request("http://localhost/api/conversations?all=true");
    const res = await GET(req);
    const body = await res.json();
    expect(body.data.length).toBeGreaterThanOrEqual(2);
    const titles = body.data.map((c: { title: string }) => c.title);
    expect(titles).toContain("Admin Chat");
    expect(titles).toContain("User Chat");
  });

  it("non-admin with ?all=true only sees their own conversations", async () => {
    const uid1 = seedUser(testDb, { plexId: "na1", plexUsername: "na1" });
    const uid2 = seedUser(testDb, { plexId: "na2", plexUsername: "na2" });
    mockState.sessionCookie = seedSession(testDb, uid1);
    seedConversation(testDb, uid1, "Mine");
    seedConversation(testDb, uid2, "Not Mine");

    const req = new Request("http://localhost/api/conversations?all=true");
    const res = await GET(req);
    const body = await res.json();
    // Non-admin cannot use ?all=true — should only see own conversations
    expect(body.data).toHaveLength(1);
    expect(body.data[0].title).toBe("Mine");
  });
});

// ---------------------------------------------------------------------------
// POST /api/conversations
// ---------------------------------------------------------------------------

describe("POST /api/conversations", () => {
  it("returns 401 when unauthenticated", async () => {
    const req = new Request("http://localhost/api/conversations", { method: "POST" });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("creates a conversation with default title", async () => {
    const uid = seedUser(testDb);
    mockState.sessionCookie = seedSession(testDb, uid);

    const req = new Request("http://localhost/api/conversations", { method: "POST" });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.title).toBe("New Chat");
    expect(typeof body.data.id).toBe("string");
    expect(body.data.id.length).toBeGreaterThan(0);
  });

  it("creates a conversation with a provided title", async () => {
    const uid = seedUser(testDb);
    mockState.sessionCookie = seedSession(testDb, uid);

    const req = new Request("http://localhost/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Weekend Movies" }),
    });
    const res = await POST(req);
    const body = await res.json();
    expect(body.data.title).toBe("Weekend Movies");
  });

  it("persists the conversation so GET returns it", async () => {
    const uid = seedUser(testDb);
    mockState.sessionCookie = seedSession(testDb, uid);

    await POST(new Request("http://localhost/api/conversations", { method: "POST" }));

    const getRes = await GET(new Request("http://localhost/api/conversations"));
    const body = await getRes.json();
    expect(body.data).toHaveLength(1);
  });

  it("response includes ownerName for sidebar optimistic update", async () => {
    const uid = seedUser(testDb, { plexUsername: "foobar" });
    mockState.sessionCookie = seedSession(testDb, uid);

    const req = new Request("http://localhost/api/conversations", { method: "POST" });
    const res = await POST(req);
    const body = await res.json();
    expect(body.data.ownerName).toBe("foobar");
  });
});
