import { describe, it, expect, vi, beforeEach } from "vitest";

const { createMock, listModelsMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  listModelsMock: vi.fn(),
}));

vi.mock("openai", () => {
  class APIError extends Error {
    status: number;
    error: unknown;
    headers: Record<string, string>;
    constructor(status: number, error: unknown, message: string, headers: Record<string, string>) {
      super(message);
      this.status = status;
      this.error = error;
      this.headers = headers;
    }
  }
  function OpenAIMock() {
    return {
      chat: { completions: { create: createMock } },
      models: { list: listModelsMock },
    };
  }
  return { default: OpenAIMock, APIError };
});

vi.mock("@/lib/security/url-validation", () => ({
  validateServiceUrl: vi.fn().mockReturnValue({ valid: true }),
}));

import { testConnection } from "@/lib/services/test-connection";

beforeEach(() => {
  vi.clearAllMocks();
  listModelsMock.mockResolvedValue({ [Symbol.asyncIterator]: async function* () {} });
});

describe("testConnection LLM — max_tokens fallback", () => {
  it("succeeds on first attempt with max_tokens for GPT-4.x models", async () => {
    createMock.mockResolvedValue({ choices: [] });

    const result = await testConnection({ type: "llm", url: "https://api.openai.com/v1", apiKey: "sk-test", model: "gpt-4.1" });

    expect(result.success).toBe(true);
    expect(createMock.mock.calls[0][0]).toMatchObject({ max_tokens: 1 });
  });

  it("retries with max_completion_tokens when GPT-5 returns 400 param=max_tokens", async () => {
    const { APIError } = await import("openai");
    createMock
      .mockRejectedValueOnce(new (APIError as unknown as new (...args: unknown[]) => Error)(400, { param: "max_tokens", code: "unsupported_parameter" }, "Unsupported parameter", {}))
      .mockResolvedValue({ choices: [] });

    const result = await testConnection({ type: "llm", url: "https://api.openai.com/v1", apiKey: "sk-test", model: "gpt-5-mini" });

    expect(result.success).toBe(true);
    expect(createMock.mock.calls[0][0]).toMatchObject({ max_tokens: 1 });
    expect(createMock.mock.calls[1][0]).toMatchObject({ max_completion_tokens: 1 });
  });

  it("reports failure (not retries) when model returns a 401 auth error", async () => {
    const { APIError } = await import("openai");
    createMock.mockRejectedValue(new (APIError as unknown as new (...args: unknown[]) => Error)(401, { message: "Unauthorized" }, "Unauthorized", {}));

    const result = await testConnection({ type: "llm", url: "https://api.openai.com/v1", apiKey: "sk-bad", model: "gpt-4.1" });

    expect(result.success).toBe(false);
    // Should not retry on non-max_tokens API errors
    const maxTokensCalls = createMock.mock.calls.filter((c: unknown[]) =>
      (c[0] as Record<string, unknown>).max_completion_tokens !== undefined
    );
    expect(maxTokensCalls).toHaveLength(0);
  });

  it("retries without token limit on non-HTTP (network) errors", async () => {
    createMock
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValue({ choices: [] });

    const result = await testConnection({ type: "llm", url: "https://api.openai.com/v1", apiKey: "sk-test", model: "gpt-4.1" });

    expect(result.success).toBe(true);
    expect(createMock.mock.calls[0][0]).toMatchObject({ max_tokens: 1 });
    expect(createMock.mock.calls[1][0]).not.toHaveProperty("max_tokens");
    expect(createMock.mock.calls[1][0]).not.toHaveProperty("max_completion_tokens");
  });
});
