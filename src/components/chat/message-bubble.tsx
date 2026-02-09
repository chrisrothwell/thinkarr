import { cn } from "@/lib/utils";
import { MessageContent } from "./message-content";
import { ToolCall } from "./tool-call";
import { Avatar } from "@/components/ui/avatar";
import { Bot } from "lucide-react";
import type { Message } from "@/types";
import type { ToolCallDisplay } from "@/types/chat";

interface MessageBubbleProps {
  message: Message;
  toolCalls?: ToolCallDisplay[];
  userAvatar?: string | null;
  userName?: string;
}

export function MessageBubble({ message, toolCalls, userAvatar, userName }: MessageBubbleProps) {
  const isUser = message.role === "user";
  const hasToolCalls = toolCalls && toolCalls.length > 0;

  return (
    <div className={cn("flex gap-3 px-4 py-3", isUser && "flex-row-reverse")}>
      {isUser ? (
        <Avatar src={userAvatar} fallback={userName || "U"} size="sm" />
      ) : (
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10">
          <Bot size={18} className="text-primary" />
        </div>
      )}

      <div className={cn("max-w-[80%] min-w-0", isUser && "text-right")}>
        {/* Tool calls rendered before the text content */}
        {hasToolCalls && (
          <div className="mb-2">
            {toolCalls.map((tc) => (
              <ToolCall key={tc.id} toolCall={tc} />
            ))}
          </div>
        )}

        <div
          className={cn(
            "inline-block rounded-2xl px-4 py-2.5 text-sm",
            isUser
              ? "bg-primary text-primary-foreground"
              : "bg-card text-card-foreground",
          )}
        >
          {message.content ? (
            isUser ? (
              <p className="whitespace-pre-wrap">{message.content}</p>
            ) : (
              <MessageContent content={message.content} />
            )
          ) : (
            <span className="inline-block h-5 w-1 animate-pulse bg-muted-foreground/50 rounded-full" />
          )}
        </div>
      </div>
    </div>
  );
}
