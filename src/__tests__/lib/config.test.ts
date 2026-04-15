import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "@/lib/db/schema";
import path from "path";

// ---------------------------------------------------------------------------
// In-memory DB — must be declared before vi.mock so the factory closure sees it
// ---------------------------------------------------------------------------
let sqlite: Database.Database;
let testDb: ReturnType<typeof drizzle<typeof schema>>;

vi.mock("@/lib/db", () => ({
  getDb: () => testDb,
  schema,
}));

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  testDb = drizzle(sqlite, { schema });
  migrate(testDb, { migrationsFolder: path.join(process.cwd(), "drizzle") });
});

afterEach(() => {
  sqlite.close();
});

// ---------------------------------------------------------------------------
// Import after mock registration (hoisted in test files)
// ---------------------------------------------------------------------------
import {
  getConfig,
  setConfig,
  getConfigMap,
  isSetupComplete,
  getRateLimit,
  setRateLimit,
  getPeriodStart,
  getNextPeriodStart,
  countUserMessagesSince,
  getUserMcpToken,
  setUserMcpToken,
  getUserIdByMcpToken,
} from "@/lib/config";

// ---------------------------------------------------------------------------
// Basic config CRUD
// ---------------------------------------------------------------------------

describe("getConfig / setConfig", () => {
  it("returns null for a missing key", () => {
    expect(getConfig("does.not.exist")).toBeNull();
  });

  it("stores and retrieves a plain value", () => {
    setConfig("test.key", "hello");
    expect(getConfig("test.key")).toBe("hello");
  });

  it("updates an existing key", () => {
    setConfig("update.key", "first");
    setConfig("update.key", "second");
    expect(getConfig("update.key")).toBe("second");
  });

  it("getConfigMap returns all requested keys", () => {
    setConfig("a", "1");
    setConfig("b", "2");
    const map = getConfigMap(["a", "b", "c"]);
    expect(map["a"]).toBe("1");
    expect(map["b"]).toBe("2");
    expect(map["c"]).toBeNull();
  });
});

