"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/avatar";
import { MessageSquarePlus, Trash2, LogOut, PanelLeftClose, PanelLeft, Settings } from "lucide-react";
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
}: SidebarProps) {
  const router = useRouter();
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  async function handleLogout() {
    await fetch("/api/auth/session", { method: "DELETE" });
    router.push("/login");
  }

  return (
    <aside
      className={cn(
        "flex flex-col border-r bg-sidebar transition-all duration-200",
        collapsed ? "w-0 overflow-hidden border-r-0" : "w-64",
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
        {conversations.map((conv) => (
          <div
            key={conv.id}
            className={cn(
              "group flex items-center rounded-lg px-3 py-2 text-sm cursor-pointer transition-colors",
              conv.id === activeId
                ? "bg-accent text-accent-foreground"
                : "text-sidebar-foreground hover:bg-accent/50",
            )}
            onClick={() => onSelect(conv.id)}
            onMouseEnter={() => setHoveredId(conv.id)}
            onMouseLeave={() => setHoveredId(null)}
          >
            <span className="flex-1 truncate">{conv.title || "New Chat"}</span>
            {hoveredId === conv.id && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(conv.id);
                }}
                className="ml-1 rounded p-1 text-muted-foreground hover:text-destructive"
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        ))}
      </div>

      {/* User menu */}
      {user && (
        <div className="border-t border-sidebar-border p-3">
          <div className="flex items-center gap-2">
            <Avatar src={user.plexAvatarUrl} fallback={user.plexUsername} size="sm" />
            <span className="flex-1 truncate text-sm text-sidebar-foreground">
              {user.plexUsername}
            </span>
            {user.isAdmin && (
              <Button variant="ghost" size="icon" onClick={() => router.push("/settings")} className="h-8 w-8 text-sidebar-foreground">
                <Settings size={14} />
              </Button>
            )}
            <Button variant="ghost" size="icon" onClick={handleLogout} className="h-8 w-8 text-sidebar-foreground">
              <LogOut size={14} />
            </Button>
          </div>
        </div>
      )}
    </aside>
  );
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
