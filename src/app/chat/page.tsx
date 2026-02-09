"use client";

import { useState, useEffect, useCallback } from "react";
import { Sidebar, SidebarToggle } from "@/components/chat/sidebar";
import { MessageList } from "@/components/chat/message-list";
import { ChatInput } from "@/components/chat/chat-input";
import { Spinner } from "@/components/ui/spinner";
import { useConversations } from "@/hooks/use-conversations";
import { useChat } from "@/hooks/use-chat";
import type { User } from "@/types";

export default function ChatPage() {
  const [user, setUser] = useState<User | null>(null);
  const [userLoading, setUserLoading] = useState(true);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window !== "undefined") return window.innerWidth < 768;
    return false;
  });

  const {
    conversations,
    createConversation,
    deleteConversation,
  } = useConversations();

  const {
    messages,
    toolCalls,
    streaming,
    error,
    sendMessage,
    stopStreaming,
    loadMessages,
    clearMessages,
  } = useChat(activeConversationId);

  // Load current user
  useEffect(() => {
    fetch("/api/auth/session")
      .then((r) => r.json())
      .then((data) => {
        if (data.success) setUser(data.data.user);
      })
      .catch(() => {})
      .finally(() => setUserLoading(false));
  }, []);

  // Auto-collapse sidebar on narrow viewports
  useEffect(() => {
    function handleResize() {
      if (window.innerWidth < 768) setSidebarCollapsed(true);
    }
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // Load messages when active conversation changes
  useEffect(() => {
    if (activeConversationId) {
      loadMessages(activeConversationId);
    } else {
      clearMessages();
    }
  }, [activeConversationId, loadMessages, clearMessages]);

  const handleNewChat = useCallback(() => {
    setActiveConversationId(null);
    clearMessages();
  }, [clearMessages]);

  const handleSelectConversation = useCallback((id: string) => {
    setActiveConversationId(id);
    if (window.innerWidth < 768) setSidebarCollapsed(true);
  }, []);

  const handleDeleteConversation = useCallback(
    async (id: string) => {
      await deleteConversation(id);
      if (activeConversationId === id) {
        setActiveConversationId(null);
        clearMessages();
      }
    },
    [deleteConversation, activeConversationId, clearMessages],
  );

  const handleSend = useCallback(
    async (content: string) => {
      let convId = activeConversationId;

      // If no active conversation, create one
      if (!convId) {
        const conv = await createConversation();
        if (!conv) return;
        convId = conv.id;
        setActiveConversationId(convId);
      }

      sendMessage(content, convId);
    },
    [activeConversationId, createConversation, sendMessage],
  );

  if (userLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner size={24} />
      </div>
    );
  }

  return (
    <div className="flex h-screen">
      <Sidebar
        conversations={conversations}
        activeId={activeConversationId}
        user={user}
        onSelect={handleSelectConversation}
        onNew={handleNewChat}
        onDelete={handleDeleteConversation}
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed(true)}
      />

      {sidebarCollapsed && <SidebarToggle onClick={() => setSidebarCollapsed(false)} />}

      <main className="flex flex-1 flex-col min-w-0">
        <MessageList
          messages={messages}
          toolCalls={toolCalls}
          userAvatar={user?.plexAvatarUrl}
          userName={user?.plexUsername}
        />

        {error && (
          <div className="px-4 py-2 text-center text-sm text-destructive">{error}</div>
        )}

        <ChatInput
          onSend={handleSend}
          onStop={stopStreaming}
          streaming={streaming}
          disabled={streaming}
        />
      </main>
    </div>
  );
}
