/**
 * Unit tests for POST /api/voice/transcribe
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

const mockTranscriptionsCreate = vi.fn();
vi.mock("@/lib/llm/client", () => ({
  getLlmClientForEndpoint: vi.fn(() => ({
    client: { audio: { transcriptions: { create: mockTranscriptionsCreate } } },
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

import { POST } from "@/app/api/voice/transcribe/route";

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  testDb = drizzle(sqlite, { schema });
  migrate(testDb, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  mockGetSession.mockResolvedValue(mockSession);
  mockTranscriptionsCreate.mockResolvedValue({ text: "hello world" });
});

afterEach(() => {
  sqlite.close();
  vi.clearAllMocks();
});

function makeFormData(audio?: Blob, modelId = "ep1:gpt-4.1", language?: string): FormData {
  const fd = new FormData();
  if (audio) fd.append("audio", audio, "recording.webm");
  fd.append("modelId", modelId);
  if (language) fd.append("language", language);
  return fd;
}

describe("POST /api/voice/transcribe", () => {
  it("returns 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValue(null);
    const req = new Request("http://localhost/api/voice/transcribe", {
      method: "POST",
      body: makeFormData(new Blob(["audio"], { type: "audio/webm" })),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 400 when audio field is missing", async () => {
    const fd = new FormData();
    fd.append("modelId", "ep1:gpt-4.1");
    const req = new Request("http://localhost/api/voice/transcribe", {
      method: "POST",
      body: fd,
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/audio/i);
  });

  it("returns transcript on success", async () => {
    const req = new Request("http://localhost/api/voice/transcribe", {
      method: "POST",
      body: makeFormData(new Blob(["audio"], { type: "audio/webm" })),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.transcript).toBe("hello world");
  });

  it("passes language to Whisper when a specific language is set", async () => {
    const req = new Request("http://localhost/api/voice/transcribe", {
      method: "POST",
      body: makeFormData(new Blob(["audio"], { type: "audio/webm" }), "ep1:gpt-4.1", "en"),
    });
    await POST(req);
    const callArgs = mockTranscriptionsCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.language).toBe("en");
  });

  it("does not pass language to Whisper when language is 'auto'", async () => {
    const req = new Request("http://localhost/api/voice/transcribe", {
      method: "POST",
      body: makeFormData(new Blob(["audio"], { type: "audio/webm" }), "ep1:gpt-4.1", "auto"),
    });
    await POST(req);
    const callArgs = mockTranscriptionsCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.language).toBeUndefined();
  });

  it("does not pass language to Whisper when language is omitted", async () => {
    const req = new Request("http://localhost/api/voice/transcribe", {
      method: "POST",
      body: makeFormData(new Blob(["audio"], { type: "audio/webm" })),
    });
    await POST(req);
    const callArgs = mockTranscriptionsCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.language).toBeUndefined();
  });

  it("returns 500 when transcription API throws", async () => {
    mockTranscriptionsCreate.mockRejectedValue(new Error("API error"));
    const req = new Request("http://localhost/api/voice/transcribe", {
      method: "POST",
      body: makeFormData(new Blob(["audio"], { type: "audio/webm" })),
    });
    const res = await POST(req);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
  });
});
