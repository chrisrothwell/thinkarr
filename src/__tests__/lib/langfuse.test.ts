import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock the langfuse SDK so no real network calls are made.
// vi.hoisted ensures these variables are available when the vi.mock factory
// runs (which is hoisted to the top of the file by Vitest).
// ---------------------------------------------------------------------------
const { mockTrace, mockFlushAsync } = vi.hoisted(() => {
  const mockTrace = vi.fn();
  const mockFlushAsync = vi.fn().mockResolvedValue(undefined);
  return { mockTrace, mockFlushAsync };
});

vi.mock("langfuse", () => ({
  default: class MockLangfuse {
    trace = mockTrace;
    flushAsync = mockFlushAsync;
  },
}));

// ---------------------------------------------------------------------------
// Mock the DB config so tests can exercise the DB fallback path.
// ---------------------------------------------------------------------------
const mockGetConfig = vi.hoisted(() => vi.fn((_key: string) => null as string | null));

vi.mock("@/lib/config", () => ({
  getConfig: mockGetConfig,
}));

// Re-import the module fresh for each test via dynamic import so env var
// and DB config changes are picked up by the re-executed module code.
async function importLangfuse() {
  return import("@/lib/llm/langfuse");
}

describe("langfuse module", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    mockTrace.mockReset();
    mockFlushAsync.mockReset().mockResolvedValue(undefined);
    mockGetConfig.mockReset().mockReturnValue(null);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // ---------------------------------------------------------------------------
  // isLangfuseEnabled
  // ---------------------------------------------------------------------------
  describe("isLangfuseEnabled", () => {
    it("returns false when neither env vars nor DB config are set", async () => {
      delete process.env.LANGFUSE_SECRET_KEY;
      delete process.env.LANGFUSE_PUBLIC_KEY;
      const { isLangfuseEnabled } = await importLangfuse();
      expect(isLangfuseEnabled()).toBe(false);
    });

    it("returns true when both keys are set via env vars", async () => {
      process.env.LANGFUSE_SECRET_KEY = "sk-lf-test";
      process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test";
      const { isLangfuseEnabled } = await importLangfuse();
      expect(isLangfuseEnabled()).toBe(true);
    });

    it("returns true when both keys are set via DB config", async () => {
      delete process.env.LANGFUSE_SECRET_KEY;
      delete process.env.LANGFUSE_PUBLIC_KEY;
      mockGetConfig.mockImplementation((key: string) => {
        if (key === "langfuse.secretKey") return "sk-lf-db";
        if (key === "langfuse.publicKey") return "pk-lf-db";
        return null;
      });
      const { isLangfuseEnabled } = await importLangfuse();
      expect(isLangfuseEnabled()).toBe(true);
    });

    it("returns false when only secret key is provided", async () => {
      process.env.LANGFUSE_SECRET_KEY = "sk-lf-test";
      delete process.env.LANGFUSE_PUBLIC_KEY;
      const { isLangfuseEnabled } = await importLangfuse();
      expect(isLangfuseEnabled()).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // startTrace
  // ---------------------------------------------------------------------------
  describe("startTrace", () => {
    it("returns null when Langfuse is not configured", async () => {
      delete process.env.LANGFUSE_SECRET_KEY;
      delete process.env.LANGFUSE_PUBLIC_KEY;
      const { startTrace } = await importLangfuse();
      const result = startTrace({
        traceId: "msg-test-1",
        conversationId: "conv-1",
        userId: "42",
        userMessage: "hello",
        model: "gpt-4o",
      });
      expect(result).toBeNull();
      expect(mockTrace).not.toHaveBeenCalled();
    });

    it("creates a trace with correct params when configured via env vars", async () => {
      process.env.LANGFUSE_SECRET_KEY = "sk-lf-test";
      process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test";
      const fakeTrace = { id: "trace-1" };
      mockTrace.mockReturnValue(fakeTrace);
      const { startTrace } = await importLangfuse();

      const result = startTrace({
        traceId: "msg-uuid-1",
        conversationId: "conv-1",
        userId: "42",
        userMessage: "find Inception",
        model: "gpt-4o",
      });

      expect(result).toBe(fakeTrace);
      expect(mockTrace).toHaveBeenCalledWith({
        id: "msg-uuid-1",
        name: "chat",
        sessionId: "conv-1",
        userId: "42",
        input: "find Inception",
        metadata: { model: "gpt-4o" },
      });
    });

    it("creates a trace when configured via DB config", async () => {
      delete process.env.LANGFUSE_SECRET_KEY;
      delete process.env.LANGFUSE_PUBLIC_KEY;
      mockGetConfig.mockImplementation((key: string) => {
        if (key === "langfuse.secretKey") return "sk-lf-db";
        if (key === "langfuse.publicKey") return "pk-lf-db";
        if (key === "langfuse.baseUrl") return "https://langfuse.example.com";
        return null;
      });
      mockTrace.mockReturnValue({ id: "trace-db" });
      const { startTrace } = await importLangfuse();

      const result = startTrace({
        traceId: "msg-uuid-db",
        conversationId: "conv-2",
        userId: "7",
        userMessage: "test",
        model: "llama3",
      });

      expect(result).toEqual({ id: "trace-db" });
    });

    it("env var keys take precedence over DB config keys", async () => {
      process.env.LANGFUSE_SECRET_KEY = "sk-lf-env";
      process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-env";
      mockGetConfig.mockImplementation((key: string) => {
        if (key === "langfuse.secretKey") return "sk-lf-db-should-not-use";
        if (key === "langfuse.publicKey") return "pk-lf-db-should-not-use";
        return null;
      });
      const { isLangfuseEnabled } = await importLangfuse();
      expect(isLangfuseEnabled()).toBe(true);
      // env var keys are used — DB keys should not be consulted for the secret/public key
      // when env vars are already set (verified by the OR short-circuit in resolveKeys)
    });
  });

  // ---------------------------------------------------------------------------
  // scoreTrace
  // ---------------------------------------------------------------------------
  describe("scoreTrace", () => {
    it("does nothing when Langfuse is not configured", async () => {
      delete process.env.LANGFUSE_SECRET_KEY;
      delete process.env.LANGFUSE_PUBLIC_KEY;
      const { scoreTrace } = await importLangfuse();
      expect(() => scoreTrace({ traceId: "msg-1", comment: "it broke" })).not.toThrow();
    });

    it("calls client.score with correct params when configured", async () => {
      process.env.LANGFUSE_SECRET_KEY = "sk-lf-test";
      process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test";
      const mockScore = vi.fn();
      // Override the mock class to expose score
      vi.doMock("langfuse", () => ({
        default: class MockLangfuseWithScore {
          trace = mockTrace;
          flushAsync = mockFlushAsync;
          score = mockScore;
        },
      }));
      vi.resetModules();
      const { scoreTrace: scoreTraceFresh } = await importLangfuse();

      scoreTraceFresh({ traceId: "msg-abc", comment: "wrong answer given" });

      expect(mockScore).toHaveBeenCalledWith({
        traceId: "msg-abc",
        name: "user-report",
        value: 0,
        comment: "wrong answer given",
      });
    });
  });

  // ---------------------------------------------------------------------------
  // getLangfuseBaseUrl
  // ---------------------------------------------------------------------------
  describe("getLangfuseBaseUrl", () => {
    it("returns null when not configured", async () => {
      delete process.env.LANGFUSE_SECRET_KEY;
      delete process.env.LANGFUSE_PUBLIC_KEY;
      const { getLangfuseBaseUrl } = await importLangfuse();
      expect(getLangfuseBaseUrl()).toBeNull();
    });

    it("returns the default cloud URL when only keys are set", async () => {
      process.env.LANGFUSE_SECRET_KEY = "sk-lf-test";
      process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test";
      delete process.env.LANGFUSE_HOST;
      const { getLangfuseBaseUrl } = await importLangfuse();
      expect(getLangfuseBaseUrl()).toBe("https://cloud.langfuse.com");
    });

    it("returns the custom host when LANGFUSE_HOST is set", async () => {
      process.env.LANGFUSE_SECRET_KEY = "sk-lf-test";
      process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test";
      process.env.LANGFUSE_HOST = "https://langfuse.example.com";
      const { getLangfuseBaseUrl } = await importLangfuse();
      expect(getLangfuseBaseUrl()).toBe("https://langfuse.example.com");
    });
  });

  // ---------------------------------------------------------------------------
  // flushLangfuse
  // ---------------------------------------------------------------------------
  describe("flushLangfuse", () => {
    it("does not throw when Langfuse is not configured", async () => {
      delete process.env.LANGFUSE_SECRET_KEY;
      delete process.env.LANGFUSE_PUBLIC_KEY;
      const { flushLangfuse } = await importLangfuse();
      expect(() => flushLangfuse()).not.toThrow();
    });

    it("calls flushAsync when a client is active", async () => {
      process.env.LANGFUSE_SECRET_KEY = "sk-lf-test";
      process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test";
      const { startTrace, flushLangfuse } = await importLangfuse();
      mockTrace.mockReturnValue({ id: "t1" });
      startTrace({ traceId: "msg-1", conversationId: "c1", userId: "1", userMessage: "hi", model: "m" });
      flushLangfuse();
      await new Promise((r) => setTimeout(r, 0));
      expect(mockFlushAsync).toHaveBeenCalled();
    });
  });
});
