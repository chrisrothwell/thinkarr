"use client";

import { useEffect } from "react";
import { clientLog } from "@/lib/client-logger";

/**
 * Mounts global listeners for unhandled JS errors and unhandled promise
 * rejections, forwarding them to the server log via clientLog so they appear
 * in /api/internal/logs alongside backend events.
 *
 * Renders nothing — include once in the root layout.
 */
export function ErrorLogger() {
  useEffect(() => {
    function handleError(event: ErrorEvent) {
      clientLog.error("unhandled error", {
        message: event.message,
        source: event.filename,
        line: event.lineno,
        col: event.colno,
      });
    }

    function handleUnhandledRejection(event: PromiseRejectionEvent) {
      const message =
        event.reason instanceof Error
          ? event.reason.message
          : String(event.reason);
      clientLog.error("unhandled promise rejection", { message });
    }

    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);
    return () => {
      window.removeEventListener("error", handleError);
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
    };
  }, []);

  return null;
}
