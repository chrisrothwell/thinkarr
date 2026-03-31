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

// Re-import the module fresh for each test via dynamic import so we can
// reset env vars and the singleton between tests.
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
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("isLangfuseEnabled", () => {
    it("returns false when env vars are not set", async () => {
      delete process.env.LANGFUSE_SECRET_KEY;
      delete process.env.LANGFUSE_PUBLIC_KEY;
      const { isLangfuseEnabled } = await importLangfuse();
      expect(isLangfuseEnabled()).toBe(false);
    });

    it("returns false when only secret key is set", async () => {
      process.env.LANGFUSE_SECRET_KEY = "sk-lf-test";
      delete process.env.LANGFUSE_PUBLIC_KEY;
      const { isLangfuseEnabled } = await importLangfuse();
      expect(isLangfuseEnabled()).toBe(false);
    });

    it("returns false when only public key is set", async () => {
      delete process.env.LANGFUSE_SECRET_KEY;
      process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test";
      const { isLangfuseEnabled } = await importLangfuse();
      expect(isLangfuseEnabled()).toBe(false);
    });

    it("returns true when both keys are set", async () => {
      process.env.LANGFUSE_SECRET_KEY = "sk-lf-test";
      process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test";
      const { isLangfuseEnabled } = await importLangfuse();
      expect(isLangfuseEnabled()).toBe(true);
    });
  });

  describe("startTrace", () => {
    it("returns null when Langfuse is not configured", async () => {
      delete process.env.LANGFUSE_SECRET_KEY;
      delete process.env.LANGFUSE_PUBLIC_KEY;
      const { startTrace } = await importLangfuse();
      const result = startTrace({
        conversationId: "conv-1",
        userId: "42",
        userMessage: "hello",
        model: "gpt-4o",
      });
      expect(result).toBeNull();
      expect(mockTrace).not.toHaveBeenCalled();
    });

    it("creates a trace with correct params when configured", async () => {
      process.env.LANGFUSE_SECRET_KEY = "sk-lf-test";
      process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test";
      const fakeTrace = { id: "trace-1" };
      mockTrace.mockReturnValue(fakeTrace);
      const { startTrace } = await importLangfuse();

      const result = startTrace({
        conversationId: "conv-1",
        userId: "42",
        userMessage: "find Inception",
        model: "gpt-4o",
      });

      expect(result).toBe(fakeTrace);
      expect(mockTrace).toHaveBeenCalledWith({
        name: "chat",
        sessionId: "conv-1",
        userId: "42",
        input: "find Inception",
        metadata: { model: "gpt-4o" },
      });
    });
  });

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
      // Initialise the client by creating a trace
      mockTrace.mockReturnValue({ id: "t1" });
      startTrace({ conversationId: "c1", userId: "1", userMessage: "hi", model: "m" });
      flushLangfuse();
      // Allow the promise microtask to settle
      await new Promise((r) => setTimeout(r, 0));
      expect(mockFlushAsync).toHaveBeenCalled();
    });
  });
});
