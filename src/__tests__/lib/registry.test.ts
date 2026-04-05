/**
 * Unit tests for registry.ts — tool name normalization and argument repair.
 *
 * Covers:
 * - Unknown tool error messaging (regression for "overseer_search" typo)
 * - PascalCase/CamelCase name normalization (issue #290)
 * - Flat display_titles argument wrapping (issue #290)
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

describe("executeTool — issue #290: PascalCase tool name normalization", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function setupRegistryWithDisplayTitles() {
    const { defineTool, executeTool } = await import("@/lib/tools/registry");
    defineTool({
      name: "display_titles",
      description: "Display title cards",
      schema: z.object({
        titles: z.array(
          z.object({
            mediaType: z.enum(["movie", "tv", "episode"]),
            title: z.string(),
            mediaStatus: z.enum(["available", "partial", "pending", "not_requested"]),
          }),
        ).min(1),
      }),
      handler: async (args) => ({ displayTitles: args.titles }),
    });
    return executeTool;
  }

  it("resolves PascalCase 'DisplayTitles' to 'display_titles'", async () => {
    const executeTool = await setupRegistryWithDisplayTitles();
    const args = JSON.stringify({ titles: [{ mediaType: "movie", title: "Inception", mediaStatus: "available" }] });
    const raw = await executeTool("DisplayTitles", args);
    const result = JSON.parse(raw) as { displayTitles: unknown[] };
    expect(result.displayTitles).toHaveLength(1);
  });

  it("resolves 'DisplayTitlesTitles' (Gemini param-name suffix hallucination) to 'display_titles'", async () => {
    const executeTool = await setupRegistryWithDisplayTitles();
    const args = JSON.stringify({ titles: [{ mediaType: "movie", title: "Inception", mediaStatus: "available" }] });
    const raw = await executeTool("DisplayTitlesTitles", args);
    const result = JSON.parse(raw) as { displayTitles: unknown[] };
    expect(result.displayTitles).toHaveLength(1);
  });

  it("resolves snake_case 'display_titles_titles' to 'display_titles'", async () => {
    const executeTool = await setupRegistryWithDisplayTitles();
    const args = JSON.stringify({ titles: [{ mediaType: "tv", title: "Severance", mediaStatus: "not_requested" }] });
    const raw = await executeTool("display_titles_titles", args);
    const result = JSON.parse(raw) as { displayTitles: unknown[] };
    expect(result.displayTitles).toHaveLength(1);
  });
});

describe("executeTool — issue #290: flat display_titles argument wrapping", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function setupRegistryWithDisplayTitles() {
    const { defineTool, executeTool } = await import("@/lib/tools/registry");
    defineTool({
      name: "display_titles",
      description: "Display title cards",
      schema: z.object({
        titles: z.array(
          z.object({
            mediaType: z.enum(["movie", "tv", "episode"]),
            title: z.string(),
            mediaStatus: z.enum(["available", "partial", "pending", "not_requested"]),
            seasonNumber: z.number().nullish(),
          }),
        ).min(1),
      }),
      handler: async (args) => ({ displayTitles: args.titles }),
    });
    return executeTool;
  }

  it("wraps a flat title object into {titles: [...]} automatically", async () => {
    const executeTool = await setupRegistryWithDisplayTitles();
    // Gemini sends flat args instead of {titles: [{...}]}
    const flat = JSON.stringify({ mediaType: "movie", title: "Inception", mediaStatus: "available" });
    const raw = await executeTool("display_titles", flat);
    const result = JSON.parse(raw) as { displayTitles: Array<{ title: string }> };
    expect(result.displayTitles).toHaveLength(1);
    expect(result.displayTitles[0].title).toBe("Inception");
  });

  it("wraps flat season-card args (title + seasonNumber) correctly", async () => {
    const executeTool = await setupRegistryWithDisplayTitles();
    const flat = JSON.stringify({ mediaType: "tv", title: "Severance — Season 1", mediaStatus: "not_requested", seasonNumber: 1 });
    const raw = await executeTool("display_titles", flat);
    const result = JSON.parse(raw) as { displayTitles: Array<{ title: string; seasonNumber?: number }> };
    expect(result.displayTitles[0].seasonNumber).toBe(1);
  });

  it("does not double-wrap when titles array is already present", async () => {
    const executeTool = await setupRegistryWithDisplayTitles();
    const correct = JSON.stringify({ titles: [{ mediaType: "movie", title: "Dune", mediaStatus: "available" }] });
    const raw = await executeTool("display_titles", correct);
    const result = JSON.parse(raw) as { displayTitles: unknown[] };
    expect(result.displayTitles).toHaveLength(1);
  });
});
