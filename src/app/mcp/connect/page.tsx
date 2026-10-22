"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { privateLinkFragmentToken } from "@/lib/mcp/link-handoff";

interface LinkInfo { integrationName: string; channel: string; contextKind: string; expiresAt: string }
interface BrowserUser { id: number; plexUsername: string }
type Phase = "loading" | "ready" | "waiting" | "switching" | "preparing" | "handoff" | "error" | "expired";
class LinkPageError extends Error { constructor(public status: number) { super("Private linking failed"); } }

async function json<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store", referrerPolicy: "no-referrer" });
  const result = await response.json();
  if (!response.ok || !result.success) throw new LinkPageError(response.status);
  return result.data as T;
}
const tokenBody = (token: string) => ({ headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });

export default function ConnectAccountPage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [user, setUser] = useState<BrowserUser | null>(null);
  const [error, setError] = useState("");
  const [authUrl, setAuthUrl] = useState("");
  const [popupBlocked, setPopupBlocked] = useState(false);
  const [handoffUrl, setHandoffUrl] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const token = useRef<string | null>(null);
  const loadAbort = useRef<AbortController | null>(null);
  const authAbort = useRef<AbortController | null>(null);
  const handoffAbort = useRef<AbortController | null>(null);
  const handoffBusy = useRef(false);
  const popup = useRef<Window | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopAuth = useCallback(() => {
    authAbort.current?.abort();
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = null;
    try { if (popup.current && !popup.current.closed) popup.current.close(); } catch { /* Browser may sever a cross-origin popup reference. */ }
    popup.current = null;
  }, []);

  const showFailure = useCallback((cause: unknown) => {
    if (cause instanceof LinkPageError && cause.status === 410) setPhase("expired");
    else {
      setError(cause instanceof LinkPageError && cause.status === 409
        ? "This link is already in use or your sign-in changed. Ask your assistant for a new private link."
        : "Could not complete this step. Check your connection and try again, or ask your assistant for a new private link.");
      setPhase("error");
    }
  }, []);

  const load = useCallback(() => {
    loadAbort.current?.abort();
    const controller = new AbortController(); loadAbort.current = controller;
    // React's development effect replay retains this ref, so stripping the
    // fragment once cannot discard the token during the second effect run.
    if (token.current === null) token.current = privateLinkFragmentToken(window.location.hash) ?? "";
    window.history.replaceState(null, "", window.location.pathname);
    const value = token.current;
    const inspected = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new Error("Cancelled initialization");
      if (!value) throw new LinkPageError(410);
      return json<LinkInfo>("/api/mcp/account-links/inspect", { method: "POST", ...tokenBody(value), signal: controller.signal });
    });
    inspected.then(async (details) => {
      if (details.channel !== "whatsapp" || Date.parse(details.expiresAt) <= Date.now()) throw new LinkPageError(410);
      const session = await json<{ user: BrowserUser }>("/api/auth/session", { signal: controller.signal }).catch((cause) => {
        if (cause instanceof LinkPageError && cause.status === 401) return null;
        throw cause;
      });
      if (controller.signal.aborted) return;
      setInfo(details); setUser(session?.user ?? null); setNow(Date.now()); setPhase("ready");
    }).catch((cause) => { if (!controller.signal.aborted) showFailure(cause); });
  }, [showFailure]);

  useEffect(() => {
    load();
    const changed = () => {
      if (!window.location.hash) return;
      stopAuth(); handoffAbort.current?.abort(); handoffBusy.current = false;
      token.current = null; setInfo(null); setUser(null); setHandoffUrl(""); setAuthUrl(""); setError(""); setPhase("loading");
      load();
    };
    window.addEventListener("hashchange", changed);
    return () => { window.removeEventListener("hashchange", changed); loadAbort.current?.abort(); handoffAbort.current?.abort(); stopAuth(); };
  }, [load, stopAuth]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const deadline = info ? Date.parse(info.expiresAt) : Infinity;
  const expired = phase === "expired" || now >= deadline;

  async function signIn() {
    if (!info || Date.now() >= deadline) { setPhase("expired"); return; }
    stopAuth(); setError(""); setAuthUrl(""); setPhase("waiting");
    const controller = new AbortController(); authAbort.current = controller;
    // Open while the click gesture is still active; mobile browsers may block a
    // window opened only after awaiting the PIN request.
    try {
      popup.current = window.open("about:blank", "thinkarr-private-plex", "width=800,height=600,menubar=no,toolbar=no");
      if (popup.current) popup.current.opener = null;
    } catch { popup.current = null; }
    setPopupBlocked(!popup.current);
    try {
      const pin = await json<{ id: number; authUrl: string }>("/api/auth/plex", { method: "POST", signal: controller.signal });
      if (controller.signal.aborted) return;
      if (new URL(pin.authUrl).origin !== "https://app.plex.tv") throw new Error("Unexpected Plex origin");
      setAuthUrl(pin.authUrl);
      if (popup.current) popup.current.location.href = pin.authUrl;
      const poll = async () => {
        if (controller.signal.aborted) return;
        if (Date.now() >= deadline) { stopAuth(); setPhase("expired"); return; }
        try {
          const response = await fetch("/api/auth/callback", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pinId: pin.id }), signal: controller.signal, cache: "no-store", referrerPolicy: "no-referrer",
          });
          const result = await response.json();
          if (controller.signal.aborted) return;
          if (result.success) {
            stopAuth(); setUser(result.data.user); setPhase("ready"); return;
          }
          if (!response.ok || result.error !== "pending") {
            stopAuth(); setError("This Plex account could not sign in to Thinkarr. Check your account access with the server owner."); setPhase("error"); return;
          }
        } catch { if (controller.signal.aborted) return; }
        pollTimer.current = setTimeout(() => void poll(), 2000);
      };
      void poll();
    } catch (cause) {
      if (!controller.signal.aborted) { stopAuth(); showFailure(cause); }
    }
  }

  async function changeAccount() {
    setPhase("switching");
    try {
      await json("/api/auth/session", { method: "DELETE" });
      setUser(null); setPhase("ready");
    } catch (cause) { showFailure(cause); }
  }

  async function finish() {
    if (!user || !token.current || Date.now() >= deadline) { setPhase("expired"); return; }
    if (handoffUrl) { window.location.assign(handoffUrl); return; }
    if (handoffBusy.current) return;
    handoffBusy.current = true;
    setPhase("preparing"); setError("");
    const controller = new AbortController(); handoffAbort.current = controller;
    try {
      const prepared = await json<{ handoffUrl: string; expiresAt: string }>("/api/mcp/account-links/prepare", {
        method: "POST", ...tokenBody(token.current),
        headers: { "Content-Type": "application/json", "Thinkarr-Link-Expected-User": String(user.id) }, signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const url = new URL(prepared.handoffUrl);
      if (url.origin !== "https://wa.me" || !/^\/[1-9][0-9]{6,14}$/.test(url.pathname)
        || !/^Link account [a-f0-9]{64}$/.test(url.searchParams.get("text") ?? "") || [...url.searchParams].length !== 1 || url.username || url.password || url.hash) throw new Error("Invalid handoff");
      if (Date.parse(prepared.expiresAt) <= Date.now()) { setPhase("expired"); return; }
      setHandoffUrl(url.href); setPhase("handoff");
      window.location.assign(url.href);
    } catch (cause) { if (!controller.signal.aborted) { handoffBusy.current = false; showFailure(cause); } }
  }

  return <main className="min-h-screen flex items-center justify-center bg-background p-4">
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Connect your Plex account</CardTitle>
        <CardDescription>{info ? `Connect to ${info.integrationName} from WhatsApp.` : "Private account linking for your assistant."}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {expired ? <p role="alert" className="text-sm text-destructive">This link has expired or is no longer valid. Ask your assistant for a new private link.</p> : <>
          {phase === "loading" && <p role="status" className="flex items-center gap-2 text-sm"><Spinner /> Checking your private link…</p>}
          {phase === "ready" && (user ? <>
            <p className="text-sm">Signed in as <strong>{user.plexUsername}</strong>.</p>
            <p className="text-sm text-muted-foreground">We’ll open a private verification message. Tap Send in WhatsApp to finish linking.</p>
            <Button className="w-full" onClick={() => void finish()}>Finish in WhatsApp</Button>
            <Button variant="ghost" className="w-full" onClick={() => void changeAccount()}>Use another Plex account</Button>
          </> : <>
            <p className="text-sm text-muted-foreground">Sign in with your normal Plex account. Opening this link does not connect an account by itself.</p>
            <Button className="w-full" onClick={() => void signIn()}>Sign in with Plex</Button>
          </>)}
          {phase === "waiting" && <>
            <p role="status" className="flex items-center gap-2 text-sm"><Spinner /> Complete sign-in in Plex, then return here.</p>
            {popupBlocked && authUrl && <a className="block text-sm underline" href={authUrl} target="_blank" rel="noopener noreferrer">Open Plex sign-in</a>}
            <Button variant="ghost" onClick={() => { stopAuth(); setPhase("ready"); }}>Cancel sign-in</Button>
          </>}
          {phase === "preparing" && <p role="status" className="flex items-center gap-2 text-sm"><Spinner /> Preparing your private message…</p>}
          {phase === "switching" && <p role="status" className="flex items-center gap-2 text-sm"><Spinner /> Switching your Plex sign-in…</p>}
          {phase === "handoff" && <>
            <p className="text-sm">Tap Send on the prefilled WhatsApp message to complete linking.</p>
            <Button className="w-full" onClick={() => void finish()}>Open WhatsApp again</Button>
          </>}
          {phase === "error" && <>
            <p role="alert" className="text-sm text-destructive">{error}</p>
            <Button variant="secondary" onClick={() => { stopAuth(); setPhase("loading"); load(); }}>Check link again</Button>
          </>}
          {info && <p className="text-xs text-muted-foreground">Private link expires in {Math.max(0, Math.ceil((deadline - now) / 1000))} seconds.</p>}
        </>}
      </CardContent>
    </Card>
  </main>;
}
