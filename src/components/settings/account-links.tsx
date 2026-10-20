"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface AccountLink {
  id: string; integrationName: string; integrationEnabled: boolean;
  channel: string; contextKind: "direct" | "group"; revokedAt: string | null;
}

export function AccountLinks() {
  const [links, setLinks] = useState<AccountLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    fetch("/api/account-links", { cache: "no-store" }).then(async (response) => {
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error();
      if (current) { setLinks(result.data); setLoading(false); }
    }).catch(() => { if (current) { setError("Could not load your assistant links."); setLoading(false); } });
    return () => { current = false; };
  }, []);

  async function unlink(id: string) {
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/account-links/${id}`, { method: "DELETE", cache: "no-store" });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error();
      setLinks((current) => current.map((link) => link.id === id ? { ...link, revokedAt: new Date().toISOString() } : link));
    } catch { setError("Could not unlink that assistant. Please try again."); }
    finally { setBusy(false); }
  }

  return <Card>
    <CardHeader>
      <CardTitle className="text-lg">Your group assistant links</CardTitle>
      <CardDescription>Manage verified channel links to your Plex-authenticated Thinkarr account.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-3">
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {loading ? <p role="status">Loading links…</p> : links.length === 0 ? <p className="text-sm text-muted-foreground">No verified assistant links yet. Ask your assistant for a private linking message.</p> : links.map((link) => <div key={link.id} className="flex items-center justify-between gap-3 rounded border p-3 text-sm">
        <div><p className="font-medium">{link.integrationName}</p><p className="text-xs text-muted-foreground">{link.channel} {link.contextKind} — {link.revokedAt ? "Unlinked" : link.integrationEnabled ? "Linked" : "Linked (integration disabled)"}</p></div>
        <Button variant="secondary" disabled={busy || !!link.revokedAt} aria-label={`Unlink ${link.integrationName}`} onClick={() => void unlink(link.id)}>{link.revokedAt ? "Unlinked" : "Unlink"}</Button>
      </div>)}
    </CardContent>
  </Card>;
}
