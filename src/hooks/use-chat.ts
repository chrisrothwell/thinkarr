"use client";

import { useState, useCallback, useRef } from "react";
import type { Message } from "@/types";
import type { ToolCallDisplay } from "@/types/chat";
import { generateId } from "@/lib/utils";

interface UseChatOptions {
  onTitleUpdate?: (conversationId: string, title: string) => void;
}

export function useChat(conversationId: string | null, options?: UseChatOptions) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [toolCalls, setToolCalls] = useState<Map<string, ToolCallDisplay>>(new Map());
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Ref tracks streaming without stale-closure issues — loadMessages checks this
  // before overwriting state so it never races with an active SSE stream.
  const streamingRef = useRef(false);
  // Tracks the current conversationId so async callbacks can detect stale fetches.
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;
  // Keep options in a ref so sendMessage can read the latest callbacks without
  // including the options object itself in the useCallback dependency array
  // (which would cause a new function on every render).
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const loadMessages = useCallback(async (convId: string) => {
    if (streamingRef.current) return;
    setToolCalls(new Map());
    try {
      const res = await fetch(`/api/conversations/${convId}`);
      const data = await res.json();
      if (data.success && data.data.messages) {
        setMessages(data.data.messages);
      }
    } catch {
      setError("Failed to load messages");
    }
  }, []);

  const sendMessage = useCallback(
    async (content: string, targetConversationId?: string, modelId?: string) => {
      const convId = targetConversationId || conversationId;
      if (!convId || !content.trim() || streaming) return;

      setError(null);
      setToolCalls(new Map());

      // Add user message optimistically
      const userMsg: Message = {
        id: generateId(),
        conversationId: convId,
        role: "user",
        content,
        toolCalls: null,
        toolCallId: null,
        toolName: null,
        createdAt: new Date(),
      };
      setMessages((prev) => [...prev, userMsg]);

      // Add placeholder assistant message
      const assistantId = generateId();
      const assistantMsg: Message = {
        id: assistantId,
        conversationId: convId,
        role: "assistant",
        content: "",
        toolCalls: null,
        toolCallId: null,
        toolName: null,
        createdAt: new Date(),
      };
      setMessages((prev) => [...prev, assistantMsg]);

      streamingRef.current = true;
      setStreaming(true);
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversationId: convId, message: content, modelId }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => null);
          throw new Error(errData?.error || `HTTP ${res.status}`);
        }

        const reader = res.body?.getReader();
        if (!reader) throw new Error("No response body");

        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6);
            if (payload === "[DONE]") continue;

            try {
              const event = JSON.parse(payload);
              if (event.type === "title_update") {
                optionsRef.current?.onTitleUpdate?.(event.conversationId, event.title);
              } else if (event.type === "text_delta") {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId
                      ? { ...m, content: (m.content || "") + event.content }
                      : m,
                  ),
                );
              } else if (event.type === "tool_call_start") {
                setToolCalls((prev) => {
                  const next = new Map(prev);
                  next.set(event.toolCallId, {
                    id: event.toolCallId,
                    name: event.toolName,
                    arguments: event.arguments,
                    status: "calling",
                  });
                  return next;
                });
              } else if (event.type === "tool_result") {
                setToolCalls((prev) => {
                  const next = new Map(prev);
                  const existing = next.get(event.toolCallId);
                  if (existing) {
                    const isError = event.error === true;
                    const errorMessage = isError
                      ? (safeJsonParse(event.result)?.error as string | undefined) ?? "Tool call failed"
                      : undefined;
                    next.set(event.toolCallId, {
                      ...existing,
                      result: event.result,
                      status: isError ? "error" : "done",
                      durationMs: event.durationMs,
                      error: errorMessage,
                    });
                  }
                  return next;
                });
              } else if (event.type === "error") {
                setError(event.message);
              }
            } catch {
              // Skip malformed SSE lines
            }
          }
        }
      } catch (e: unknown) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        const msg = e instanceof Error ? e.message : "Failed to send message";
        setError(msg);
        setMessages((prev) => prev.filter((m) => m.id !== assistantId || (m.content && m.content.length > 0)));
      } finally {
        streamingRef.current = false;
        setStreaming(false);
        abortRef.current = null;
        // Reload messages from server so tool call results (including display_titles
        // carousels) are persisted in state and survive subsequent messages.
        // Guard: skip if the user has navigated away (e.g. clicked "New Chat")
        // before this fetch resolves, otherwise the reload would overwrite the
        // cleared state and break the empty-chat view.
        if (conversationIdRef.current === convId) {
          try {
            const res = await fetch(`/api/conversations/${convId}`);
            const data = await res.json();
            if (data.success && data.data.messages && conversationIdRef.current === convId) {
              setMessages(data.data.messages);
              setToolCalls(new Map());
            }
          } catch {
            // Best-effort — messages stay as optimistic state if reload fails
          }
        }
      }
    },
    [conversationId, streaming],
  );

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
    setToolCalls(new Map());
    setError(null);
  }, []);

  return {
    messages,
    toolCalls: Array.from(toolCalls.values()),
    streaming,
    error,
    sendMessage,
    stopStreaming,
    loadMessages,
    clearMessages,
  };
}

function safeJsonParse(str: string): Record<string, unknown> | null {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}
