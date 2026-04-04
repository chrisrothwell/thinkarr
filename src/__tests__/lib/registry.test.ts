/**
 * Unit tests for registry.ts — unknown tool error messaging.
 * Regression test for the "overseer_search" typo that produced an opaque
 * "Unknown tool" error with no hint for the LLM to self-correct.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("executeTool — unknown tool name suggestions", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function setupRegistry() {
    const { defineTool, executeTool } = await import("@/lib/tools/registry");
    (defineTool as unknown as { _registry?: Map<string, unknown> })._registry?.clear?.();
    defineTool({
      name: "overseerr_search",
      description: "Search Overseerr",
      schema: z.object({ query: z.string() }),
      handler: async () => ({ results: [] }),
    });
    return executeTool;
  }

  it("suggests the correct name when caller typos overseer_search (single r)", async () => {
    const executeTool = await setupRegistry();
    const raw = await executeTool("overseer_search", JSON.stringify({ query: "test" }));
    const result = JSON.parse(raw) as { error: string };
    expect(result.error).toContain("overseerr_search");
  });

  it("error message includes 'Did you mean' for close matches", async () => {
    const executeTool = await setupRegistry();
    const raw = await executeTool("overseer_search", JSON.stringify({ query: "test" }));
    const result = JSON.parse(raw) as { error: string };
    expect(result.error).toMatch(/did you mean/i);
  });

  it("falls back to listing available tools when no close match exists", async () => {
    const executeTool = await setupRegistry();
    const raw = await executeTool("nonexistent_tool_xyz", JSON.stringify({}));
    const result = JSON.parse(raw) as { error: string };
    expect(result.error).toContain("overseerr_search");
    expect(result.error).toMatch(/available tools/i);
  });
});
