"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/avatar";
import { MessageSquarePlus, Trash2, LogOut, PanelLeftClose, PanelLeft, Settings } from "lucide-react";
import { ServiceStatus } from "./service-status";
import { Badge } from "@/components/ui/badge";
import type { Conversation, User } from "@/types";

interface SidebarProps {
  conversations: Conversation[];
  activeId: string | null;
  user: User | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  collapsed: boolean;
  onToggle: () => void;
  selectedModel?: string;
}

export function Sidebar({
  conversations,
  activeId,
  user,
  onSelect,
  onNew,
  onDelete,
  collapsed,
  onToggle,
  selectedModel,
}: SidebarProps) {
  const router = useRouter();
  const [publicIp, setPublicIp] = useState<string | null>(null);

  useEffect(() => {
    fetch("https://api.ipify.org?format=json")
      .then((r) => r.json())
      .then((d) => setPublicIp(d.ip))
      .catch(() => {});
  }, []);

  async function handleLogout() {
    await fetch("/api/auth/session", { method: "DELETE" });
    router.push("/login");
  }

  // Group conversations by owner when admin viewing all users
  const hasMultipleOwners = conversations.some((c) => c.ownerName);
  const grouped = hasMultipleOwners
    ? groupByOwner(conversations)
    : [{ owner: null, conversations }];

  return (
    <>
      {/* Overlay backdrop — visible on mobile when sidebar is open */}
      {!collapsed && (
        <div
          className="fixed inset-0 z-10 bg-black/40 md:hidden"
          onClick={onToggle}
          aria-hidden="true"
        />
      )}
    <aside
      className={cn(
        "flex flex-col border-r bg-sidebar transition-all duration-200",
        collapsed
          ? "w-0 overflow-hidden border-r-0"
          : "fixed inset-y-0 left-0 z-20 w-64 md:relative md:inset-auto md:z-auto",
      )}
    >
      {/* Header */}
      <div className="flex h-14 items-center justify-between border-b border-sidebar-border px-3">
        <span className="text-sm font-semibold text-foreground">Thinkarr</span>
        <Button variant="ghost" size="icon" onClick={onToggle} className="h-8 w-8 text-sidebar-foreground">
          <PanelLeftClose size={16} />
        </Button>
      </div>

      {/* New Chat */}
      <div className="p-2">
        <Button variant="outline" className="w-full justify-start gap-2 text-sm" onClick={onNew}>
          <MessageSquarePlus size={16} />
          New Chat
        </Button>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto px-2">
        {grouped.map((group) => (
          <div key={group.owner || "self"}>
            {group.owner && (
              <div className="px-3 pt-3 pb-1 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                {group.owner}
              </div>
            )}
            {group.conversations.map((conv) => (
              <div
                key={conv.id}
                data-testid="conversation-item"
                data-conversation-id={conv.id}
                className={cn(
                  "group flex items-center rounded-lg px-3 py-2 text-sm cursor-pointer transition-colors",
                  conv.id === activeId
                    ? "bg-accent text-accent-foreground"
                    : "text-sidebar-foreground hover:bg-accent/50",
                )}
                onClick={() => onSelect(conv.id)}
              >
                <span className="flex-1 truncate">{conv.title || "New Chat"}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(conv.id);
                  }}
                  className="ml-1 rounded p-1 text-muted-foreground hover:text-destructive md:opacity-0 md:group-hover:opacity-100 transition-opacity"
                  aria-label="Delete chat"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* Service status traffic lights */}
      <ServiceStatus selectedModel={selectedModel} />

      {/* Version */}
      {process.env.NEXT_PUBLIC_APP_VERSION && (
        <div className="px-3 pb-1 flex items-center gap-1.5 text-xs text-muted-foreground/60">
          <span>{process.env.NEXT_PUBLIC_APP_VERSION}</span>
          {process.env.NEXT_PUBLIC_APP_VERSION.includes("-") && (
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-semibold">
              BETA
            </Badge>
          )}
          {publicIp && <span>on {publicIp}</span>}
        </div>
      )}

      {/* User menu */}
      {user && (
        <div className="border-t border-sidebar-border p-3">
          <div className="flex items-center gap-2">
            <Avatar src={user.plexAvatarUrl} fallback={user.plexUsername} size="sm" />
            <span className="flex-1 truncate text-sm text-sidebar-foreground">
              {user.plexUsername}
            </span>
            <Button variant="ghost" size="icon" onClick={() => router.push("/settings")} className="h-8 w-8 text-sidebar-foreground">
              <Settings size={14} />
            </Button>
            <Button variant="ghost" size="icon" onClick={handleLogout} className="h-8 w-8 text-sidebar-foreground">
              <LogOut size={14} />
            </Button>
          </div>
        </div>
      )}
    </aside>
    </>
  );
}

function groupByOwner(conversations: Conversation[]): { owner: string | null; conversations: Conversation[] }[] {
  const groups = new Map<string, Conversation[]>();
  for (const conv of conversations) {
    const owner = conv.ownerName || "Unknown";
    if (!groups.has(owner)) groups.set(owner, []);
    groups.get(owner)!.push(conv);
  }
  return Array.from(groups.entries()).map(([owner, convs]) => ({
    owner,
    conversations: convs,
  }));
}

/** Small toggle button visible when sidebar is collapsed */
export function SidebarToggle({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onClick}
      className="fixed left-2 top-3 z-10 h-8 w-8 text-muted-foreground"
    >
      <PanelLeft size={16} />
    </Button>
  );
}
