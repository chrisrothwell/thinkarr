"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

type AuthState = "idle" | "waiting" | "success" | "error";

export default function SetupPage() {
  const router = useRouter();
  const [state, setState] = useState<AuthState>("idle");
  const [error, setError] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const popupRef = useRef<Window | null>(null);

  const cleanup = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (popupRef.current && !popupRef.current.closed) {
      popupRef.current.close();
    }
  }, []);

  useEffect(() => {
    return cleanup;
  }, [cleanup]);

  async function startPlexAuth() {
    setState("waiting");
    setError("");
    cleanup();

    try {
      const res = await fetch("/api/auth/plex", { method: "POST" });
      const data = await res.json();

      if (!data.success) {
        throw new Error(data.error || "Failed to start Plex auth");
      }

      const { id: pinId, authUrl } = data.data;
      const popup = window.open(authUrl, "plex-auth", "width=800,height=600,menubar=no,toolbar=no");
      popupRef.current = popup;

      pollRef.current = setInterval(async () => {
        try {
          const cbRes = await fetch("/api/auth/callback", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pinId }),
          });
          const cbData = await cbRes.json();

          if (cbData.success) {
            cleanup();
            setState("success");
            // First user is admin — redirect to settings to complete configuration
            router.push("/settings");
          } else if (cbData.error !== "pending") {
            cleanup();
            setState("error");
            setError(cbData.error || "Authentication failed");
          }
        } catch {
          // Network error during poll — keep trying
        }
      }, 2000);

      setTimeout(() => {
        if (pollRef.current) {
          cleanup();
          setState("error");
          setError("Authentication timed out. Please try again.");
        }
      }, 5 * 60 * 1000);
    } catch (e: unknown) {
      setState("error");
      setError(e instanceof Error ? e.message : "Failed to start authentication");
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-3xl">Welcome to Thinkarr</CardTitle>
          <CardDescription className="mt-2">
            Your AI-powered media management assistant.
            Connect your Plex account to get started.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-4">
          {state === "idle" && (
            <>
              <Button onClick={startPlexAuth} className="w-full" size="lg">
                Login with Plex
              </Button>
              <p className="text-xs text-muted-foreground text-center">
                This user will become the Server Administrator.
              </p>
            </>
          )}

          {state === "waiting" && (
            <>
              <Spinner size={24} />
              <p className="text-sm text-muted-foreground text-center">
                Complete sign-in in the Plex popup window...
              </p>
              <Button variant="ghost" size="sm" onClick={() => { cleanup(); setState("idle"); }}>
                Cancel
              </Button>
            </>
          )}

          {state === "success" && (
            <p className="text-sm text-green-500 text-center">
              Authenticated! Redirecting to Settings...
            </p>
          )}

          {state === "error" && (
            <>
              <p className="text-sm text-destructive text-center">{error}</p>
              <Button onClick={startPlexAuth} variant="secondary">
                Try Again
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
