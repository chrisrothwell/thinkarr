"use client";

import { useEffect } from "react";
import { Phone, PhoneOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useRealtimeChat } from "@/hooks/use-realtime-chat";

interface RealtimeChatProps {
  modelId: string;
  conversationId?: string | null;
  onTurn?: (role: "user" | "assistant", text: string) => void;
  onMessagesUpdated?: () => void;
  transcriptionLanguage?: string;
}

export function RealtimeChat({
  modelId,
  conversationId,
  onTurn,
  onMessagesUpdated,
  transcriptionLanguage,
}: RealtimeChatProps) {
  const { connected, connecting, connect, disconnect, error } = useRealtimeChat(modelId, {
    onTurnComplete: onTurn,
    conversationId,
    onMessagesUpdated,
    transcriptionLanguage,
  });

  // Disconnect when the component unmounts (mode change, conversation switch, new chat)
  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-input bg-card p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm">
          <span
            className={`h-2 w-2 rounded-full ${
              connected ? "bg-green-500" : connecting ? "bg-yellow-500 animate-pulse" : "bg-muted-foreground"
            }`}
          />
          <span className="text-muted-foreground">
            {connected
              ? "Listening — speak now"
              : connecting
              ? "Connecting..."
              : "Disconnected"}
          </span>
        </div>

        {connected ? (
          <Button size="sm" variant="destructive" onClick={disconnect} className="gap-1.5">
            <PhoneOff size={14} />
            End call
          </Button>
        ) : (
          <Button size="sm" onClick={connect} disabled={connecting} className="gap-1.5">
            {connecting ? <Spinner size={14} /> : <Phone size={14} />}
            {connecting ? "Connecting..." : "Connect"}
          </Button>
        )}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
