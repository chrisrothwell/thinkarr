/**
 * Unit tests for the Gemini parallel-tool-call concatenation repair helpers:
 *   trySplitJsonArgs   — splits '{"a":1}{"b":2}' into two JSON strings
 *   trySplitConcatenatedCall — detects a concatenated tool name and splits it
 *
 * Reproduces the exact failure observed in Langfuse session
 * 9b8e6bf1-a359-425a-a354-907c90d80903 where gemini-2.5-flash-lite emitted:
 *   name: "sonarr_search_seriesplex_search_library"
 *   args: '{"term":"The Young Offenders"}{"query":"The Young Offenders"}'
 */

import { describe, it, expect } from "vitest";
import { trySplitJsonArgs, trySplitConcatenatedCall } from "@/lib/llm/orchestrator";

// ---------------------------------------------------------------------------
// trySplitJsonArgs
// ---------------------------------------------------------------------------

describe("trySplitJsonArgs", () => {
  it("splits two concatenated flat objects", () => {
    const result = trySplitJsonArgs('{"term":"The Young Offenders"}{"query":"The Young Offenders"}');
    expect(result).not.toBeNull();
    expect(result![0]).toBe('{"term":"The Young Offenders"}');
    expect(result![1]).toBe('{"query":"The Young Offenders"}');
  });

  it("returns null for a single valid JSON object", () => {
    expect(trySplitJsonArgs('{"term":"foo"}')).toBeNull();
  });

  it("returns null for an empty object", () => {
    expect(trySplitJsonArgs("{}")).toBeNull();
  });

  it("handles nested objects in the first half", () => {
    const result = trySplitJsonArgs('{"a":{"b":1}}{"c":2}');
    expect(result).not.toBeNull();
    expect(result![0]).toBe('{"a":{"b":1}}');
    expect(result![1]).toBe('{"c":2}');
  });

  it("handles strings containing braces", () => {
    const result = trySplitJsonArgs('{"q":"look {here}"}{"x":1}');
    expect(result).not.toBeNull();
    expect(result![0]).toBe('{"q":"look {here}"}');
    expect(result![1]).toBe('{"x":1}');
  });

  it("handles escaped backslash before closing brace in string", () => {
    // {"path":"C:\\"}{"b":1} — the \\ is an escaped backslash, not escaping "
    const result = trySplitJsonArgs('{"path":"C:\\\\"}{"b":1}');
    expect(result).not.toBeNull();
  });

  it("trims leading whitespace from the second object", () => {
    const result = trySplitJsonArgs('{"a":1}  {"b":2}');
    expect(result).not.toBeNull();
    expect(result![1]).toBe('{"b":2}');
  });
});

// ---------------------------------------------------------------------------
// trySplitConcatenatedCall
// ---------------------------------------------------------------------------

describe("trySplitConcatenatedCall", () => {
  const registered = ["sonarr_search_series", "plex_search_library", "display_titles", "overseerr_search"];

  it("splits the exact failure from the Gemini trace", () => {
    const tc = {
      id: "function-call-18299178841011128148",
      function: {
        name: "sonarr_search_seriesplex_search_library",
        arguments: '{"term":"The Young Offenders"}{"query":"The Young Offenders"}',
      },
    };
    const result = trySplitConcatenatedCall(tc, registered);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result![0].function.name).toBe("sonarr_search_series");
    expect(result![0].function.arguments).toBe('{"term":"The Young Offenders"}');
    expect(result![1].function.name).toBe("plex_search_library");
    expect(result![1].function.arguments).toBe('{"query":"The Young Offenders"}');
  });

  it("assigns derived IDs to the split calls", () => {
    const tc = {
      id: "abc123",
      function: {
        name: "sonarr_search_seriesplex_search_library",
        arguments: '{"term":"X"}{"query":"X"}',
      },
    };
    const result = trySplitConcatenatedCall(tc, registered);
    expect(result![0].id).toBe("abc123-0");
    expect(result![1].id).toBe("abc123-1");
  });

  it("returns null for a valid tool name", () => {
    const tc = {
      id: "x",
      function: { name: "overseerr_search", arguments: '{"query":"test"}' },
    };
    expect(trySplitConcatenatedCall(tc, registered)).toBeNull();
  });

  it("returns null when name matches prefix but second half is not registered", () => {
    const tc = {
      id: "x",
      function: {
        name: "sonarr_search_seriesXXX_unknown",
        arguments: '{"term":"X"}{"y":1}',
      },
    };
    expect(trySplitConcatenatedCall(tc, registered)).toBeNull();
  });

  it("returns null when arguments cannot be split into two JSON objects", () => {
    const tc = {
      id: "x",
      function: {
        name: "sonarr_search_seriesplex_search_library",
        arguments: '{"term":"X"}', // only one JSON object
      },
    };
    expect(trySplitConcatenatedCall(tc, registered)).toBeNull();
  });

  it("returns null for an empty registered list", () => {
    const tc = {
      id: "x",
      function: {
        name: "sonarr_search_seriesplex_search_library",
        arguments: '{"a":1}{"b":2}',
      },
    };
    expect(trySplitConcatenatedCall(tc, [])).toBeNull();
  });
});
