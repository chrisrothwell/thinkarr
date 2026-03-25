/**
 * Unit tests for GET /api/internal/logs
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";

// ── Mock getConfig ────────────────────────────────────────────────────────────

const mockGetConfig = vi.fn();
vi.mock("@/lib/config", () => ({ getConfig: (key: string) => mockGetConfig(key) }));

// ── Temp dir setup ────────────────────────────────────────────────────────────

let tmpDir: string;
let logsDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "thinkarr-internal-logs-test-"));
  logsDir = path.join(tmpDir, "logs");
  process.env.CONFIG_DIR = tmpDir;
  // Default: valid key stored
  mockGetConfig.mockImplementation((key: string) =>
    key === "internal_api_key" ? "test-secret-key-abc" : null,
  );
});

async function getRoute() {
  vi.resetModules();
  const mod = await import("@/app/api/internal/logs/route");
  return mod.GET;
}

function makeRequest(url: string, apiKey?: string): Request {
  return new Request(url, apiKey ? { headers: { "x-api-key": apiKey } } : {});
}

// ── Auth tests ────────────────────────────────────────────────────────────────

describe("GET /api/internal/logs — authentication", () => {
  it("returns 401 when no X-Api-Key header is provided", async () => {
    const GET = await getRoute();
    const res = await GET(makeRequest("http://localhost/api/internal/logs"));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("returns 401 when X-Api-Key header is wrong", async () => {
    const GET = await getRoute();
    const res = await GET(makeRequest("http://localhost/api/internal/logs", "wrong-key"));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("returns 401 when internal_api_key is not set in config", async () => {
    mockGetConfig.mockReturnValue(null);
    const GET = await getRoute();
    const res = await GET(makeRequest("http://localhost/api/internal/logs", "any-key"));
    expect(res.status).toBe(401);
  });

  it("returns 200 with valid X-Api-Key", async () => {
    const GET = await getRoute();
    const res = await GET(
      makeRequest("http://localhost/api/internal/logs", "test-secret-key-abc"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });
});

// ── Response shape tests ──────────────────────────────────────────────────────

describe("GET /api/internal/logs — response", () => {
  const VALID_KEY = "test-secret-key-abc";

  it("returns empty lines when logs dir does not exist", async () => {
    const GET = await getRoute();
    const res = await GET(makeRequest("http://localhost/api/internal/logs", VALID_KEY));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.lines).toEqual([]);
    expect(body.data.tail).toBe(0);
  });

  it("returns last 300 lines by default", async () => {
    fs.mkdirSync(logsDir, { recursive: true });
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i + 1}`);
    fs.writeFileSync(path.join(logsDir, "thinkarr-2026-03-24.log"), lines.join("\n"));

    const GET = await getRoute();
    const res = await GET(makeRequest("http://localhost/api/internal/logs", VALID_KEY));
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.lines).toHaveLength(300);
    expect(body.data.lines[299]).toBe("line 400");
    expect(body.data.lines[0]).toBe("line 101");
  });

  it("honours ?tail= parameter", async () => {
    fs.mkdirSync(logsDir, { recursive: true });
    const lines = Array.from({ length: 100 }, (_, i) => `entry ${i + 1}`);
    fs.writeFileSync(path.join(logsDir, "thinkarr-2026-03-24.log"), lines.join("\n"));

    const GET = await getRoute();
    const res = await GET(
      makeRequest("http://localhost/api/internal/logs?tail=10", VALID_KEY),
    );
    const body = await res.json();
    expect(body.data.lines).toHaveLength(10);
    expect(body.data.lines[9]).toBe("entry 100");
  });

  it("collects lines across multiple log files in chronological order", async () => {
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, "thinkarr-2026-03-23.log"), "day1-line1\nday1-line2\n");
    fs.writeFileSync(path.join(logsDir, "thinkarr-2026-03-24.log"), "day2-line1\nday2-line2\n");

    const GET = await getRoute();
    const res = await GET(
      makeRequest("http://localhost/api/internal/logs?tail=10", VALID_KEY),
    );
    const body = await res.json();
    expect(body.data.lines).toEqual([
      "day1-line1",
      "day1-line2",
      "day2-line1",
      "day2-line2",
    ]);
  });

  it("does not read older files when newest file already satisfies tail", async () => {
    fs.mkdirSync(logsDir, { recursive: true });
    const oldLines = Array.from({ length: 5 }, (_, i) => `old-line ${i + 1}`);
    const newLines = Array.from({ length: 400 }, (_, i) => `new-line ${i + 1}`);
    fs.writeFileSync(path.join(logsDir, "thinkarr-2026-03-23.log"), oldLines.join("\n"));
    fs.writeFileSync(path.join(logsDir, "thinkarr-2026-03-24.log"), newLines.join("\n"));

    const GET = await getRoute();
    const res = await GET(makeRequest("http://localhost/api/internal/logs?tail=300", VALID_KEY));
    const body = await res.json();
    // Should come entirely from the newer file — old lines must not appear
    expect(body.data.lines).toHaveLength(300);
    expect(body.data.lines.some((l: string) => l.startsWith("old-line"))).toBe(false);
    expect(body.data.lines[0]).toBe("new-line 101");
    expect(body.data.lines[299]).toBe("new-line 400");
  });
});

// ── Filter tests ──────────────────────────────────────────────────────────────

describe("GET /api/internal/logs — filters", () => {
  const VALID_KEY = "test-secret-key-abc";

  beforeEach(() => {
    fs.mkdirSync(logsDir, { recursive: true });
    const entries = [
      `{"level":"info","msg":"user signed in","conversationId":"abc123"}`,
      `{"level":"error","msg":"db timeout","conversationId":"abc123"}`,
      `{"level":"warn","msg":"slow query","conversationId":"xyz999"}`,
      `{"level":"info","msg":"page loaded","conversationId":"xyz999"}`,
      `{"level":"error","msg":"null ref","conversationId":"xyz999"}`,
    ];
    fs.writeFileSync(path.join(logsDir, "thinkarr-2026-03-24.log"), entries.join("\n"));
  });

  it("filters by level=error", async () => {
    const GET = await getRoute();
    const res = await GET(
      makeRequest("http://localhost/api/internal/logs?level=error", VALID_KEY),
    );
    const body = await res.json();
    expect(body.data.lines).toHaveLength(2);
    expect(body.data.lines.every((l: string) => l.includes('"level":"error"'))).toBe(true);
  });

  it("filters by level=warn", async () => {
    const GET = await getRoute();
    const res = await GET(
      makeRequest("http://localhost/api/internal/logs?level=warn", VALID_KEY),
    );
    const body = await res.json();
    expect(body.data.lines).toHaveLength(1);
    expect(body.data.lines[0]).toContain("slow query");
  });

  it("filters by conversationId", async () => {
    const GET = await getRoute();
    const res = await GET(
      makeRequest("http://localhost/api/internal/logs?conversationId=abc123", VALID_KEY),
    );
    const body = await res.json();
    expect(body.data.lines).toHaveLength(2);
    expect(body.data.lines.every((l: string) => l.includes("abc123"))).toBe(true);
  });

  it("combines level and conversationId filters", async () => {
    const GET = await getRoute();
    const res = await GET(
      makeRequest(
        "http://localhost/api/internal/logs?level=error&conversationId=abc123",
        VALID_KEY,
      ),
    );
    const body = await res.json();
    expect(body.data.lines).toHaveLength(1);
    expect(body.data.lines[0]).toContain("db timeout");
  });

  it("returns empty when no lines match the filter", async () => {
    const GET = await getRoute();
    const res = await GET(
      makeRequest("http://localhost/api/internal/logs?conversationId=no-such-id", VALID_KEY),
    );
    const body = await res.json();
    expect(body.data.lines).toHaveLength(0);
    expect(body.data.tail).toBe(0);
  });

  it("tail applies to filtered results, not raw lines", async () => {
    const GET = await getRoute();
    const res = await GET(
      makeRequest("http://localhost/api/internal/logs?level=info&tail=1", VALID_KEY),
    );
    const body = await res.json();
    expect(body.data.lines).toHaveLength(1);
    expect(body.data.lines[0]).toContain("page loaded");
  });
});
