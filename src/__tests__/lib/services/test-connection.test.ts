import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

import { testConnection } from "@/lib/services/test-connection";

beforeEach(() => {
  vi.clearAllMocks();
  listModelsMock.mockResolvedValue({ [Symbol.asyncIterator]: async function* () {} });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [], version: "1.0", MediaContainer: { machineIdentifier: "test" } })));
});
afterEach(() => vi.unstubAllGlobals());

describe("service probe destination and redirect boundaries", () => {
  it.each(["plex", "sonarr", "radarr", "overseerr"] as const)("preserves custom LAN/base-path destinations for %s without following redirects", async (type) => {
    const result = await testConnection({ type, url: "http://192.168.1.10:9000/proxy", apiKey: "test-key" });
    expect(result.success).toBe(true);
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls).toHaveLength(1);
    const target = new URL(String(calls[0][0]));
    expect(target.origin).toBe("http://192.168.1.10:9000"); expect(target.pathname).toMatch(/^\/proxy\//);
    expect(calls[0][1]?.redirect).toBe("error");
  });

  it.each(["llm", "plex", "sonarr", "radarr", "overseerr"] as const)("rejects metadata addresses and non-HTTP schemes before %s probing", async (type) => {
    for (const url of ["http://169.254.169.254/latest/meta-data", "http://[fe80::1]", "file:///etc/passwd"]) {
      const result = await testConnection({ type, url, apiKey: "test-key", model: "test-model" });
      expect(result.success).toBe(false);
    }
    expect(fetch).not.toHaveBeenCalled(); expect(createMock).not.toHaveBeenCalled(); expect(listModelsMock).not.toHaveBeenCalled();
  });

  it.each(["http://127.0.0.1:9000/proxy/v1", "http://127.0.0.1:9000//other.invalid/proxy/v1"])("preserves custom LLM voice/TTS base paths without changing hosts or probing OpenAI realtime (%s)", async (url) => {
    createMock.mockResolvedValue({ choices: [] });
    const result = await testConnection({ type: "llm", url, apiKey: "test-key", model: "local-model" });
    expect(result.success).toBe(true);
    const calls = vi.mocked(fetch).mock.calls;
    const basePath = new URL(url).pathname;
    expect(calls.map(([target]) => new URL(String(target)).pathname).sort()).toEqual([`${basePath}/audio/speech`, `${basePath}/audio/transcriptions`]);
    expect(calls.every(([url, options]) => new URL(String(url)).origin === "http://127.0.0.1:9000" && options?.redirect === "error")).toBe(true);
  });

  it("pins realtime models to the HTTPS OpenAI origin", async () => {
    createMock.mockResolvedValue({ choices: [] });
    await testConnection({ type: "llm", url: "https://api.openai.com/v1", apiKey: "test-key", model: "test-model" });
    expect(vi.mocked(fetch).mock.calls.some(([url, options]) => String(url) === "https://api.openai.com/v1/models" && options?.redirect === "error")).toBe(true);
  });

  it("reports failed capability probes when redirects are rejected without retrying them", async () => {
    createMock.mockResolvedValue({ choices: [] });
    vi.mocked(fetch).mockRejectedValue(new TypeError("redirect rejected"));
    const result = await testConnection({ type: "llm", url: "http://127.0.0.1:9000/v1", apiKey: "test-key", model: "local-model" });
    expect(result).toMatchObject({ success: true, capabilities: { supportsVoice: false, supportsTts: false, realtimeModel: null } });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls.every(([, options]) => options?.redirect === "error")).toBe(true);
  });
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
    expect(createMock.mock.calls[1][0]).not.toHaveProperty("max_tokens");
    expect(createMock.mock.calls[1][0]).not.toHaveProperty("max_completion_tokens");
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
