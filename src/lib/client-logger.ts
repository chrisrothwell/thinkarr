"use client";

type LogLevel = "info" | "warn" | "error";

/** Fire-and-forget POST to /api/client-log. Never throws. */
function send(level: LogLevel, message: string, context?: Record<string, unknown>) {
  fetch("/api/client-log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ level, message, context }),
  }).catch(() => {
    // Best-effort — if the log endpoint itself is unreachable we can't do much
  });
}

export const clientLog = {
  info: (message: string, context?: Record<string, unknown>) => send("info", message, context),
  warn: (message: string, context?: Record<string, unknown>) => send("warn", message, context),
  error: (message: string, context?: Record<string, unknown>) => send("error", message, context),
};
