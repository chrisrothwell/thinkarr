"use client";

import { Phone, PhoneOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useRealtimeChat } from "@/hooks/use-realtime-chat";

interface RealtimeChatProps {
  modelId: string;
}

export function RealtimeChat({ modelId }: RealtimeChatProps) {
  const { connected, connecting, transcript, connect, disconnect, error } = useRealtimeChat(modelId);

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-input bg-card p-4">
      {/* Status + controls */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm">
          <span
            className={`h-2 w-2 rounded-full ${
              connected ? "bg-green-500" : connecting ? "bg-yellow-500 animate-pulse" : "bg-muted-foreground"
            }`}
          />
          <span className="text-muted-foreground">
            {connected ? "Connected" : connecting ? "Connecting..." : "Disconnected"}
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

      {/* Live transcript */}
      {transcript.length > 0 && (
        <div className="max-h-48 overflow-y-auto space-y-1.5 text-sm">
          {transcript.map((turn, i) => (
            <div key={i} className={`flex gap-2 ${turn.role === "user" ? "justify-end" : "justify-start"}`}>
              <span
                className={`rounded-lg px-3 py-1.5 max-w-[80%] ${
                  turn.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-foreground"
                }`}
              >
                {turn.text}
              </span>
            </div>
          ))}
        </div>
      )}

      {connected && transcript.length === 0 && (
        <p className="text-xs text-muted-foreground text-center">Speak now — transcript will appear here</p>
      )}
    </div>
  );
}
