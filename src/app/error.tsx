"use client";

import { useEffect } from "react";
import { clientLog } from "@/lib/client-logger";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    clientLog.error("page error boundary caught", {
      message: error.message,
      digest: error.digest,
      stack: error.stack?.slice(0, 500),
    });
  }, [error]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
      <h2 className="text-lg font-semibold">Something went wrong</h2>
      <button
        onClick={reset}
        className="rounded px-4 py-2 text-sm underline"
      >
        Try again
      </button>
    </div>
  );
}