describe("isSetupComplete", () => {
  it("returns false on a fresh database", () => {
    expect(isSetupComplete()).toBe(false);
  });

  it("returns true after setup.complete is set", () => {
    setConfig("setup.complete", "true");
    expect(isSetupComplete()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rate limit storage
// ---------------------------------------------------------------------------

describe("getRateLimit / setRateLimit", () => {
  it("returns the default (100 msg/day) when no limit is set", () => {
    expect(getRateLimit(9999)).toEqual({ messages: 100, period: "day" });
  });

  it("stores and retrieves a custom rate limit", () => {
    setRateLimit(1, { messages: 50, period: "week" });
    expect(getRateLimit(1)).toEqual({ messages: 50, period: "week" });
  });

  it("handles all valid period values", () => {
    const periods = ["hour", "day", "week", "month"] as const;
    for (const period of periods) {
      setRateLimit(2, { messages: 10, period });
      expect(getRateLimit(2).period).toBe(period);
    }
  });
});

// ---------------------------------------------------------------------------
// Period boundary calculations (pure functions — no DB)
// ---------------------------------------------------------------------------

describe("getPeriodStart", () => {
  it("hour: zeroes minutes and seconds", () => {
    const start = getPeriodStart("hour");
    const now = new Date();
    expect(start.getHours()).toBe(now.getHours());
    expect(start.getMinutes()).toBe(0);
    expect(start.getSeconds()).toBe(0);
    expect(start.getMilliseconds()).toBe(0);
  });

  it("day: zeroes hours, minutes, and seconds", () => {
    const start = getPeriodStart("day");
    const now = new Date();
    expect(start.getDate()).toBe(now.getDate());
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    expect(start.getSeconds()).toBe(0);
  });

  it("week: returns a Monday at midnight", () => {
    const start = getPeriodStart("week");
    // Day 1 = Monday in JS (getDay returns 0=Sun, 1=Mon, …)
    expect(start.getDay()).toBe(1);
    expect(start.getHours()).toBe(0);
  });

  it("month: returns the 1st of the current month at midnight", () => {
    const start = getPeriodStart("month");
    const now = new Date();
    expect(start.getFullYear()).toBe(now.getFullYear());
    expect(start.getMonth()).toBe(now.getMonth());
    expect(start.getDate()).toBe(1);
    expect(start.getHours()).toBe(0);
  });
});

describe("getNextPeriodStart", () => {
  it("is strictly after getPeriodStart for every period", () => {
    const periods = ["hour", "day", "week", "month"] as const;
    for (const period of periods) {
      const start = getPeriodStart(period);
      const next = getNextPeriodStart(period);
      expect(next.getTime(), `period=${period}`).toBeGreaterThan(start.getTime());
    }
  });

  it("next hour is exactly 1 hour after current hour start", () => {
    const start = getPeriodStart("hour");
    const next = getNextPeriodStart("hour");
    expect(next.getTime() - start.getTime()).toBe(60 * 60 * 1000);
  });

  it("next day is exactly 24 h after current day start", () => {
    const start = getPeriodStart("day");
    const next = getNextPeriodStart("day");
    expect(next.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it("next week is exactly 7 days after current week start", () => {
    const start = getPeriodStart("week");
    const next = getNextPeriodStart("week");
    expect(next.getTime() - start.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// Per-user MCP tokens
// ---------------------------------------------------------------------------

describe("getUserMcpToken / setUserMcpToken / getUserIdByMcpToken", () => {
  function insertUser(plexId: string): number {
    const r = testDb
      .insert(schema.users)
      .values({ plexId, plexUsername: plexId, isAdmin: false, createdAt: new Date() })
      .run();
    return Number(r.lastInsertRowid);
  }

  it("returns null when no token has been set", () => {
    expect(getUserMcpToken(9999)).toBeNull();
  });

  it("stores and retrieves a token", () => {
    const uid = insertUser("mcp-user-1");
    setUserMcpToken(uid, "abc123");
    expect(getUserMcpToken(uid)).toBe("abc123");
  });

  it("getUserIdByMcpToken returns the correct user id", () => {
    const uid = insertUser("mcp-user-2");
    setUserMcpToken(uid, "tok-xyz");
    expect(getUserIdByMcpToken("tok-xyz")).toBe(uid);
  });

  it("getUserIdByMcpToken returns null for an unknown token", () => {
    expect(getUserIdByMcpToken("no-such-token")).toBeNull();
  });

  it("different users have independent tokens", () => {
    const uid1 = insertUser("mcp-user-3");
    const uid2 = insertUser("mcp-user-4");
    setUserMcpToken(uid1, "token-for-user1");
    setUserMcpToken(uid2, "token-for-user2");
    expect(getUserIdByMcpToken("token-for-user1")).toBe(uid1);
    expect(getUserIdByMcpToken("token-for-user2")).toBe(uid2);
  });

  it("token update is reflected in lookup", () => {
    const uid = insertUser("mcp-user-5");
    setUserMcpToken(uid, "old-token");
    setUserMcpToken(uid, "new-token");
    expect(getUserIdByMcpToken("old-token")).toBeNull();
    expect(getUserIdByMcpToken("new-token")).toBe(uid);
  });

  it("getUserMcpToken returns null if only app_config has the token (pre-migration state)", () => {
    // Simulate a user whose token was never written to users.mcp_token (pre-0002 schema)
    const uid = insertUser("mcp-user-6");
    setConfig(`user.${uid}.mcpToken`, "legacy-token");
    // getUserMcpToken reads from users.mcp_token, not app_config — returns null
    expect(getUserMcpToken(uid)).toBeNull();
    // getUserIdByMcpToken also returns null — token is not yet active
    expect(getUserIdByMcpToken("legacy-token")).toBeNull();
  });

  it("backfill: writing token to users.mcp_token activates legacy app_config token", () => {
    const uid = insertUser("mcp-user-7");
    setConfig(`user.${uid}.mcpToken`, "legacy-token");
    // Backfill path: read from app_config, write to users.mcp_token via setUserMcpToken
    setUserMcpToken(uid, "legacy-token");
    expect(getUserMcpToken(uid)).toBe("legacy-token");
    expect(getUserIdByMcpToken("legacy-token")).toBe(uid);
  });
});

// ---------------------------------------------------------------------------
// countUserMessagesSince — requires real data
// ---------------------------------------------------------------------------

describe("countUserMessagesSince", () => {
  function insertUser(plexId: string): number {
    const r = testDb
      .insert(schema.users)
      .values({ plexId, plexUsername: plexId, isAdmin: false, createdAt: new Date() })
      .run();
    return Number(r.lastInsertRowid);
  }

  function insertConversation(userId: number): string {
    const id = `conv-${Math.random().toString(36).slice(2)}`;
    const now = new Date();
    testDb.insert(schema.conversations).values({ id, userId, title: "t", createdAt: now, updatedAt: now }).run();
    return id;
  }

  function insertMessage(convId: string, role: "user" | "assistant", at: Date): void {
    testDb.insert(schema.messages)
      .values({
        id: `msg-${Math.random().toString(36).slice(2)}`,
        conversationId: convId,
        role,
        createdAt: at,
      })
      .run();
  }

  it("returns 0 when the user has sent no messages", () => {
    const uid = insertUser("empty-user");
    insertConversation(uid);
    expect(countUserMessagesSince(uid, new Date(0))).toBe(0);
  });

  it("counts only user-role messages (not assistant)", () => {
    const uid = insertUser("count-user");
    const convId = insertConversation(uid);
    const past = new Date(Date.now() - 60_000);
    insertMessage(convId, "user", new Date());
    insertMessage(convId, "user", new Date());
    insertMessage(convId, "assistant", new Date());
    expect(countUserMessagesSince(uid, past)).toBe(2);
  });

  it("only counts messages sent after the since date", () => {
    const uid = insertUser("since-user");
    const convId = insertConversation(uid);
    const oldMsg = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 h ago
    const since = new Date(Date.now() - 60 * 60 * 1000); // 1 h ago
    insertMessage(convId, "user", oldMsg); // before window — should not count
    insertMessage(convId, "user", new Date()); // inside window
    expect(countUserMessagesSince(uid, since)).toBe(1);
  });

  it("does not count messages from other users", () => {
    const uid1 = insertUser("user-a");
    const uid2 = insertUser("user-b");
    const convId1 = insertConversation(uid1);
    const convId2 = insertConversation(uid2);
    insertMessage(convId1, "user", new Date());
    insertMessage(convId2, "user", new Date());
    expect(countUserMessagesSince(uid1, new Date(0))).toBe(1);
    expect(countUserMessagesSince(uid2, new Date(0))).toBe(1);
  });
});
