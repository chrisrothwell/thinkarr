"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";
import { ChevronDown, ChevronRight, Wrench, CheckCircle, XCircle } from "lucide-react";
import type { ToolCallDisplay } from "@/types/chat";

interface ToolCallProps {
  toolCall: ToolCallDisplay;
}

/** Map tool name prefix to service display name. */
const SERVICE_MAP: Record<string, string> = {
  plex: "Plex",
  sonarr: "Sonarr",
  radarr: "Radarr",
  overseerr: "Overseerr",
};

/** Format tool name into a human-readable action + service label. */
function formatToolLabel(name: string): { action: string; service: string | null } {
  const parts = name.split("_");
  const serviceKey = parts[0];
  const service = SERVICE_MAP[serviceKey] || null;
  const actionParts = service ? parts.slice(1) : parts;
  const action = actionParts
    .join(" ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return { action, service };
}

export function ToolCall({ toolCall }: ToolCallProps) {
  const [expanded, setExpanded] = useState(false);

  const statusIcon =
    toolCall.status === "calling" ? (
      <Spinner size={14} />
    ) : toolCall.status === "done" ? (
      <CheckCircle size={14} className="text-green-500" />
    ) : (
      <XCircle size={14} className="text-destructive" />
    );

  const { action, service } = formatToolLabel(toolCall.name);
  const label = service
    ? toolCall.status === "calling"
      ? `Running ${action} on ${service}...`
      : `${action} on ${service}`
    : toolCall.status === "calling"
      ? `Running ${action}...`
      : action;

  return (
    <div className="my-1 rounded-lg border bg-background/50 text-sm">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/30 rounded-lg transition-colors"
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Wrench size={14} className="text-muted-foreground" />
        <span className="flex-1 text-muted-foreground">{label}</span>
        {statusIcon}
      </button>

      {expanded && (
        <div className="border-t px-3 py-2 space-y-2">
          {toolCall.arguments && toolCall.arguments !== "{}" && (
            <div>
              <p className="text-xs text-muted-foreground mb-1">Arguments:</p>
              <pre className="text-xs bg-background rounded p-2 overflow-x-auto whitespace-pre-wrap">
                {formatJson(toolCall.arguments)}
              </pre>
            </div>
          )}
          {toolCall.result && (
            <div>
              <p className="text-xs text-muted-foreground mb-1">Result:</p>
              <pre
                className={cn(
                  "text-xs rounded p-2 overflow-x-auto whitespace-pre-wrap max-h-48 overflow-y-auto",
                  toolCall.status === "error" ? "bg-destructive/10" : "bg-background",
                )}
              >
                {formatJson(toolCall.result)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatJson(str: string): string {
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}
