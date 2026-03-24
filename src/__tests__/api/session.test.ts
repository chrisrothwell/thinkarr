/**
 * Unit tests for GET and DELETE /api/auth/session
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "@/lib/db/schema";
import path from "path";
import { mockState } from "../helpers/mock-state";
import { seedUser, seedSession } from "../helpers/db";

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
// Logger spy
// ---------------------------------------------------------------------------
import * as loggerModule from "@/lib/logger";
let logInfoSpy: MockInstance;
let logWarnSpy: MockInstance;

// ---------------------------------------------------------------------------
// Route handler (imported after mocks)
// ---------------------------------------------------------------------------
import { GET, DELETE } from "@/app/api/auth/session/route";

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  testDb = drizzle(sqlite, { schema });
  migrate(testDb, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  mockState.sessionCookie = undefined;
  logInfoSpy = vi.spyOn(loggerModule.logger, "info");
  logWarnSpy = vi.spyOn(loggerModule.logger, "warn");
});

afterEach(() => {
  sqlite.close();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// GET /api/auth/session
// ---------------------------------------------------------------------------
describe("GET /api/auth/session", () => {
  it("returns 401 when no session cookie is present", async () => {
    const res = await GET();
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("returns the user when a valid session exists", async () => {
    const uid = seedUser(testDb, { plexUsername: "alice" });
    mockState.sessionCookie = seedSession(testDb, uid);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.user.id).toBe(uid);
  });

  it("returns 401 and logs a warning when the session cookie exists but the session is expired", async () => {
    // Insert an already-expired session directly
    const uid = seedUser(testDb, { plexUsername: "bob" });
    const expiredId = "expired-session-id";
    testDb.insert(schema.sessions).values({
      id: expiredId,
      userId: uid,
      expiresAt: new Date(Date.now() - 1000), // already expired
      createdAt: new Date(),
    }).run();
    mockState.sessionCookie = expiredId;

    const res = await GET();
    expect(res.status).toBe(401);

    const warnCall = logWarnSpy.mock.calls.find(
      (args) => typeof args[0] === "string" && args[0] === "Session expired or not found",
    );
    expect(warnCall).toBeDefined();
    expect(warnCall![1]).toMatchObject({ sessionId: expiredId });
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/auth/session
// ---------------------------------------------------------------------------
describe("DELETE /api/auth/session", () => {
  it("returns 200 and logs the logout when a session exists", async () => {
    const uid = seedUser(testDb, { plexUsername: "alice" });
    mockState.sessionCookie = seedSession(testDb, uid);

    const res = await DELETE();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    const logoutCall = logInfoSpy.mock.calls.find(
      (args) => typeof args[0] === "string" && args[0] === "User logout",
    );
    expect(logoutCall).toBeDefined();
    expect(logoutCall![1]).toMatchObject({ userId: uid, plexUsername: "alice" });
  });

  it("returns 200 without logging when no session exists", async () => {
    const res = await DELETE();
    expect(res.status).toBe(200);

    const logoutCall = logInfoSpy.mock.calls.find(
      (args) => typeof args[0] === "string" && args[0] === "User logout",
    );
    expect(logoutCall).toBeUndefined();
  });
});
