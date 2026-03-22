/**
 * Tests for non-admin user access controls — issue #122.
 *
 * Covers:
 * 1. Settings page API endpoints return 403 for non-admin users.
 * 2. Users management endpoint returns 403 for non-admin users.
 * 3. Conversations: non-admin can only access their own conversations
 *    (the ?all=true restriction is already tested in conversations.test.ts;
 *    this file adds focused non-admin assertions as requested in #122).
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
// Config mock — settings route reads from config
// ---------------------------------------------------------------------------
vi.mock("@/lib/config", () => ({
  getConfig: vi.fn(() => null),
  setConfig: vi.fn(),
  getRateLimit: vi.fn(() => ({ messages: 100, period: "day" })),
  getPeriodStart: vi.fn(() => new Date(0)),
  getNextPeriodStart: vi.fn(() => new Date()),
  countUserMessagesSince: vi.fn(() => 0),
  setRateLimit: vi.fn(),
}));

vi.mock("@/lib/security/api-rate-limit", () => ({
  checkUserApiRateLimit: vi.fn(() => true),
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/security/url-validation", () => ({
  validateServiceUrl: vi.fn(() => ({ valid: true })),
}));

// ---------------------------------------------------------------------------
// Route imports (after mocks)
// ---------------------------------------------------------------------------
import { GET as settingsGET, PATCH as settingsPATCH } from "@/app/api/settings/route";
import { GET as usersGET } from "@/app/api/settings/users/route";
import { GET as conversationsGET } from "@/app/api/conversations/route";

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
// Settings route — admin-only
// ---------------------------------------------------------------------------

describe("GET /api/settings — non-admin access control", () => {
  it("returns 403 for an unauthenticated request", async () => {
    const res = await settingsGET();
    expect(res.status).toBe(403);
  });

  it("returns 403 when a non-admin user calls GET /api/settings", async () => {
    const uid = seedUser(testDb, { plexId: "nonadmin", plexUsername: "nonadmin", isAdmin: false });
    mockState.sessionCookie = seedSession(testDb, uid);

    const res = await settingsGET();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("returns 200 when an admin user calls GET /api/settings", async () => {
    const uid = seedUser(testDb, { plexId: "adminuser", plexUsername: "adminuser", isAdmin: true });
    mockState.sessionCookie = seedSession(testDb, uid);

    const res = await settingsGET();
    expect(res.status).toBe(200);
  });
});

describe("PATCH /api/settings — non-admin access control", () => {
  it("returns 403 when a non-admin user calls PATCH /api/settings", async () => {
    const uid = seedUser(testDb, { plexId: "nonadmin2", plexUsername: "nonadmin2", isAdmin: false });
    mockState.sessionCookie = seedSession(testDb, uid);

    const req = new Request("http://localhost/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await settingsPATCH(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Users route — admin-only
// ---------------------------------------------------------------------------

describe("GET /api/settings/users — non-admin access control", () => {
  it("returns 403 when a non-admin user calls GET /api/settings/users", async () => {
    const uid = seedUser(testDb, { plexId: "nonadmin3", plexUsername: "nonadmin3", isAdmin: false });
    mockState.sessionCookie = seedSession(testDb, uid);

    const res = await usersGET();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("returns 200 when an admin user calls GET /api/settings/users", async () => {
    const uid = seedUser(testDb, { plexId: "admin2", plexUsername: "admin2", isAdmin: true });
    mockState.sessionCookie = seedSession(testDb, uid);

    const res = await usersGET();
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Conversations — non-admin can only see own conversations
// ---------------------------------------------------------------------------

describe("GET /api/conversations — non-admin sees only their own conversations", () => {
  it("non-admin user sees their own conversations", async () => {
    const uid = seedUser(testDb, { plexId: "u1", plexUsername: "user1", isAdmin: false });
    mockState.sessionCookie = seedSession(testDb, uid);
    seedConversation(testDb, uid, "My Chat");

    const req = new Request("http://localhost/api/conversations");
    const res = await conversationsGET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].title).toBe("My Chat");
  });

  it("non-admin user does not see other users' conversations", async () => {
    const uid1 = seedUser(testDb, { plexId: "u2", plexUsername: "user2", isAdmin: false });
    const uid2 = seedUser(testDb, { plexId: "u3", plexUsername: "user3", isAdmin: false });
    mockState.sessionCookie = seedSession(testDb, uid1);
    seedConversation(testDb, uid2, "Other User's Chat");

    const req = new Request("http://localhost/api/conversations");
    const res = await conversationsGET(req);
    const body = await res.json();
    expect(body.data).toHaveLength(0);
  });

  it("non-admin with ?all=true is ignored and only returns their own conversations", async () => {
    const uid1 = seedUser(testDb, { plexId: "u4", plexUsername: "user4", isAdmin: false });
    const uid2 = seedUser(testDb, { plexId: "u5", plexUsername: "user5", isAdmin: false });
    mockState.sessionCookie = seedSession(testDb, uid1);
    seedConversation(testDb, uid1, "Mine");
    seedConversation(testDb, uid2, "Not Mine");

    const req = new Request("http://localhost/api/conversations?all=true");
    const res = await conversationsGET(req);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].title).toBe("Mine");
  });

  it("admin with ?all=true sees all conversations", async () => {
    const adminId = seedUser(testDb, { plexId: "adm", plexUsername: "admin", isAdmin: true });
    const userId = seedUser(testDb, { plexId: "usr", plexUsername: "user", isAdmin: false });
    mockState.sessionCookie = seedSession(testDb, adminId);
    seedConversation(testDb, adminId, "Admin Convo");
    seedConversation(testDb, userId, "User Convo");

    const req = new Request("http://localhost/api/conversations?all=true");
    const res = await conversationsGET(req);
    const body = await res.json();
    expect(body.data.length).toBeGreaterThanOrEqual(2);
    const titles = body.data.map((c: { title: string }) => c.title);
    expect(titles).toContain("Admin Convo");
    expect(titles).toContain("User Convo");
  });
});
