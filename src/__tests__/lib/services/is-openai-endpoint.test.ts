import { describe, it, expect } from "vitest";
import { isOpenAIEndpoint } from "@/lib/services/test-connection";

describe("isOpenAIEndpoint", () => {
  it("returns true for the canonical OpenAI base URL", () => {
    expect(isOpenAIEndpoint("https://api.openai.com/v1")).toBe(true);
  });

  it("returns true for OpenAI URL with trailing slash", () => {
    expect(isOpenAIEndpoint("https://api.openai.com/v1/")).toBe(true);
  });

  it("returns false for Gemini OpenAI-compatible endpoint", () => {
    expect(isOpenAIEndpoint("https://generativelanguage.googleapis.com/v1beta/openai")).toBe(false);
  });

  it("returns false for Anthropic endpoint", () => {
    expect(isOpenAIEndpoint("https://api.anthropic.com/v1")).toBe(false);
  });

  it("returns false for local LM Studio or Ollama proxy", () => {
    expect(isOpenAIEndpoint("http://localhost:11434/v1")).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(isOpenAIEndpoint("")).toBe(false);
  });

  it("returns false for a non-URL string", () => {
    expect(isOpenAIEndpoint("not-a-url")).toBe(false);
  });
});
