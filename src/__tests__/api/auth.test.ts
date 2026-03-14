/**
 * Integration tests for the Plex OAuth login flow
 *
 * Covers:
 *   POST /api/auth/plex     — request a PIN from Plex
 *   POST /api/auth/callback — exchange a claimed PIN for a session
 *
 * External Plex HTTP calls are intercepted via vi.mock so no network is
 * needed and tests are fully deterministic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "@/lib/db/schema";
import path from "path";

// ---------------------------------------------------------------------------
// DB mock
// ---------------------------------------------------------------------------
let sqlite: Database.Database;
let testDb: ReturnType<typeof drizzle<typeof schema>>;

vi.mock("@/lib/db", () => ({ getDb: () => testDb, schema }));

// ---------------------------------------------------------------------------
// Plex HTTP service mock — intercepts all external Plex API calls
// ---------------------------------------------------------------------------
vi.mock("@/lib/services/plex-auth", () => ({
  createPlexPin: vi.fn(),
  checkPlexPin: vi.fn(),
  getPlexUser: vi.fn(),
  checkUserHasLibraryAccess: vi.fn(),
}));

// ---------------------------------------------------------------------------
// next/headers mock — needed by createSession (sets the session cookie)
// ---------------------------------------------------------------------------
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  })),
  headers: vi.fn(async () => ({
    get: vi.fn().mockReturnValue(null),
  })),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------
import { POST as plexPinPOST } from "@/app/api/auth/plex/route";
import { POST as callbackPOST } from "@/app/api/auth/callback/route";
import {
  createPlexPin,
  checkPlexPin,
  getPlexUser,
  checkUserHasLibraryAccess,
} from "@/lib/services/plex-auth";
import { cookies, headers } from "next/headers";
import { _resetRateLimits } from "@/lib/auth/rate-limit";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const MOCK_PLEX_USER = {
  id: "plex-user-42",
  username: "mediauser",
  email: "media@example.com",
  thumb: "https://plex.tv/avatar/mediauser",
  authToken: "plex-auth-token-abc",
};

function seedAdmin() {
  testDb
    .insert(schema.users)
    .values({ plexId: "plex-admin-1", plexUsername: "admin", isAdmin: true, createdAt: new Date() })
    .run();
}

function setPlexConfig() {
  const now = new Date();
  testDb.insert(schema.appConfig).values({ key: "plex.url", value: "http://plex.local", updatedAt: now }).run();
  testDb.insert(schema.appConfig).values({ key: "plex.token", value: "admin-token", updatedAt: now }).run();
}

function callbackReq(pinId: number) {
  return new Request("http://localhost/api/auth/callback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pinId }),
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
  _resetRateLimits();
  vi.clearAllMocks();
});

afterEach(() => {
  sqlite.close();
});

// ---------------------------------------------------------------------------
// POST /api/auth/plex — request a PIN
// ---------------------------------------------------------------------------

describe("POST /api/auth/plex", () => {
  it("returns the PIN from Plex on success", async () => {
    const mockPin = { id: 123, code: "abc123", authUrl: "https://app.plex.tv/auth#?code=abc123" };
    vi.mocked(createPlexPin).mockResolvedValue(mockPin);

    const res = await plexPinPOST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toEqual(mockPin);
  });

  it("returns 502 when Plex is unreachable", async () => {
    vi.mocked(createPlexPin).mockRejectedValue(new Error("connect ECONNREFUSED"));

    const res = await plexPinPOST();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain("connect ECONNREFUSED");
  });
});

// ---------------------------------------------------------------------------
// POST /api/auth/callback — exchange PIN for session
// ---------------------------------------------------------------------------

describe("POST /api/auth/callback — rate limiting", () => {
  it("returns 429 after 10 failed attempts from the same IP", async () => {
    vi.mocked(checkPlexPin).mockResolvedValue(null); // always pending

    for (let i = 0; i < 10; i++) {
      await callbackPOST(callbackReq(i));
    }

    const res = await callbackPOST(callbackReq(99));
    expect(res.status).toBe(429);
  });
});

describe("POST /api/auth/callback — validation", () => {
  it("returns 400 when pinId is missing", async () => {
    const req = new Request("http://localhost/api/auth/callback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await callbackPOST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON body", async () => {
    const req = new Request("http://localhost/api/auth/callback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    const res = await callbackPOST(req);
    expect(res.status).toBe(400);
  });
});

describe("POST /api/auth/callback — PIN status", () => {
  it("returns pending error when PIN is not yet claimed", async () => {
    vi.mocked(checkPlexPin).mockResolvedValue(null);

    const res = await callbackPOST(callbackReq(123));
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe("pending");
  });
});

describe("POST /api/auth/callback — first user becomes admin", () => {
  it("creates the first user with isAdmin=true", async () => {
    vi.mocked(checkPlexPin).mockResolvedValue("auth-token");
    vi.mocked(getPlexUser).mockResolvedValue(MOCK_PLEX_USER);

    const res = await callbackPOST(callbackReq(1));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.user.isAdmin).toBe(true);

    const row = sqlite
      .prepare("SELECT is_admin FROM users WHERE plex_id = ?")
      .get(MOCK_PLEX_USER.id) as { is_admin: number };
    expect(row.is_admin).toBe(1);
  });

  it("creates a session record in the database", async () => {
    vi.mocked(checkPlexPin).mockResolvedValue("auth-token");
    vi.mocked(getPlexUser).mockResolvedValue(MOCK_PLEX_USER);

    await callbackPOST(callbackReq(1));

    const sessions = sqlite.prepare("SELECT * FROM sessions").all();
    expect(sessions).toHaveLength(1);
  });
});

describe("POST /api/auth/callback — subsequent users", () => {
  beforeEach(() => {
    seedAdmin();
    setPlexConfig();
  });

  it("creates a second user as non-admin when they have library access", async () => {
    vi.mocked(checkPlexPin).mockResolvedValue("auth-token-2");
    vi.mocked(getPlexUser).mockResolvedValue({ ...MOCK_PLEX_USER, id: "plex-user-2", username: "user2" });
    vi.mocked(checkUserHasLibraryAccess).mockResolvedValue(true);

    const res = await callbackPOST(callbackReq(2));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.user.isAdmin).toBe(false);

    const row = sqlite
      .prepare("SELECT is_admin FROM users WHERE plex_id = 'plex-user-2'")
      .get() as { is_admin: number };
    expect(row.is_admin).toBe(0);
  });

  it("rejects a user who has no library access with 403", async () => {
    vi.mocked(checkPlexPin).mockResolvedValue("auth-token-denied");
    vi.mocked(getPlexUser).mockResolvedValue({ ...MOCK_PLEX_USER, id: "plex-denied" });
    vi.mocked(checkUserHasLibraryAccess).mockResolvedValue(false);

    const res = await callbackPOST(callbackReq(3));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.success).toBe(false);

    // Critical: denied user must NOT be persisted
    const row = sqlite.prepare("SELECT * FROM users WHERE plex_id = 'plex-denied'").get();
    expect(row).toBeUndefined();
  });

  it("calls the library access check against the configured Plex server", async () => {
    vi.mocked(checkPlexPin).mockResolvedValue("auth-token-3");
    vi.mocked(getPlexUser).mockResolvedValue({ ...MOCK_PLEX_USER, id: "plex-user-3" });
    vi.mocked(checkUserHasLibraryAccess).mockResolvedValue(true);

    await callbackPOST(callbackReq(4));

    expect(checkUserHasLibraryAccess).toHaveBeenCalledWith(
      "http://plex.local",
      "admin-token",
      "plex-user-3",
    );
  });

  it("skips library access check when Plex is not configured", async () => {
    // Remove plex config
    sqlite.prepare("DELETE FROM app_config WHERE key IN ('plex.url', 'plex.token')").run();

    vi.mocked(checkPlexPin).mockResolvedValue("auth-token-4");
    vi.mocked(getPlexUser).mockResolvedValue({ ...MOCK_PLEX_USER, id: "plex-user-4" });

    const res = await callbackPOST(callbackReq(5));
    expect(res.status).toBe(200);
    expect(checkUserHasLibraryAccess).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Cookie Secure flag — SECURE_COOKIES modes
// ---------------------------------------------------------------------------

describe("createSession — SECURE_COOKIES modes", () => {
  const originalEnv = process.env.SECURE_COOKIES;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.SECURE_COOKIES;
    else process.env.SECURE_COOKIES = originalEnv;
  });

  it("sets secure=false by default (no env var)", async () => {
    delete process.env.SECURE_COOKIES;
    const mockSet = vi.fn();
    vi.mocked(cookies).mockResolvedValueOnce({ get: vi.fn(), set: mockSet, delete: vi.fn() } as never);
    vi.mocked(checkPlexPin).mockResolvedValue("token");
    vi.mocked(getPlexUser).mockResolvedValue(MOCK_PLEX_USER);

    await callbackPOST(callbackReq(20));

    const cookieOptions = mockSet.mock.calls[0]?.[2];
    expect(cookieOptions?.secure).toBe(false);
  });

  it("sets secure=true when SECURE_COOKIES=true", async () => {
    process.env.SECURE_COOKIES = "true";
    const mockSet = vi.fn();
    vi.mocked(cookies).mockResolvedValueOnce({ get: vi.fn(), set: mockSet, delete: vi.fn() } as never);
    vi.mocked(checkPlexPin).mockResolvedValue("token");
    vi.mocked(getPlexUser).mockResolvedValue({ ...MOCK_PLEX_USER, id: "plex-secure" });

    await callbackPOST(callbackReq(21));

    const cookieOptions = mockSet.mock.calls[0]?.[2];
    expect(cookieOptions?.secure).toBe(true);
  });

  it("sets secure=true in auto mode when X-Forwarded-Proto is https", async () => {
    process.env.SECURE_COOKIES = "auto";
    const mockSet = vi.fn();
    vi.mocked(cookies).mockResolvedValueOnce({ get: vi.fn(), set: mockSet, delete: vi.fn() } as never);
    vi.mocked(headers).mockResolvedValueOnce({ get: (h: string) => h === "x-forwarded-proto" ? "https" : null } as never);
    vi.mocked(checkPlexPin).mockResolvedValue("token");
    vi.mocked(getPlexUser).mockResolvedValue({ ...MOCK_PLEX_USER, id: "plex-auto-https" });

    await callbackPOST(callbackReq(22));

    const cookieOptions = mockSet.mock.calls[0]?.[2];
    expect(cookieOptions?.secure).toBe(true);
  });

  it("sets secure=false in auto mode when X-Forwarded-Proto is http", async () => {
    process.env.SECURE_COOKIES = "auto";
    const mockSet = vi.fn();
    vi.mocked(cookies).mockResolvedValueOnce({ get: vi.fn(), set: mockSet, delete: vi.fn() } as never);
    vi.mocked(headers).mockResolvedValueOnce({ get: (h: string) => h === "x-forwarded-proto" ? "http" : null } as never);
    vi.mocked(checkPlexPin).mockResolvedValue("token");
    vi.mocked(getPlexUser).mockResolvedValue({ ...MOCK_PLEX_USER, id: "plex-auto-http" });

    await callbackPOST(callbackReq(23));

    const cookieOptions = mockSet.mock.calls[0]?.[2];
    expect(cookieOptions?.secure).toBe(false);
  });
});

describe("POST /api/auth/callback — returning user", () => {
  it("updates an existing user's profile without creating a duplicate", async () => {
    // Seed existing user
    testDb
      .insert(schema.users)
      .values({
        plexId: MOCK_PLEX_USER.id,
        plexUsername: "old-username",
        plexEmail: "old@example.com",
        isAdmin: true,
        createdAt: new Date(),
      })
      .run();

    vi.mocked(checkPlexPin).mockResolvedValue("new-auth-token");
    vi.mocked(getPlexUser).mockResolvedValue({
      ...MOCK_PLEX_USER,
      username: "updated-username",
      email: "new@example.com",
    });

    const res = await callbackPOST(callbackReq(10));
    expect(res.status).toBe(200);

    const users = sqlite.prepare("SELECT * FROM users").all() as {
      plex_username: string;
      plex_email: string;
    }[];
    expect(users).toHaveLength(1); // no duplicate
    expect(users[0].plex_username).toBe("updated-username");
    expect(users[0].plex_email).toBe("new@example.com");
  });

  it("does not run the library access check for a returning user", async () => {
    seedAdmin(); // different plexId — this is a different admin
    setPlexConfig();

    // Seed the returning user
    testDb
      .insert(schema.users)
      .values({ plexId: MOCK_PLEX_USER.id, plexUsername: "returning", isAdmin: false, createdAt: new Date() })
      .run();

    vi.mocked(checkPlexPin).mockResolvedValue("auth-token-returning");
    vi.mocked(getPlexUser).mockResolvedValue(MOCK_PLEX_USER);

    await callbackPOST(callbackReq(11));

    expect(checkUserHasLibraryAccess).not.toHaveBeenCalled();
  });
});
