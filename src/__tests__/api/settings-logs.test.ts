/**
 * Unit tests for /api/settings/logs and /api/settings/logs/[filename]
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";

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

// Point CONFIG_DIR at a temp directory for each test
let tmpDir: string;
let logsDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "thinkarr-logs-test-"));
  logsDir = path.join(tmpDir, "logs");
  process.env.CONFIG_DIR = tmpDir;
  mockGetSession.mockResolvedValue(mockAdminSession);
});

// Re-import routes after setting CONFIG_DIR
async function getListRoute() {
  vi.resetModules();
  const mod = await import("@/app/api/settings/logs/route");
  return mod.GET;
}
async function getFileRoute() {
  vi.resetModules();
  const mod = await import("@/app/api/settings/logs/[filename]/route");
  return mod.GET;
}

// ── /api/settings/logs ──────────────────────────────────────────────────────

describe("GET /api/settings/logs", () => {
  it("returns 403 for non-admin", async () => {
    mockGetSession.mockResolvedValue(mockUserSession);
    const GET = await getListRoute();
    const res = await GET();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("returns empty array when logs dir does not exist", async () => {
    const GET = await getListRoute();
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toEqual([]);
  });

  it("lists .log files with name/size/modified", async () => {
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, "thinkarr-2026-03-15.log"), "line1\nline2\n");

    const GET = await getListRoute();
    const res = await GET();
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].name).toBe("thinkarr-2026-03-15.log");
    expect(body.data[0].size).toBeGreaterThan(0);
    expect(body.data[0].modified).toBeTruthy();
  });

  it("ignores non-.log files", async () => {
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, "thinkarr-2026-03-15.log"), "ok");
    fs.writeFileSync(path.join(logsDir, "other.txt"), "ignored");

    const GET = await getListRoute();
    const res = await GET();
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].name).toBe("thinkarr-2026-03-15.log");
  });
});

// ── /api/settings/logs/[filename] ───────────────────────────────────────────

function makeRequest(url: string): Request {
  return new Request(url);
}

describe("GET /api/settings/logs/[filename]", () => {
  it("returns 403 for non-admin", async () => {
    mockGetSession.mockResolvedValue(mockUserSession);
    const GET = await getFileRoute();
    const res = await GET(
      makeRequest("http://localhost/api/settings/logs/test.log"),
      { params: Promise.resolve({ filename: "test.log" }) },
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 for path traversal attempt", async () => {
    const GET = await getFileRoute();
    const res = await GET(
      makeRequest("http://localhost/api/settings/logs/..%2Fsecret"),
      { params: Promise.resolve({ filename: "../secret" }) },
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when file does not exist", async () => {
    fs.mkdirSync(logsDir, { recursive: true });
    const GET = await getFileRoute();
    const res = await GET(
      makeRequest("http://localhost/api/settings/logs/missing.log"),
      { params: Promise.resolve({ filename: "missing.log" }) },
    );
    expect(res.status).toBe(404);
  });

  it("returns last 500 lines by default", async () => {
    fs.mkdirSync(logsDir, { recursive: true });
    const lines = Array.from({ length: 600 }, (_, i) => `line ${i + 1}`);
    fs.writeFileSync(path.join(logsDir, "thinkarr-2026-03-15.log"), lines.join("\n"));

    const GET = await getFileRoute();
    const res = await GET(
      makeRequest("http://localhost/api/settings/logs/thinkarr-2026-03-15.log"),
      { params: Promise.resolve({ filename: "thinkarr-2026-03-15.log" }) },
    );
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.totalLines).toBe(600);
    expect(body.data.showing).toBe(500);
    expect(body.data.content).toContain("line 600");
    expect(body.data.content).not.toContain("line 1\n");
  });

  it("returns all lines when full=true", async () => {
    fs.mkdirSync(logsDir, { recursive: true });
    const lines = Array.from({ length: 600 }, (_, i) => `line ${i + 1}`);
    fs.writeFileSync(path.join(logsDir, "thinkarr-2026-03-15.log"), lines.join("\n"));

    const GET = await getFileRoute();
    const res = await GET(
      makeRequest("http://localhost/api/settings/logs/thinkarr-2026-03-15.log?full=true"),
      { params: Promise.resolve({ filename: "thinkarr-2026-03-15.log" }) },
    );
    const body = await res.json();
    expect(body.data.showing).toBe(600);
    expect(body.data.content).toContain("line 1");
  });

  it("returns download response with attachment header", async () => {
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, "thinkarr-2026-03-15.log"), "log content");

    const GET = await getFileRoute();
    const res = await GET(
      makeRequest("http://localhost/api/settings/logs/thinkarr-2026-03-15.log?download=true"),
      { params: Promise.resolve({ filename: "thinkarr-2026-03-15.log" }) },
    );
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
    expect(res.headers.get("Content-Disposition")).toContain("thinkarr-2026-03-15.log");
  });
});
