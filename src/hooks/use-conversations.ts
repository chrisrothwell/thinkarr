"use client";

import { useState, useEffect, useCallback } from "react";
import type { Conversation } from "@/types";

export function useConversations(viewAll = false) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchConversations = useCallback(async () => {
    try {
      const url = viewAll ? "/api/conversations?all=true" : "/api/conversations";
      const res = await fetch(url);
      const data = await res.json();
      if (data.success) {
        setConversations(data.data);
      }
    } catch {
      // Silently fail — conversations will be empty
    } finally {
      setLoading(false);
    }
  }, [viewAll]);

  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  const createConversation = useCallback(async (title?: string): Promise<Conversation | null> => {
    try {
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      const data = await res.json();
      if (data.success) {
        const conv = data.data as Conversation;
        setConversations((prev) => [conv, ...prev]);
        return conv;
      }
    } catch {
      // Silently fail
    }
    return null;
  }, []);

  const deleteConversation = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/conversations/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (data.success) {
        setConversations((prev) => prev.filter((c) => c.id !== id));
      }
    } catch {
      // Silently fail
    }
  }, []);

  const renameConversation = useCallback(async (id: string, title: string) => {
    try {
      const res = await fetch(`/api/conversations/${id}/title`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      const data = await res.json();
      if (data.success) {
        setConversations((prev) =>
          prev.map((c) => (c.id === id ? { ...c, title } : c)),
        );
      }
    } catch {
      // Silently fail
    }
  }, []);

  return {
    conversations,
    loading,
    createConversation,
    deleteConversation,
    renameConversation,
    refetch: fetchConversations,
  };
}
