"use client";

import { useState, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { SendHorizontal, Square } from "lucide-react";

interface ChatInputProps {
  onSend: (message: string) => void;
  onStop?: () => void;
  disabled?: boolean;
  streaming?: boolean;
}

export function ChatInput({ onSend, onStop, disabled, streaming }: ChatInputProps) {
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

  return (
    <div className="border-t bg-background p-4">
      <div className="mx-auto flex max-w-3xl items-end gap-2">
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
            className="shrink-0"
          >
            <SendHorizontal size={16} />
          </Button>
        )}
      </div>
    </div>
  );
}
