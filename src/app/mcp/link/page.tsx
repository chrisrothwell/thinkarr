"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

type PageState = "loading" | "ready" | "waiting" | "success" | "error" | "expired";

export default function McpLinkPage() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";

  const [state, setState] = useState<PageState>("loading");
  const [channelType, setChannelType] = useState("");
  const [error, setError] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const popupRef = useRef<Window | null>(null);
  const pinIdRef = useRef<number | null>(null);

  const cleanup = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (popupRef.current && !popupRef.current.closed) popupRef.current.close();
  }, []);

  useEffect(() => { return cleanup; }, [cleanup]);

  useEffect(() => {
    if (!token) { setState("expired"); return; }
    fetch(`/api/mcp/link?token=${encodeURIComponent(token)}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.success) {
          setChannelType(d.data.channelType);
          setState("ready");
        } else {
          setState("expired");
        }
      })
      .catch(() => setState("expired"));
  }, [token]);

  async function startPlexAuth() {
    setState("waiting");
    setError("");
    cleanup();
    try {
      const res = await fetch("/api/auth/plex", { method: "POST" });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Failed to start Plex auth");
      const { id: pinId, authUrl } = data.data;
      pinIdRef.current = pinId;
      const popup = window.open(authUrl, "plex-auth", "width=800,height=600,menubar=no,toolbar=no");
      popupRef.current = popup;

      pollRef.current = setInterval(async () => {
        try {
          const cbRes = await fetch("/api/mcp/link", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pinId, registrationToken: token }),
          });
          const cbData = await cbRes.json();
          if (cbData.success) {
            cleanup();
            setState("success");
          } else if (cbData.error !== "pending") {
            cleanup();
            setState("error");
            setError(cbData.error || "Authentication failed");
          }
        } catch { /* keep polling */ }
      }, 2000);
    } catch (e) {
      setState("error");
      setError(e instanceof Error ? e.message : "Something went wrong");
    }
  }

  const channelLabel = channelType
    ? channelType.charAt(0).toUpperCase() + channelType.slice(1)
    : "messaging";

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Connect your Plex account</CardTitle>
          <CardDescription>
            Link your Plex account to use Thinkarr from {channelLabel}.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {state === "loading" && <Spinner className="mx-auto" />}

          {state === "expired" && (
            <p className="text-destructive text-sm">
              This link has expired or is invalid. Send another message to get a new one.
            </p>
          )}

          {state === "ready" && (
            <Button onClick={startPlexAuth}>Connect with Plex</Button>
          )}

          {state === "waiting" && (
            <div className="flex flex-col items-center gap-3 text-sm text-muted-foreground">
              <Spinner />
              <p>Waiting for Plex authorisation…</p>
            </div>
          )}

          {state === "success" && (
            <p className="text-sm text-green-500">
              ✓ Account linked. You can close this tab and return to {channelLabel}.
            </p>
          )}

          {state === "error" && (
            <>
              <p className="text-destructive text-sm">{error}</p>
              <Button variant="outline" onClick={() => setState("ready")}>Try again</Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
