"use client";

import { useState, useEffect, useCallback } from "react";
import { Sidebar, SidebarToggle } from "@/components/chat/sidebar";
import { MessageList } from "@/components/chat/message-list";
import { ChatInput } from "@/components/chat/chat-input";
import { PwaInstallBanner } from "@/components/chat/pwa-install-banner";
import { ReportIssueModal } from "@/components/chat/report-issue-modal";
import { Spinner } from "@/components/ui/spinner";
import { useConversations } from "@/hooks/use-conversations";
import { useChat } from "@/hooks/use-chat";
import type { User } from "@/types";
import { Flag } from "lucide-react";

export type ChatMode = "text" | "voice" | "realtime";

interface ModelOption {
  id: string;
  label: string;
  supportsVoice?: boolean;
  supportsRealtime?: boolean;
  ttsVoice?: string;
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
  const [endpointCaps, setEndpointCaps] = useState({
    supportsVoice: false,
    supportsRealtime: false,
    ttsVoice: "alloy",
  });
  const [reportIssueOpen, setReportIssueOpen] = useState(false);

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
              ttsVoice: defaultOpt.ttsVoice ?? "alloy",
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
    setChatMode("text");
  }, [clearMessages]);

  const handleSelectConversation = useCallback((id: string) => {
    setActiveConversationId(id);
    setChatMode("text");
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

  const handleRealtimeTurn = useCallback(
    async (role: "user" | "assistant", text: string) => {
      let convId = activeConversationId;

      if (!convId) {
        const conv = await createConversation();
        if (!conv) return;
        convId = conv.id;
        setActiveConversationId(convId);
      }

      await fetch(`/api/conversations/${convId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, content: text }),
      });

      loadMessages(convId);
    },
    [activeConversationId, createConversation, loadMessages],
  );

  // Called by the realtime hook after each tool result is persisted to the DB.
  // Reloads the message list so title cards and other tool outputs appear
  // in the main chat window immediately after the tool completes.
  const handleRealtimeMessagesUpdated = useCallback(() => {
    if (activeConversationId) {
      loadMessages(activeConversationId);
    }
  }, [activeConversationId, loadMessages]);

  if (userLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner size={24} />
      </div>
    );
  }

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
        selectedModel={selectedModel}
      />

      {sidebarCollapsed && <SidebarToggle onClick={() => setSidebarCollapsed(false)} />}

      <main className="flex flex-1 flex-col min-w-0">
        <PwaInstallBanner />

        {/* Top toolbar: model selector (left) + report issue button (right) */}
        {(canChangeModel && models.length > 1) || activeConversationId ? (
          <div className={`flex items-center justify-between border-b py-1.5 ${sidebarCollapsed ? "pl-12 pr-4" : "px-4"}`}>
            {/* Model selector — left side */}
            {canChangeModel && models.length > 1 ? (
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
                      ttsVoice: opt?.ttsVoice ?? "alloy",
                    };
                    setEndpointCaps(caps);
                    setChatMode((prev) => {
                      if (prev === "voice" && !caps.supportsVoice) return "text";
                      // Realtime sessions are model-specific (baked into the WebRTC
                      // handshake). Always drop back to text on model change so the
                      // old session is torn down and the user reconnects fresh.
                      if (prev === "realtime") return "text";
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
            ) : (
              <span />
            )}

            {/* Report Issue button — right side, only shown when a conversation is active */}
            {activeConversationId ? (
              <button
                onClick={() => setReportIssueOpen(true)}
                className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                title="Report an issue with this conversation"
              >
                <Flag size={13} />
                Report Issue
              </button>
            ) : (
              <span />
            )}
          </div>
        ) : null}

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
          ttsVoice={endpointCaps.ttsVoice}
          lastResponse={messages.findLast((m) => m.role === "assistant")?.content ?? ""}
          conversationId={activeConversationId}
          onRealtimeTurn={handleRealtimeTurn}
          onRealtimeMessagesUpdated={handleRealtimeMessagesUpdated}
        />
      </main>

      {reportIssueOpen && activeConversationId && (
        <ReportIssueModal
          conversationId={activeConversationId}
          onClose={() => setReportIssueOpen(false)}
        />
      )}
    </div>
  );
}
