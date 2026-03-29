"use client";

import { useState, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { SendHorizontal, Square } from "lucide-react";
import type { ChatMode } from "@/app/chat/page";
import { VoiceConversation } from "@/components/chat/voice-conversation";
import { RealtimeChat } from "@/components/chat/realtime-chat";

interface ChatInputProps {
  onSend: (message: string) => void;
  onStop?: () => void;
  disabled?: boolean;
  streaming?: boolean;
  chatMode: ChatMode;
  onModeChange: (mode: ChatMode) => void;
  supportsVoice: boolean;
  supportsRealtime: boolean;
  selectedModel: string;
  ttsVoice?: string;
  lastResponse?: string;
  conversationId?: string | null;
  onRealtimeTurn?: (role: "user" | "assistant", text: string) => void;
  onRealtimeMessagesUpdated?: () => void;
}

export function ChatInput({
  onSend,
  onStop,
  disabled,
  streaming,
  chatMode,
  onModeChange,
  supportsVoice,
  supportsRealtime,
  selectedModel,
  ttsVoice = "alloy",
  lastResponse = "",
  conversationId,
  onRealtimeTurn,
  onRealtimeMessagesUpdated,
}: ChatInputProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue("");
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [value, disabled, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  const handleInput = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, []);

  const showModeToggle = supportsVoice || supportsRealtime;

  return (
    <div className="border-t bg-background p-4">
      <div className="mx-auto max-w-3xl space-y-2">
        {/* Mode toggle */}
        {showModeToggle && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => onModeChange("text")}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                chatMode === "text"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Text
            </button>
            {supportsVoice && (
              <button
                onClick={() => onModeChange("voice")}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  chatMode === "voice"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Voice
              </button>
            )}
            {supportsRealtime && (
              <button
                onClick={() => onModeChange("realtime")}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  chatMode === "realtime"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Realtime
              </button>
            )}
          </div>
        )}

        {/* Input area */}
        {chatMode === "voice" ? (
          <VoiceConversation
            modelId={selectedModel}
            ttsVoice={ttsVoice}
            onSend={onSend}
            onCancel={() => onModeChange("text")}
            streaming={streaming ?? false}
            lastResponse={lastResponse}
          />
        ) : chatMode === "realtime" ? (
          <RealtimeChat
            modelId={selectedModel}
            conversationId={conversationId}
            onTurn={onRealtimeTurn}
            onMessagesUpdated={onRealtimeMessagesUpdated}
          />
        ) : (
          <div className="flex items-end gap-2">
            <textarea
              ref={textareaRef}
              className="flex-1 resize-none rounded-xl border border-input bg-card px-4 py-3 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
              placeholder="Type a message..."
              rows={1}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={handleKeyDown}
              onInput={handleInput}
              disabled={disabled}
            />

            {streaming ? (
              <Button size="icon" variant="secondary" onClick={onStop} className="shrink-0">
                <Square size={16} />
              </Button>
            ) : (
              <Button
                size="icon"
                onClick={handleSubmit}
                disabled={disabled || !value.trim()}
                aria-label="Send"
                className="shrink-0"
              >
                <SendHorizontal size={16} />
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
