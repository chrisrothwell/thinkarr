/**
 * Unit tests for POST /api/voice/tts
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

const mockSession = {
  sessionId: "test-session",
  user: { id: 1, plexId: "p1", plexUsername: "user", plexEmail: null, plexAvatarUrl: null, isAdmin: false },
};
const mockGetSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({ getSession: () => mockGetSession() }));

const mockSpeechCreate = vi.fn();
vi.mock("@/lib/llm/client", () => ({
  getLlmClientForEndpoint: vi.fn(() => ({
    client: { audio: { speech: { create: mockSpeechCreate } } },
    model: "gpt-4.1",
  })),
  getEndpointConfig: vi.fn(() => null),
}));

vi.mock("@/lib/security/api-rate-limit", () => ({
  checkUserApiRateLimit: vi.fn(() => true),
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { POST } from "@/app/api/voice/tts/route";

function makeAudioBuffer(): ArrayBuffer {
  return new Uint8Array([0x49, 0x44, 0x33]).buffer; // Fake MP3 header bytes
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  testDb = drizzle(sqlite, { schema });
  migrate(testDb, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  mockGetSession.mockResolvedValue(mockSession);
  mockSpeechCreate.mockResolvedValue({ arrayBuffer: async () => makeAudioBuffer() });
});

afterEach(() => {
  sqlite.close();
  vi.clearAllMocks();
});

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/voice/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/voice/tts", () => {
  it("returns 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await POST(makeRequest({ text: "hello", modelId: "ep1:gpt-4.1" }));
    expect(res.status).toBe(401);
  });

  it("returns 400 when text is missing", async () => {
    const res = await POST(makeRequest({ modelId: "ep1:gpt-4.1" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/text/i);
  });

  it("returns 400 when text is empty string", async () => {
    const res = await POST(makeRequest({ text: "   ", modelId: "ep1:gpt-4.1" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when body is invalid JSON", async () => {
    const req = new Request("http://localhost/api/voice/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns audio/mpeg on success with default voice", async () => {
    const res = await POST(makeRequest({ text: "Hello world", modelId: "ep1:gpt-4.1" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(mockSpeechCreate).toHaveBeenCalledWith(
      expect.objectContaining({ voice: "alloy", model: "tts-1" }),
    );
  });

  it("uses specified voice when valid", async () => {
    const res = await POST(makeRequest({ text: "Hello", modelId: "ep1:gpt-4.1", voice: "nova" }));
    expect(res.status).toBe(200);
    expect(mockSpeechCreate).toHaveBeenCalledWith(
      expect.objectContaining({ voice: "nova" }),
    );
  });

  it("falls back to alloy for an invalid voice value", async () => {
    await POST(makeRequest({ text: "Hello", modelId: "ep1:gpt-4.1", voice: "invalid-voice" }));
    expect(mockSpeechCreate).toHaveBeenCalledWith(
      expect.objectContaining({ voice: "alloy" }),
    );
  });

  it("strips markdown from text before sending to TTS", async () => {
    await POST(
      makeRequest({ text: "**Bold** and `code`\n# Heading", modelId: "ep1:gpt-4.1" }),
    );
    const call = mockSpeechCreate.mock.calls[0][0];
    expect(call.input).not.toContain("**");
    expect(call.input).not.toContain("`");
    expect(call.input).not.toContain("# ");
    expect(call.input).toContain("Bold");
    expect(call.input).toContain("code");
    expect(call.input).toContain("Heading");
  });

  it("returns 500 when TTS API throws", async () => {
    mockSpeechCreate.mockRejectedValue(new Error("API error"));
    const res = await POST(makeRequest({ text: "Hello", modelId: "ep1:gpt-4.1" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
  });
});
