"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";
import { ChevronDown, ChevronRight, Wrench, CheckCircle, XCircle } from "lucide-react";
import type { ToolCallDisplay } from "@/types/chat";

interface ToolCallProps {
  toolCall: ToolCallDisplay;
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

  // Format the tool name for display
  const displayName = toolCall.name
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

  return (
    <div className="my-1 rounded-lg border bg-background/50 text-sm">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/30 rounded-lg transition-colors"
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Wrench size={14} className="text-muted-foreground" />
        <span className="flex-1 text-muted-foreground">{displayName}</span>
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
