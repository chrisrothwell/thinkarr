"use client";

import { useState, useEffect, useCallback } from "react";
import { Sidebar, SidebarToggle } from "@/components/chat/sidebar";
import { MessageList } from "@/components/chat/message-list";
import { ChatInput } from "@/components/chat/chat-input";
import { PwaInstallBanner } from "@/components/chat/pwa-install-banner";
import { Spinner } from "@/components/ui/spinner";
import { useConversations } from "@/hooks/use-conversations";
import { useChat } from "@/hooks/use-chat";
import type { User } from "@/types";

export type ChatMode = "text" | "voice" | "realtime";

interface ModelOption {
  id: string;
  label: string;
  supportsVoice?: boolean;
  supportsRealtime?: boolean;
}

export default function ChatPage() {
  const [user, setUser] = useState<User | null>(null);
  const [userLoading, setUserLoading] = useState(true);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window !== "undefined") return window.innerWidth < 768;
    return false;
  });

  // Model selection
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [canChangeModel, setCanChangeModel] = useState(true);

  // Chat mode (text / voice / realtime)
  const [chatMode, setChatMode] = useState<ChatMode>("text");
  const [endpointCaps, setEndpointCaps] = useState({ supportsVoice: false, supportsRealtime: false });

  const {
    conversations,
    createConversation,
    deleteConversation,
    updateConversationTitle,
  } = useConversations(user?.isAdmin ?? false);

  const {
    messages,
    toolCalls,
    streaming,
    error,
    sendMessage,
    stopStreaming,
    loadMessages,
    clearMessages,
  } = useChat(activeConversationId, {
    onTitleUpdate: updateConversationTitle,
  });

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

  // Load available models
  useEffect(() => {
    fetch("/api/models")
      .then((r) => r.json())
      .then((data) => {
        if (data.success) {
          const loadedModels: ModelOption[] = data.data.models || [];
          setModels(loadedModels);
          setCanChangeModel(data.data.canChangeModel);
          const defaultModel = data.data.defaultModel || "";
          setSelectedModel(defaultModel);
          // Set initial capabilities from the default model
          const defaultOpt = loadedModels.find((m) => m.id === defaultModel);
          if (defaultOpt) {
            setEndpointCaps({
              supportsVoice: defaultOpt.supportsVoice ?? false,
              supportsRealtime: defaultOpt.supportsRealtime ?? false,
            });
          }
        }
      })
      .catch(() => {});
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

      sendMessage(content, convId, selectedModel || undefined);
    },
    [activeConversationId, createConversation, sendMessage, selectedModel],
  );

  if (userLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner size={24} />
      </div>
    );
  }

  const appVersion = process.env.NEXT_PUBLIC_APP_VERSION;

  return (
    <div className="flex h-[100dvh]">
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
        <PwaInstallBanner />

        {/* Model selector bar */}
        {canChangeModel && models.length > 1 && (
          <div className="flex items-center justify-end border-b px-4 py-1.5">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              Model:
              <select
                value={selectedModel}
                onChange={(e) => {
                  const newModel = e.target.value;
                  setSelectedModel(newModel);
                  const opt = models.find((m) => m.id === newModel);
                  const caps = {
                    supportsVoice: opt?.supportsVoice ?? false,
                    supportsRealtime: opt?.supportsRealtime ?? false,
                  };
                  setEndpointCaps(caps);
                  // Reset to text mode if the new endpoint doesn't support current mode
                  setChatMode((prev) => {
                    if (prev === "voice" && !caps.supportsVoice) return "text";
                    if (prev === "realtime" && !caps.supportsRealtime) return "text";
                    return prev;
                  });
                }}
                className="rounded border bg-background px-2 py-1 text-xs"
                disabled={streaming}
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        <MessageList
          messages={messages}
          toolCalls={toolCalls}
          userAvatar={
            // When admin views another user's conversation, show that user's avatar
            (() => {
              const activeConv = conversations.find((c) => c.id === activeConversationId);
              if (activeConv && activeConv.userId !== user?.id && activeConv.ownerAvatarUrl !== undefined) {
                return activeConv.ownerAvatarUrl;
              }
              return user?.plexAvatarUrl;
            })()
          }
          userName={
            (() => {
              const activeConv = conversations.find((c) => c.id === activeConversationId);
              if (activeConv && activeConv.userId !== user?.id && activeConv.ownerName) {
                return activeConv.ownerName;
              }
              return user?.plexUsername;
            })()
          }
        />

        {error && (
          <div className="px-4 py-2 text-center text-sm text-destructive">{error}</div>
        )}

        <ChatInput
          onSend={handleSend}
          onStop={stopStreaming}
          streaming={streaming}
          disabled={streaming}
          chatMode={chatMode}
          onModeChange={setChatMode}
          supportsVoice={endpointCaps.supportsVoice}
          supportsRealtime={endpointCaps.supportsRealtime}
          selectedModel={selectedModel}
        />
      </main>
      {appVersion && (
        <div className="fixed bottom-2 left-2 z-10 pointer-events-none hidden md:block">
          <span className="text-[10px] text-muted-foreground/40 font-mono select-none">
            {/^\d/.test(appVersion) ? `v${appVersion}` : appVersion}
          </span>
        </div>
      )}
    </div>
  );
}
