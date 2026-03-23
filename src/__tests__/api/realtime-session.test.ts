/**
 * Unit tests for POST /api/realtime/session
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

const mockGetEndpointConfig = vi.fn();
vi.mock("@/lib/llm/client", () => ({
  getLlmClientForEndpoint: vi.fn(),
  getEndpointConfig: () => mockGetEndpointConfig(),
}));

vi.mock("@/lib/security/api-rate-limit", () => ({
  checkUserApiRateLimit: vi.fn(() => true),
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock("@/lib/tools/init", () => ({ initializeTools: vi.fn() }));
vi.mock("@/lib/tools/registry", () => ({
  getOpenAITools: vi.fn(() => []),
  executeTool: vi.fn(),
}));
vi.mock("@/lib/llm/system-prompt", () => ({
  buildRealtimeSystemPrompt: vi.fn(() => "You are Thinkarr voice assistant."),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { POST } from "@/app/api/realtime/session/route";

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  testDb = drizzle(sqlite, { schema });
  migrate(testDb, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  mockGetSession.mockResolvedValue(mockSession);
  mockGetEndpointConfig.mockReturnValue({
    id: "ep1",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-test",
    model: "gpt-4.1",
    systemPrompt: "",
    enabled: true,
    supportsVoice: true,
    supportsRealtime: true,
    realtimeModel: "gpt-4o-realtime-preview-2024-12-17",
    realtimeSystemPrompt: "",
  });
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ client_secret: { value: "eph_token_123" } }),
    text: () => Promise.resolve(""),
  });
});

afterEach(() => {
  sqlite.close();
  vi.clearAllMocks();
});

describe("POST /api/realtime/session", () => {
  it("returns 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValue(null);
    const req = new Request("http://localhost/api/realtime/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: "ep1:gpt-4.1" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 400 when endpoint does not support realtime", async () => {
    mockGetEndpointConfig.mockReturnValue({
      id: "ep2",
      supportsRealtime: false,
      realtimeModel: "",
      apiKey: "sk-test",
      baseUrl: "https://other.api",
    });
    const req = new Request("http://localhost/api/realtime/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: "ep2:gpt-3.5" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/realtime/i);
  });

  it("returns 400 when endpoint config not found", async () => {
    mockGetEndpointConfig.mockReturnValue(null);
    const req = new Request("http://localhost/api/realtime/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: "unknown:model" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns clientSecret on success", async () => {
    const req = new Request("http://localhost/api/realtime/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: "ep1:gpt-4.1" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.clientSecret).toBe("eph_token_123");
    expect(body.data.realtimeModel).toBe("gpt-4o-realtime-preview-2024-12-17");
  });

  it("returns 400 when endpoint is ChatGPT-compatible but not OpenAI (e.g. Gemini)", async () => {
    mockGetEndpointConfig.mockReturnValue({
      id: "ep-gemini",
      name: "Gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: "gemini-key",
      model: "gemini-2.0-flash",
      systemPrompt: "",
      enabled: true,
      supportsVoice: false,
      supportsRealtime: true,
      realtimeModel: "gemini-realtime",
      realtimeSystemPrompt: "",
    });
    const req = new Request("http://localhost/api/realtime/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: "ep-gemini:gemini-2.0-flash" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/openai/i);
  });

  it("returns 400 when endpoint is Anthropic-compatible but not OpenAI", async () => {
    mockGetEndpointConfig.mockReturnValue({
      id: "ep-anthropic",
      name: "Anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "anthropic-key",
      model: "claude-sonnet-4-6",
      systemPrompt: "",
      enabled: true,
      supportsVoice: false,
      supportsRealtime: true,
      realtimeModel: "claude-realtime",
      realtimeSystemPrompt: "",
    });
    const req = new Request("http://localhost/api/realtime/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: "ep-anthropic:claude-sonnet-4-6" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/openai/i);
  });

  it("returns 502 when OpenAI Realtime API fails", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      text: () => Promise.resolve("Forbidden"),
    });
    const req = new Request("http://localhost/api/realtime/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: "ep1:gpt-4.1" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(502);
  });
});
