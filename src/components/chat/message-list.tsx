"use client";

import { useMemo } from "react";
import { MessageBubble } from "./message-bubble";
import { useAutoScroll } from "@/hooks/use-auto-scroll";
import type { Message } from "@/types";
import type { ToolCallDisplay } from "@/types/chat";

interface MessageListProps {
  messages: Message[];
  toolCalls?: ToolCallDisplay[];
  userAvatar?: string | null;
  userName?: string;
}

/** Build tool call displays from historical messages stored in DB. */
function buildHistoricalToolCalls(messages: Message[]): Map<string, ToolCallDisplay[]> {
  const result = new Map<string, ToolCallDisplay[]>();

  // Index tool result messages by their toolCallId
  const toolResults = new Map<string, Message>();
  for (const msg of messages) {
    if (msg.role === "tool" && msg.toolCallId) {
      toolResults.set(msg.toolCallId, msg);
    }
  }

  // For each assistant message that has stored tool calls, build displays
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.toolCalls) {
      try {
        const calls = JSON.parse(msg.toolCalls) as {
          id: string;
          function: { name: string; arguments: string };
        }[];
        const displays: ToolCallDisplay[] = [];
        for (const call of calls) {
          const resultMsg = toolResults.get(call.id);
          const hasError = resultMsg?.content
            ? safeJsonHasError(resultMsg.content)
            : false;
          displays.push({
            id: call.id,
            name: call.function.name,
            arguments: call.function.arguments || "{}",
            result: resultMsg?.content || undefined,
            status: resultMsg ? (hasError ? "error" : "done") : "calling",
          });
        }
        if (displays.length > 0) {
          result.set(msg.id, displays);
        }
      } catch {
        // Skip malformed tool calls
      }
    }
  }

  return result;
}

function safeJsonHasError(str: string): boolean {
  try {
    const parsed = JSON.parse(str);
    return parsed?.error !== undefined;
  } catch {
    return false;
  }
}

export function MessageList({ messages, toolCalls, userAvatar, userName }: MessageListProps) {
  const { containerRef } = useAutoScroll([messages, toolCalls]);

  // Build historical tool calls from message data
  const historicalToolCalls = useMemo(() => buildHistoricalToolCalls(messages), [messages]);

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <h2 className="text-xl font-semibold text-foreground mb-2">Thinkarr</h2>
          <p className="text-sm text-muted-foreground">
            Ask me about your media library, request new content, or check what&apos;s coming up.
          </p>
        </div>
      </div>
    );
  }

  const visibleMessages = messages.filter((m) => m.role === "user" || m.role === "assistant");
  const lastAssistantIdx = visibleMessages.findLastIndex((m) => m.role === "assistant");

  return (
    <div ref={containerRef} className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl py-4">
        {visibleMessages.map((message, idx) => {
          // Use historical tool calls for this message, or live streaming ones for the last assistant
          const msgToolCalls =
            historicalToolCalls.get(message.id) ||
            (idx === lastAssistantIdx && toolCalls && toolCalls.length > 0
              ? toolCalls
              : undefined);

          return (
            <MessageBubble
              key={message.id}
              message={message}
              toolCalls={msgToolCalls}
              userAvatar={userAvatar}
              userName={userName}
            />
          );
        })}
      </div>
    </div>
  );
}
