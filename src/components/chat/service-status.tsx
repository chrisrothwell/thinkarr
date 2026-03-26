"use client";

import { useState, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

interface ServiceStatusItem {
  name: string;
  status: "green" | "amber" | "red";
  message: string;
}

const STATUS_COLORS = {
  green: "bg-green-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
} as const;

async function fetchServiceStatus(): Promise<ServiceStatusItem[]> {
  const res = await fetch("/api/services/status");
  const data = await res.json();
  return data.success ? data.data.services : [];
}

interface ServiceStatusProps {
  selectedModel?: string;
}

export function ServiceStatus({ selectedModel }: ServiceStatusProps) {
  const [services, setServices] = useState<ServiceStatusItem[]>([]);
  const [expanded, setExpanded] = useState(false);
  const prevModelRef = useRef<string | undefined>(selectedModel);

  useEffect(() => {
    const poll = () => fetchServiceStatus().then(setServices).catch(() => {});
    poll();
    const interval = setInterval(poll, 60000); // Poll every 60s
    return () => clearInterval(interval);
  }, []);

  // Immediately re-poll when selected model changes
  useEffect(() => {
    if (prevModelRef.current !== selectedModel) {
      prevModelRef.current = selectedModel;
      fetchServiceStatus().then(setServices).catch(() => {});
    }
  }, [selectedModel]);

  if (services.length === 0) return null;

  return (
    <div className="border-t border-sidebar-border px-3 py-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <div className="flex gap-1">
          {services.map((s) => (
            <div
              key={s.name}
              className={cn("h-2 w-2 rounded-full", STATUS_COLORS[s.status])}
              title={`${s.name}: ${s.message}`}
            />
          ))}
        </div>
        <span>Services</span>
      </button>

      {expanded && (
        <div className="mt-2 space-y-1">
          {services.map((s) => (
            <div key={s.name} className="flex items-center gap-2 text-xs">
              <div
                className={cn("h-2 w-2 rounded-full shrink-0", STATUS_COLORS[s.status])}
              />
              <span className="text-sidebar-foreground">{s.name}</span>
              <span className="text-muted-foreground truncate ml-auto">{s.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
