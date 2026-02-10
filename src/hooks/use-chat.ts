"use client";

import { useState, useCallback, useRef } from "react";
import type { Message } from "@/types";
import type { ToolCallDisplay } from "@/types/chat";

export function useChat(conversationId: string | null) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [toolCalls, setToolCalls] = useState<Map<string, ToolCallDisplay>>(new Map());
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const loadMessages = useCallback(async (convId: string) => {
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
        id: crypto.randomUUID(),
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
      const assistantId = crypto.randomUUID();
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
              if (event.type === "text_delta") {
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
                    const parsed = safeJsonParse(event.result);
                    const isError = parsed?.error !== undefined;
                    next.set(event.toolCallId, {
                      ...existing,
                      result: event.result,
                      status: isError ? "error" : "done",
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
        setStreaming(false);
        abortRef.current = null;
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
