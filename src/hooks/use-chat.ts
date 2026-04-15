"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import type { Message } from "@/types";
import type { ToolCallDisplay } from "@/types/chat";
import { generateId } from "@/lib/utils";
import { clientLog } from "@/lib/client-logger";

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
    } catch (e: unknown) {
      clientLog.error("Failed to load messages", {
        errorName: e instanceof Error ? e.name : "UnknownError",
        errorMessage: e instanceof Error ? e.message : "Unknown error",
        online: typeof navigator !== "undefined" ? navigator.onLine : null,
        conversationId: convId,
      });
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
        durationMs: null,
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
        durationMs: null,
        createdAt: new Date(),
      };
      setMessages((prev) => [...prev, assistantMsg]);

      streamingRef.current = true;
      setStreaming(true);
      const controller = new AbortController();
      abortRef.current = controller;

      let phase: "fetch" | "stream" = "fetch";
      // If the streaming connection drops after the server has already saved
      // the response (e.g. proxy timeout on a slow LLM), we suppress the
      // error and let the finally-block reload recover the completed message.
      let suppressedStreamError: string | null = null;
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

        phase = "stream";
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
                clientLog.error("Server error event", { message: event.message, conversationId: convId });
                setError(event.message);
              }
            } catch {
              // Skip malformed SSE lines
            }
          }
        }
      } catch (e: unknown) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        const errName = e instanceof Error ? e.name : "UnknownError";
        const errMsg = e instanceof Error ? e.message : "Unknown error";
        const online = typeof navigator !== "undefined" ? navigator.onLine : null;
        clientLog.error("SSE stream failure", {
          phase,
          errorName: errName,
          errorMessage: errMsg,
          online,
          conversationId: convId,
        });
        const isNetworkError =
          errMsg === "Failed to fetch" || errMsg === "NetworkError when attempting to fetch resource.";
        const userMsg = isNetworkError
          ? online === false
            ? "Network error: you appear to be offline"
            : "Network error: could not reach the server"
          : errMsg;
        // If the connection dropped mid-stream (not during the initial fetch),
        // the server may have completed and saved the response. Suppress the
        // error for now — the finally-block reload will recover it. Only show
        // the error if the reload itself also fails or returns no response.
        if (phase === "stream" && isNetworkError) {
          suppressedStreamError = userMsg;
          // Remove the empty placeholder so the reload result fills the slot cleanly
          setMessages((prev) => prev.filter((m) => m.id !== assistantId || (m.content && m.content.length > 0)));
        } else {
          setError(userMsg);
          setMessages((prev) => prev.filter((m) => m.id !== assistantId || (m.content && m.content.length > 0)));
        }
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
              // If the stream dropped but the server saved a real assistant
              // response, the reload recovered it — no error needed.
              // Only surface the error if the reload produced no response.
              if (suppressedStreamError) {
                const hasResponse = (data.data.messages as { role: string; content?: string }[]).some(
                  (m) => m.role === "assistant" && m.content && m.content.length > 0,
                );
                if (!hasResponse) setError(suppressedStreamError);
              }
            } else if (suppressedStreamError) {
              setError(suppressedStreamError);
            }
          } catch (e: unknown) {
            // Best-effort — messages stay as optimistic state if reload fails
            clientLog.warn("Post-stream message reload failed", {
              errorName: e instanceof Error ? e.name : "UnknownError",
              errorMessage: e instanceof Error ? e.message : "Unknown error",
              online: typeof navigator !== "undefined" ? navigator.onLine : null,
              conversationId: convId,
            });
            if (suppressedStreamError) setError(suppressedStreamError);
          }
        } else if (suppressedStreamError) {
          setError(suppressedStreamError);
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

  // When the user returns to the page (e.g. after backgrounding Chrome on
  // mobile), reload messages so any tool results that completed server-side
  // while the SSE connection was down are immediately visible.
  // Only fires when not actively streaming — avoids racing with a live stream.
  useEffect(() => {
    const handleVisibilityChange = () => {
      const conversationId = conversationIdRef.current;
      if (document.visibilityState === "hidden") {
        clientLog.info("page hidden", {
          streaming: streamingRef.current,
          conversationId,
        });
      } else if (document.visibilityState === "visible") {
        clientLog.info("page visible", {
          streaming: streamingRef.current,
          conversationId,
          willReload: !streamingRef.current && !!conversationId,
        });
        if (!streamingRef.current && conversationId) {
          void loadMessages(conversationId);
        }
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [loadMessages]);

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
