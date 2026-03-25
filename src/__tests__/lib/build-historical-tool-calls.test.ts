import { describe, it, expect } from "vitest";
import { buildHistoricalToolCalls } from "@/components/chat/message-list";
import type { Message } from "@/types";

function makeMsg(overrides: Partial<Message>): Message {
  return {
    id: "msg-1",
    conversationId: "conv-1",
    role: "assistant",
    content: null,
    toolCalls: null,
    toolCallId: null,
    toolName: null,
    durationMs: null,
    createdAt: new Date(),
    ...overrides,
  };
}

const TOOL_CALLS_JSON = JSON.stringify([
  { id: "tc-1", function: { name: "overseerr_search", arguments: '{"query":"Star Trek"}' } },
]);

describe("buildHistoricalToolCalls — spinner / reconnection fixes", () => {
  it("marks tool call as 'done' when a result message exists", () => {
    const assistantMsg = makeMsg({ id: "a-1", role: "assistant", toolCalls: TOOL_CALLS_JSON });
    const resultMsg = makeMsg({
      id: "r-1",
      role: "tool",
      toolCallId: "tc-1",
      content: JSON.stringify({ results: [] }),
      durationMs: 42,
    });

    const map = buildHistoricalToolCalls([assistantMsg, resultMsg]);
    const displays = map.get("a-1")!;
    expect(displays).toHaveLength(1);
    expect(displays[0].status).toBe("done");
    expect(displays[0].error).toBeUndefined();
  });

  it("marks tool call as 'error' (not 'calling') when no result exists — prevents stuck spinner", () => {
    // Simulates an interrupted stream: assistant message saved to DB but tool
    // result was never written (mobile disconnect / server crash).
    const assistantMsg = makeMsg({ id: "a-1", role: "assistant", toolCalls: TOOL_CALLS_JSON });

    const map = buildHistoricalToolCalls([assistantMsg]);
    const displays = map.get("a-1")!;
    expect(displays).toHaveLength(1);
    expect(displays[0].status).toBe("error");
    expect(displays[0].error).toBe("Connection was lost");
  });

  it("marks tool call as 'error' with error message when result contains an error", () => {
    const assistantMsg = makeMsg({ id: "a-1", role: "assistant", toolCalls: TOOL_CALLS_JSON });
    const resultMsg = makeMsg({
      id: "r-1",
      role: "tool",
      toolCallId: "tc-1",
      content: JSON.stringify({ error: "Overseerr API error: HTTP 400" }),
      durationMs: 8,
    });

    const map = buildHistoricalToolCalls([assistantMsg, resultMsg]);
    const displays = map.get("a-1")!;
    expect(displays[0].status).toBe("error");
    expect(displays[0].error).toBe("Overseerr API error: HTTP 400");
  });
});
