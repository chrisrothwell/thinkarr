"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { X } from "lucide-react";
import { clientLog } from "@/lib/client-logger";

interface ReportIssueModalProps {
  conversationId: string;
  onClose: () => void;
}

type SubmitState = "idle" | "submitting" | "success" | "error";

export function ReportIssueModal({ conversationId, onClose }: ReportIssueModalProps) {
  const [description, setDescription] = useState("");
  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  const [issueUrl, setIssueUrl] = useState<string | undefined>();
  const [errorMsg, setErrorMsg] = useState<string>("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus textarea on mount
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Close on Escape
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const handleSubmit = useCallback(async () => {
    if (!description.trim() || submitState === "submitting") return;
    setSubmitState("submitting");
    setErrorMsg("");

    try {
      const res = await fetch("/api/report-issue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, description: description.trim() }),
      });
      const data = await res.json() as { success: boolean; data?: { issueUrl?: string; message?: string }; error?: string };

      if (!res.ok || !data.success) {
        setErrorMsg(data.error ?? "Failed to submit report. Please try again.");
        setSubmitState("error");
        return;
      }

      setIssueUrl(data.data?.issueUrl);
      setSubmitState("success");
    } catch (e: unknown) {
      clientLog.error("Report issue network failure", {
        errorName: e instanceof Error ? e.name : "UnknownError",
        errorMessage: e instanceof Error ? e.message : "Unknown error",
        online: typeof navigator !== "undefined" ? navigator.onLine : null,
        conversationId,
      });
      setErrorMsg("Network error. Please try again.");
      setSubmitState("error");
    }
  }, [conversationId, description, submitState]);

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="relative w-full max-w-lg rounded-xl border bg-card shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b px-5 py-4">
          <h2 className="text-base font-semibold">Report an Issue</h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          {submitState === "success" ? (
            <div className="space-y-3 text-center py-4">
              <p className="text-sm text-muted-foreground">
                Your report has been submitted. Thank you for the feedback!
              </p>
              {issueUrl && (
                <p className="text-sm">
                  <a
                    href={issueUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary underline underline-offset-4"
                  >
                    View issue on GitHub
                  </a>
                </p>
              )}
              <Button variant="secondary" onClick={onClose} className="w-full">
                Close
              </Button>
            </div>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Describe what went wrong. The conversation transcript, timestamps, and tool call
                details will be included automatically to help with troubleshooting.
              </p>

              <textarea
                ref={textareaRef}
                id="report-issue-description"
                name="description"
                className="w-full resize-none rounded-lg border border-input bg-background px-3 py-2.5 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
                placeholder="Describe the issue you observed..."
                rows={5}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={submitState === "submitting"}
              />

              {submitState === "error" && (
                <p className="text-sm text-destructive">{errorMsg}</p>
              )}

              <div className="flex gap-2 justify-end">
                <Button variant="ghost" onClick={onClose} disabled={submitState === "submitting"}>
                  Cancel
                </Button>
                <Button
                  onClick={handleSubmit}
                  disabled={!description.trim() || submitState === "submitting"}
                  className="min-w-[100px]"
                >
                  {submitState === "submitting" ? (
                    <span className="flex items-center gap-2">
                      <Spinner size={14} />
                      Submitting…
                    </span>
                  ) : (
                    "Submit Report"
                  )}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
