/**
 * Integration tests for /api/setup
 *
 * Tests status reporting and the initial config save flow.
 * POST /api/setup requires an admin session.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "@/lib/db/schema";
import path from "path";

let sqlite: Database.Database;
let testDb: ReturnType<typeof drizzle<typeof schema>>;

vi.mock("@/lib/db", () => ({ getDb: () => testDb, schema }));

const mockAdminSession = {
  sessionId: "test-session",
  user: { id: 1, plexId: "plex1", plexUsername: "admin", plexEmail: "a@b.com", plexAvatarUrl: null, isAdmin: true },
};
const mockUserSession = {
  sessionId: "test-session-2",
  user: { id: 2, plexId: "plex2", plexUsername: "user", plexEmail: "u@b.com", plexAvatarUrl: null, isAdmin: false },
};

const mockGetSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({ getSession: () => mockGetSession() }));

import { GET, POST } from "@/app/api/setup/route";

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  testDb = drizzle(sqlite, { schema });
  migrate(testDb, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  mockGetSession.mockResolvedValue(mockAdminSession);
});

afterEach(() => {
  sqlite.close();
});

// ---------------------------------------------------------------------------
// GET /api/setup
// ---------------------------------------------------------------------------

describe("GET /api/setup", () => {
  it("returns complete=false on a fresh database", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.complete).toBe(false);
  });

  it("all service flags are false on a fresh database", async () => {
    const res = await GET();
    const { data } = await res.json();
    expect(data.hasLlm).toBe(false);
    expect(data.hasPlex).toBe(false);
    expect(data.hasSonarr).toBe(false);
    expect(data.hasRadarr).toBe(false);
    expect(data.hasOverseerr).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// POST /api/setup
// ---------------------------------------------------------------------------

describe("POST /api/setup", () => {
  const validBody = {
    llm: { baseUrl: "http://llm.local", apiKey: "key", model: "gpt-4" },
    plex: { url: "http://plex.local", token: "plextoken" },
  };

  it("returns 403 when not authenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const req = new Request("http://localhost/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it("returns 403 for non-admin user", async () => {
    mockGetSession.mockResolvedValueOnce(mockUserSession);
    const req = new Request("http://localhost/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it("returns 400 for empty body", async () => {
    const req = new Request("http://localhost/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 when LLM config is missing", async () => {
    const req = new Request("http://localhost/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plex: validBody.plex }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/llm/i);
  });

  it("returns 400 when Plex config is missing", async () => {
    const req = new Request("http://localhost/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ llm: validBody.llm }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/plex/i);
  });

  it("saves config and marks setup complete", async () => {
    const req = new Request("http://localhost/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    // Verify GET now shows complete=true and hasLlm/hasPlex=true
    const statusRes = await GET();
    const status = await statusRes.json();
    expect(status.data.complete).toBe(true);
    expect(status.data.hasLlm).toBe(true);
    expect(status.data.hasPlex).toBe(true);
  });

  it("returns 400 if setup is called a second time", async () => {
    const req = () =>
      new Request("http://localhost/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      });

    await POST(req()); // first call — should succeed
    const res = await POST(req()); // second call — should fail
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/already complete/i);
  });

  it("saves optional services when provided", async () => {
    const body = {
      ...validBody,
      sonarr: { url: "http://sonarr.local", apiKey: "sonarr-key" },
      radarr: { url: "http://radarr.local", apiKey: "radarr-key" },
      overseerr: { url: "http://overseerr.local", apiKey: "overseerr-key" },
    };
    const req = new Request("http://localhost/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await POST(req);

    const statusRes = await GET();
    const status = await statusRes.json();
    expect(status.data.hasSonarr).toBe(true);
    expect(status.data.hasRadarr).toBe(true);
    expect(status.data.hasOverseerr).toBe(true);
  });

  it("returns 400 for invalid JSON", async () => {
    const req = new Request("http://localhost/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-valid-json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
