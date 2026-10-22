"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { copyToClipboard } from "@/lib/utils";

interface Integration {
  id: string; name: string; enabled: boolean; allowedOperations: string[];
  publicLinkOrigin: string | null; whatsappBotNumber: string | null;
  pilotGroup: string | null;
}
interface Credential {
  id: string; prefix: string; expiresAt: string; revokedAt: string | null; lastUsedAt: string | null;
}
interface VerificationKey {
  id: string; issuer: string; keyId: string; revokedAt: string | null;
}
interface Detail extends Integration {
  credentials: Credential[]; keys: VerificationKey[];
  audit: { id: string; action: string; createdAt: string; actorUserId: number | null }[];
  bindings: { id: string; userId: number; channel: string; contextKind: string; revokedAt: string | null }[];
}
interface Catalog {
  integrations: Integration[]; availableOperations: string[];
  delegatedAccessAvailable: boolean; delegationAudience: string;
}
const base = "/api/settings/mcp-integrations";
const active = (credential: Credential) => !credential.revokedAt && Date.parse(credential.expiresAt) > Date.now();
const date = (value: string | null) => value ? new Date(value).toLocaleString() : "Never used";

async function api<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method, cache: "no-store",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(result.error || "Integration operation failed");
  return result.data as T;
}

/** Mounted only for administrators. Secrets live in component memory only. */
export function McpIntegrations() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [newName, setNewName] = useState("");
  const [name, setName] = useState("");
  const [operations, setOperations] = useState<string[]>([]);
  const [linkOrigin, setLinkOrigin] = useState("");
  const [botNumber, setBotNumber] = useState("");
  const [group, setGroup] = useState("");
  const [expires, setExpires] = useState(90);
  const [overlap, setOverlap] = useState(0);
  const [issuer, setIssuer] = useState("");
  const [keyId, setKeyId] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [setupSecret, setSetupSecret] = useState<{ token: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => api<Catalog>(base).then(setCatalog), []);
  useEffect(() => { reload().catch(() => setError("Could not load integrations.")); }, [reload]);

  async function loadDetail(id: string, updateForm = true) {
    const value = await api<Detail>(`${base}/${id}`);
    setDetail(value);
    if (updateForm) {
      setName(value.name); setOperations(value.allowedOperations);
      setLinkOrigin(value.publicLinkOrigin ?? ""); setBotNumber(value.whatsappBotNumber ?? "");
      setGroup(value.pilotGroup ?? "");
    }
  }
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Integration operation failed"); }
    finally { setBusy(false); }
  }
  function create(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const created = await api<Integration>(base, "POST", { name: newName });
      setSecret(null); setSetupSecret(null); setNewName(""); await reload(); await loadDetail(created.id);
    });
  }
  function save(event: FormEvent) {
    event.preventDefault();
    if (!detail) return;
    void run(async () => {
      await api(`${base}/${detail.id}`, "PATCH", {
        name, allowedOperations: operations,
        publicLinkOrigin: linkOrigin.trim() || null, whatsappBotNumber: botNumber.trim() || null,
        pilotGroup: group.trim() || null,
      });
      setSetupSecret(null);
      await reload(); await loadDetail(detail.id);
    });
  }
  function issue(replaceCredentialId?: string) {
    if (!detail) return;
    void run(async () => {
      const created = await api<{ token: string }>(`${base}/${detail.id}/credentials`, "POST", {
        expiresInDays: expires, ...(replaceCredentialId ? { replaceCredentialId, overlapMinutes: overlap } : {}),
      });
      setSecret(created.token);
      setSetupSecret(null);
      await loadDetail(detail.id, false);
    });
  }
  function registerKey(event: FormEvent) {
    event.preventDefault();
    if (!detail) return;
    void run(async () => {
      await api(`${base}/${detail.id}/keys`, "POST", { issuer, keyId, publicKeyPem: publicKey });
      setKeyId(""); setPublicKey(""); await loadDetail(detail.id, false);
    });
  }
  const copy = (value: string) => { void copyToClipboard(value).catch(() => setError("Could not copy to clipboard.")); };
  const activeCredentials = detail?.credentials.filter(active).length ?? 0;

  return (
    <Card aria-labelledby="integrations-heading">
      <CardHeader>
        <CardTitle id="integrations-heading" className="text-lg">Service integrations</CardTitle>
        <CardDescription>Manage scoped machine callers separately from personal MCP tokens and Plex accounts.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-sm text-muted-foreground">Configure and enable each integration here. Access is restricted to its saved WhatsApp group; container changes and restarts are not required.</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {!catalog ? <p role="status">Loading integrations…</p> : <>
          <div className="space-y-1.5">
            <Label htmlFor="delegation-audience">Delegation audience</Label>
            <div className="flex gap-2">
              <Input id="delegation-audience" readOnly value={catalog.delegationAudience} className="font-mono text-xs" />
               <Button variant="secondary" onClick={() => copy(catalog.delegationAudience)}>Copy audience</Button>
             </div>
             <p className="text-xs text-muted-foreground">Public instance identifier, available before issuing credentials. Agents can discover it without Plex sign-in at <code>/api/mcp/info</code>.</p>
          </div>
          <form onSubmit={create} className="space-y-2">
            <Label htmlFor="new-integration-name">New integration name</Label>
            <div className="flex gap-2">
              <Input id="new-integration-name" required maxLength={100} value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Helga — Tiong Bahru Crew" />
              <Button type="submit" disabled={busy || !newName.trim()}>Create integration</Button>
            </div>
          </form>
          <div className="flex flex-wrap gap-2" aria-label="Choose integration">
            {catalog.integrations.map((integration) => <Button key={integration.id} variant={detail?.id === integration.id ? "default" : "secondary"} disabled={busy} onClick={() => {
              setSecret(null); setSetupSecret(null); setPublicKey(""); setKeyId(""); setIssuer(""); void run(() => loadDetail(integration.id));
            }}>{integration.name}</Button>)}
            {!catalog.integrations.length && <p className="text-sm text-muted-foreground">No service integrations yet.</p>}
          </div>
        </>}

        {detail && <div className="space-y-6 border-t pt-4">
          <p className="text-sm">Status: <strong>{detail.enabled ? "Enabled" : "Disabled"}</strong></p>
          <div className="space-y-1.5"><Label htmlFor="integration-id">Integration ID</Label><div className="flex gap-2">
            <Input id="integration-id" readOnly value={detail.id} className="font-mono text-xs" />
            <Button type="button" variant="secondary" onClick={() => copy(detail.id)}>Copy ID</Button>
          </div></div>
          <form onSubmit={save} className="space-y-3">
            <Label htmlFor="integration-name">Integration name</Label>
            <Input id="integration-name" required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} />
            <div className="space-y-1"><Label htmlFor="integration-group">WhatsApp group ID</Label><Input id="integration-group" maxLength={512} value={group} placeholder="120300000000@g.us" onChange={(event) => setGroup(event.target.value)} /></div>
            <p className="text-xs text-muted-foreground">Use the native group ID from OpenClaw. Changing the group invalidates existing participant links and pending verification; participants must link again.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1"><Label htmlFor="integration-link-origin">Public linking origin</Label><Input id="integration-link-origin" type="url" maxLength={2048} value={linkOrigin} placeholder="https://thinkarr.example.com" onChange={(event) => setLinkOrigin(event.target.value)} /></div>
              <div className="space-y-1"><Label htmlFor="integration-bot-number">WhatsApp bot number</Label><Input id="integration-bot-number" type="tel" maxLength={16} value={botNumber} placeholder="+15555550100" onChange={(event) => setBotNumber(event.target.value)} /></div>
            </div>
            <p className="text-xs text-muted-foreground">Use the Thinkarr HTTPS origin reachable from participants&apos; phones and the bot&apos;s international number. Changing either invalidates pending linking challenges.</p>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Operation allowlist</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {catalog?.availableOperations.map((operation) => <label key={operation} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={operations.includes(operation)} onChange={(event) => setOperations((current) => event.target.checked ? [...current, operation] : current.filter((value) => value !== operation))} />
                  <span className="font-mono text-xs">{operation}</span>
                </label>)}
              </div>
            </fieldset>
            <div className="flex gap-2">
               <Button type="submit" disabled={busy}>Save integration</Button>
               {catalog?.delegatedAccessAvailable && !detail.enabled && <Button type="button" disabled={busy || !group.trim() || !linkOrigin.trim() || !botNumber.trim()} onClick={() => void run(async () => {
                 await api(`${base}/${detail.id}`, "PATCH", { name, allowedOperations: operations, pilotGroup: group.trim(), publicLinkOrigin: linkOrigin.trim(), whatsappBotNumber: botNumber.trim(), enabled: true }); await reload(); await loadDetail(detail.id);
               })}>Enable integration</Button>}
              <Button type="button" variant="secondary" disabled={busy || !detail.enabled} onClick={() => void run(async () => {
                await api(`${base}/${detail.id}`, "PATCH", { enabled: false }); setSetupSecret(null); await reload(); await loadDetail(detail.id, false);
              })}>Disable integration</Button>
            </div>
          </form>

           <div className="space-y-3">
             <h4 className="font-medium">Agent connection setup</h4>
             <p className="text-sm text-muted-foreground">Authorize the agent to register one signing key and obtain a scoped service credential through the API. No agent browser or Plex sign-in is needed. The code expires after ten minutes and can be used once; configuration changes invalidate it.</p>
             <Button disabled={busy || activeCredentials > 0 || !group.trim() || !linkOrigin.trim() || !botNumber.trim()} onClick={() => void run(async () => {
               setSetupSecret(null);
               await api(`${base}/${detail.id}`, "PATCH", { name, allowedOperations: operations, pilotGroup: group.trim(), publicLinkOrigin: linkOrigin.trim(), whatsappBotNumber: botNumber.trim() });
               await reload(); await loadDetail(detail.id);
               setSetupSecret(await api<{ token: string; expiresAt: string }>(`${base}/${detail.id}/setup`, "POST", {}));
             })}>Create setup code</Button>
             {activeCredentials > 0 && <p className="text-xs text-muted-foreground">An active credential already exists. Reuse its protected configuration, or explicitly revoke it below before enrolling a new connection.</p>}
             {setupSecret && <div className="rounded-lg border p-3 space-y-2">
               <Label htmlFor="connection-setup-code">Setup code (shown once)</Label>
               <Textarea id="connection-setup-code" readOnly value={setupSecret.token} className="font-mono text-xs" />
               <p className="text-xs text-muted-foreground">Expires {new Date(setupSecret.expiresAt).toLocaleString()}. Enter it only into the trusted setup helper&apos;s hidden prompt, not agent chat. The helper stores credentials as protected OpenClaw secrets, not a credentials file.</p>
               <div className="flex gap-2"><Button variant="secondary" onClick={() => copy(setupSecret.token)}>Copy setup code</Button><Button variant="ghost" onClick={() => setSetupSecret(null)}>Dismiss setup code</Button></div>
             </div>}
           </div>

           <div className="space-y-3">
             <h4 className="font-medium">Credentials</h4>
             <p className="text-xs text-muted-foreground">Issue credential creates only a service bearer. It does not create the public delegation audience; use Agent connection setup for API enrollment.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1"><Label htmlFor="credential-days">Credential lifetime (days)</Label><Input id="credential-days" type="number" min={1} max={365} value={expires} onChange={(event) => setExpires(Number(event.target.value))} /></div>
              <div className="space-y-1"><Label htmlFor="credential-overlap">Rotation overlap (minutes)</Label><Input id="credential-overlap" type="number" min={0} max={60} value={overlap} onChange={(event) => setOverlap(Number(event.target.value))} /></div>
            </div>
            <Button disabled={busy || activeCredentials > 0 || expires < 1 || expires > 365} onClick={() => issue()}>Issue credential</Button>
            {secret && <div className="rounded-lg border p-3 space-y-2">
              <Label htmlFor="new-service-secret">New credential (shown once)</Label>
              <Textarea id="new-service-secret" readOnly value={secret} className="font-mono text-xs" />
              <p className="text-xs text-muted-foreground">Copy it into your trusted connector now. It cannot be retrieved after this view is dismissed.</p>
              <div className="flex gap-2"><Button variant="secondary" onClick={() => copy(secret)}>Copy new credential</Button><Button variant="ghost" onClick={() => setSecret(null)}>Dismiss secret</Button></div>
            </div>}
            <div className="overflow-x-auto">
              <table className="w-full text-sm" aria-label="Integration credentials">
                <thead><tr className="text-left"><th>Prefix</th><th>Status</th><th>Expires</th><th>Last used</th><th>Actions</th></tr></thead>
                <tbody>{detail.credentials.map((credential) => <tr key={credential.id} className="border-t">
                  <td className="py-2 font-mono text-xs">{credential.prefix}</td>
                  <td>{credential.revokedAt ? "Revoked" : active(credential) ? "Active" : "Expired"}</td>
                  <td>{date(credential.expiresAt)}</td><td>{date(credential.lastUsedAt)}</td>
                  <td><div className="flex gap-1">
                    <Button variant="ghost" size="sm" disabled={busy || !active(credential) || activeCredentials >= 2 || overlap < 0 || overlap > 60 || expires < 1 || expires > 365} aria-label={`Rotate credential ${credential.prefix}`} onClick={() => issue(credential.id)}>Rotate</Button>
                    <Button variant="ghost" size="sm" disabled={busy || !!credential.revokedAt} aria-label={`Revoke credential ${credential.prefix}`} onClick={() => void run(async () => { await api(`${base}/${detail.id}/credentials/${credential.id}`, "DELETE"); await loadDetail(detail.id, false); })}>Revoke</Button>
                  </div></td>
                </tr>)}</tbody>
              </table>
            </div>
          </div>

          <form onSubmit={registerKey} className="space-y-3">
            <h4 className="font-medium">Verification keys</h4>
            <p className="text-xs text-muted-foreground">Register the connector&apos;s Ed25519 public key. Keep its private signing key on the connector.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1"><Label htmlFor="key-issuer">Connector issuer</Label><Input id="key-issuer" required maxLength={200} value={issuer} onChange={(event) => setIssuer(event.target.value)} /></div>
              <div className="space-y-1"><Label htmlFor="key-id">Key ID</Label><Input id="key-id" required maxLength={80} value={keyId} onChange={(event) => setKeyId(event.target.value)} /></div>
            </div>
            <Label htmlFor="public-verification-key">Ed25519 public key (PEM)</Label>
            <Textarea id="public-verification-key" required maxLength={4096} value={publicKey} onChange={(event) => setPublicKey(event.target.value)} className="font-mono text-xs" />
            <Button type="submit" disabled={busy || detail.keys.filter((key) => !key.revokedAt).length >= 4}>Register public key</Button>
            {detail.keys.map((key) => <div key={key.id} className="flex items-center justify-between gap-2 rounded border p-2 text-sm">
              <span>{key.issuer} / {key.keyId} — {key.revokedAt ? "Revoked" : "Active"}</span>
              <Button type="button" variant="ghost" size="sm" disabled={busy || !!key.revokedAt} onClick={() => void run(async () => { await api(`${base}/${detail.id}/keys/${key.id}`, "DELETE"); await loadDetail(detail.id, false); })}>Revoke key {key.keyId}</Button>
            </div>)}
          </form>

          <div className="space-y-2">
            <h4 className="font-medium">Linked participants</h4>
            {detail.bindings.length === 0 && <p className="text-xs text-muted-foreground">No verified participant links yet.</p>}
            {detail.bindings.map((binding) => <div key={binding.id} className="flex items-center justify-between gap-2 rounded border p-2 text-sm">
              <span>User {binding.userId} · {binding.channel} {binding.contextKind} · {binding.revokedAt ? "Revoked" : "Linked"}</span>
              <Button variant="ghost" size="sm" disabled={busy || !!binding.revokedAt} aria-label={`Revoke participant link ${binding.id}`} onClick={() => void run(async () => {
                await api(`${base}/${detail.id}/bindings/${binding.id}`, "DELETE"); await loadDetail(detail.id, false);
              })}>Revoke link</Button>
            </div>)}
          </div>

          <div className="space-y-2">
            <h4 className="font-medium">Recent integration activity</h4>
            <ul className="space-y-1 text-xs text-muted-foreground">{detail.audit.map((event) => <li key={event.id}>{date(event.createdAt)} — {event.action} — {event.actorUserId === null ? "service caller" : `Thinkarr user ${event.actorUserId}`}</li>)}</ul>
          </div>
        </div>}
      </CardContent>
    </Card>
  );
}
