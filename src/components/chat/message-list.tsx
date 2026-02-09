"use client";

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

export function MessageList({ messages, toolCalls, userAvatar, userName }: MessageListProps) {
  const { containerRef } = useAutoScroll([messages, toolCalls]);

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
        {visibleMessages.map((message, idx) => (
          <MessageBubble
            key={message.id}
            message={message}
            toolCalls={idx === lastAssistantIdx ? toolCalls : undefined}
            userAvatar={userAvatar}
            userName={userName}
          />
        ))}
      </div>
    </div>
  );
}
