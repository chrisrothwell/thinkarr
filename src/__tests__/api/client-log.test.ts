/**
 * Unit tests for POST /api/client-log
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockGetSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({ getSession: () => mockGetSession() }));

const mockLogger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: mockLogger }));

// ── Route (imported after mocks) ──────────────────────────────────────────────

import { POST } from "@/app/api/client-log/route";

// ── Helpers ───────────────────────────────────────────────────────────────────

const mockSession = {
  sessionId: "test-session",
  user: { id: 42, plexId: "plex1", plexUsername: "tester", plexEmail: "t@t.com", plexAvatarUrl: null, isAdmin: false },
};

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/client-log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue(mockSession);
});

// ── Auth ───────────────────────────────────────────────────────────────────────

describe("POST /api/client-log — authentication", () => {
  it("returns 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await POST(makeRequest({ message: "hi" }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
  });
});

// ── Input validation ───────────────────────────────────────────────────────────

describe("POST /api/client-log — input validation", () => {
  it("returns 400 for invalid JSON", async () => {
    const req = new Request("http://localhost/api/client-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("returns 200 and succeeds with valid body", async () => {
    const res = await POST(makeRequest({ message: "hello", level: "info" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });
});

// ── Log level dispatch ─────────────────────────────────────────────────────────

describe("POST /api/client-log — log level dispatch", () => {
  it("calls logger.info for level=info", async () => {
    await POST(makeRequest({ message: "info msg", level: "info" }));
    expect(mockLogger.info).toHaveBeenCalledOnce();
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(mockLogger.info.mock.calls[0][0]).toContain("info msg");
  });

  it("calls logger.warn for level=warn", async () => {
    await POST(makeRequest({ message: "warn msg", level: "warn" }));
    expect(mockLogger.warn).toHaveBeenCalledOnce();
    expect(mockLogger.info).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(mockLogger.warn.mock.calls[0][0]).toContain("warn msg");
  });

  it("calls logger.error for level=error", async () => {
    await POST(makeRequest({ message: "error msg", level: "error" }));
    expect(mockLogger.error).toHaveBeenCalledOnce();
    expect(mockLogger.info).not.toHaveBeenCalled();
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.error.mock.calls[0][0]).toContain("error msg");
  });

  it("defaults to logger.info for unknown level", async () => {
    await POST(makeRequest({ message: "unknown", level: "debug" }));
    expect(mockLogger.info).toHaveBeenCalledOnce();
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it("defaults to logger.info when level is omitted", async () => {
    await POST(makeRequest({ message: "no level" }));
    expect(mockLogger.info).toHaveBeenCalledOnce();
  });
});

// ── Message sanitisation ───────────────────────────────────────────────────────

describe("POST /api/client-log — message sanitisation", () => {
  it("truncates messages longer than 500 characters", async () => {
    const longMsg = "a".repeat(600);
    await POST(makeRequest({ message: longMsg, level: "info" }));
    expect(mockLogger.info).toHaveBeenCalledOnce();
    const logged: string = mockLogger.info.mock.calls[0][0];
    expect(logged.length).toBeLessThanOrEqual(510); // "[client] " + 500 chars
  });

  it("uses default message when message is not a string", async () => {
    await POST(makeRequest({ message: 123, level: "info" }));
    expect(mockLogger.info.mock.calls[0][0]).toContain("client log");
  });
});
