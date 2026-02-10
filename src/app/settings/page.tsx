"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { Avatar } from "@/components/ui/avatar";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  ArrowLeft,
  CheckCircle,
  XCircle,
  Plus,
  Trash2,
  RefreshCw,
  Copy,
  Link as LinkIcon,
} from "lucide-react";

// --- Types ---

interface LlmEndpoint {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  enabled: boolean;
}

interface ArrConfig {
  url: string;
  apiKey: string;
}

interface PlexConfig {
  url: string;
  token: string;
}

interface UserEntry {
  id: number;
  plexUsername: string;
  plexEmail: string | null;
  plexAvatarUrl: string | null;
  isAdmin: boolean | null;
  defaultModel: string;
  canChangeModel: boolean;
}

// --- Helpers ---

const ARR_SERVICES = [
  { key: "sonarr", label: "Sonarr", hint: "http://localhost:8989" },
  { key: "radarr", label: "Radarr", hint: "http://localhost:7878" },
  { key: "overseerr", label: "Overseerr", hint: "http://localhost:5055" },
] as const;

export default function SettingsPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // LLM state
  const [endpoints, setEndpoints] = useState<LlmEndpoint[]>([]);

  // Plex & Arrs state
  const [plexConfig, setPlexConfig] = useState<PlexConfig>({ url: "", token: "" });
  const [arrConfigs, setArrConfigs] = useState<Record<string, ArrConfig>>({});
  const [plexConnecting, setPlexConnecting] = useState(false);

  // MCP state
  const [mcpToken, setMcpToken] = useState<string>("");
  const [mcpTokenLoading, setMcpTokenLoading] = useState(false);

  // User state
  const [users, setUsers] = useState<UserEntry[]>([]);

  // Test results
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; message: string }>>({});

  // --- Load data ---
  useEffect(() => {
    Promise.all([
      fetch("/api/settings").then((r) => r.json()),
      fetch("/api/settings/users").then((r) => r.json()),
      fetch("/api/settings/mcp-token").then((r) => r.json()),
    ])
      .then(([settingsData, usersData, mcpData]) => {
        if (settingsData.success) {
          const d = settingsData.data;
          setEndpoints(d.llmEndpoints || []);
          setPlexConfig({ url: d.plex?.url || "", token: d.plex?.token || "" });
          const arrs: Record<string, ArrConfig> = {};
          for (const svc of ARR_SERVICES) {
            arrs[svc.key] = {
              url: d[svc.key]?.url || "",
              apiKey: d[svc.key]?.apiKey || "",
            };
          }
          setArrConfigs(arrs);
        }
        if (usersData.success) setUsers(usersData.data || []);
        if (mcpData.success) setMcpToken(mcpData.data?.token || "");
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // --- Save ---
  const handleSave = useCallback(async () => {
    setSaving(true);
    const body: Record<string, unknown> = {
      llmEndpoints: endpoints,
      plex: { url: plexConfig.url, token: plexConfig.token },
    };
    for (const svc of ARR_SERVICES) {
      body[svc.key] = arrConfigs[svc.key];
    }

    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.success) setSaved(true);
    } catch {
      // Silent fail
    } finally {
      setSaving(false);
    }
  }, [endpoints, plexConfig, arrConfigs]);

  // --- Test connection ---
  async function testConnection(sectionKey: string, url: string, apiKey: string, model?: string) {
    if (!url) return;
    try {
      const res = await fetch("/api/setup/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: sectionKey === "llm" ? "llm" : sectionKey,
          url,
          apiKey: apiKey === "••••••••" ? "" : apiKey,
          model,
        }),
      });
      const data = await res.json();
      setTestResults((prev) => ({
        ...prev,
        [sectionKey]: {
          success: data.data?.success ?? false,
          message: data.data?.message || data.error,
        },
      }));
    } catch {
      setTestResults((prev) => ({
        ...prev,
        [sectionKey]: { success: false, message: "Network error" },
      }));
    }
  }

  // --- LLM endpoint management ---
  function addEndpoint() {
    const id = `ep_${Date.now()}`;
    setEndpoints((prev) => [
      ...prev,
      {
        id,
        name: `Endpoint ${prev.length + 1}`,
        baseUrl: "https://api.openai.com/v1",
        apiKey: "",
        model: "gpt-4.1",
        systemPrompt: "",
        enabled: true,
      },
    ]);
    setSaved(false);
  }

  function updateEndpoint(id: string, field: string, value: string | boolean) {
    setEndpoints((prev) =>
      prev.map((ep) => (ep.id === id ? { ...ep, [field]: value } : ep)),
    );
    setSaved(false);
  }

  function removeEndpoint(id: string) {
    setEndpoints((prev) => prev.filter((ep) => ep.id !== id));
    setSaved(false);
  }

  // --- Plex Connect ---
  async function handlePlexConnect() {
    setPlexConnecting(true);
    try {
      const res = await fetch("/api/settings/plex-connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create" }),
      });
      const data = await res.json();
      if (!data.success) return;

      const { id: pinId, authUrl } = data.data;
      const popup = window.open(authUrl, "plexAuth", "width=800,height=600");

      // Poll for PIN claim
      const poll = setInterval(async () => {
        try {
          const checkRes = await fetch("/api/settings/plex-connect", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "check", pinId }),
          });
          const checkData = await checkRes.json();
          if (checkData.success && checkData.data.claimed) {
            clearInterval(poll);
            popup?.close();
            setPlexConfig((prev) => ({ ...prev, token: "••••••••" }));
            setPlexConnecting(false);
          }
        } catch {
          // Keep polling
        }
      }, 2000);

      // Stop polling after 5 minutes
      setTimeout(() => {
        clearInterval(poll);
        setPlexConnecting(false);
      }, 300000);
    } catch {
      setPlexConnecting(false);
    }
  }

  // --- MCP token ---
  async function regenerateMcpToken() {
    setMcpTokenLoading(true);
    try {
      const res = await fetch("/api/settings/mcp-token", { method: "POST" });
      const data = await res.json();
      if (data.success) setMcpToken(data.data.token);
    } catch {
      // Silent fail
    } finally {
      setMcpTokenLoading(false);
    }
  }

  // --- User management ---
  async function updateUser(userId: number, updates: Partial<Pick<UserEntry, "isAdmin" | "defaultModel" | "canChangeModel">>) {
    try {
      await fetch("/api/settings/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, ...updates }),
      });
      setUsers((prev) =>
        prev.map((u) => (u.id === userId ? { ...u, ...updates } : u)),
      );
    } catch {
      // Silent fail
    }
  }

  // --- Get all model options from endpoints ---
  const modelOptions = endpoints.filter((ep) => ep.enabled).map((ep) => ({
    label: `${ep.name} — ${ep.model}`,
    value: `${ep.id}:${ep.model}`,
  }));

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner size={24} />
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => router.push("/chat")}>
            <ArrowLeft size={18} />
          </Button>
          <h1 className="text-2xl font-semibold">Settings</h1>
        </div>

        <Tabs defaultValue="llm">
          <TabsList>
            <TabsTrigger value="llm">LLM Setup</TabsTrigger>
            <TabsTrigger value="services">Plex & Arrs</TabsTrigger>
            <TabsTrigger value="mcp">MCP</TabsTrigger>
            <TabsTrigger value="users">Users</TabsTrigger>
          </TabsList>

          {/* ===== TAB 1: LLM Setup ===== */}
          <TabsContent value="llm" className="mt-4 space-y-4">
            {endpoints.map((ep) => (
              <Card key={ep.id}>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Input
                        value={ep.name}
                        onChange={(e) => updateEndpoint(ep.id, "name", e.target.value)}
                        className="h-8 w-48 text-sm font-semibold"
                      />
                      <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={ep.enabled}
                          onChange={(e) => updateEndpoint(ep.id, "enabled", e.target.checked)}
                          className="rounded"
                        />
                        Enabled
                      </label>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => removeEndpoint(ep.id)}
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="space-y-1.5">
                    <Label>Base URL</Label>
                    <Input
                      value={ep.baseUrl}
                      onChange={(e) => updateEndpoint(ep.id, "baseUrl", e.target.value)}
                      placeholder="https://api.openai.com/v1"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>API Key</Label>
                    <Input
                      type="password"
                      value={ep.apiKey}
                      onChange={(e) => updateEndpoint(ep.id, "apiKey", e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Model</Label>
                    <Input
                      value={ep.model}
                      onChange={(e) => updateEndpoint(ep.id, "model", e.target.value)}
                      placeholder="gpt-4.1"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>System Prompt (optional)</Label>
                    <Textarea
                      value={ep.systemPrompt}
                      onChange={(e) => updateEndpoint(ep.id, "systemPrompt", e.target.value)}
                      placeholder="Custom system prompt for this endpoint..."
                      rows={3}
                    />
                  </div>
                </CardContent>
                <CardFooter className="flex items-center gap-3">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => testConnection("llm", ep.baseUrl, ep.apiKey, ep.model)}
                    disabled={!ep.baseUrl}
                  >
                    Test
                  </Button>
                  {testResults.llm && (
                    <TestResult result={testResults.llm} />
                  )}
                </CardFooter>
              </Card>
            ))}

            <Button variant="outline" onClick={addEndpoint} className="w-full gap-2">
              <Plus size={16} />
              Add LLM Endpoint
            </Button>
          </TabsContent>

          {/* ===== TAB 2: Plex & Arrs ===== */}
          <TabsContent value="services" className="mt-4 space-y-4">
            {/* Plex */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg">Plex</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1.5">
                  <Label>URL</Label>
                  <Input
                    value={plexConfig.url}
                    onChange={(e) => {
                      setPlexConfig((prev) => ({ ...prev, url: e.target.value }));
                      setSaved(false);
                    }}
                    placeholder="http://localhost:32400"
                  />
                  <p className="text-xs text-muted-foreground">e.g. http://localhost:32400</p>
                </div>
                <div className="space-y-1.5">
                  <Label>Plex Token</Label>
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      onClick={handlePlexConnect}
                      disabled={plexConnecting}
                      className="gap-2"
                    >
                      {plexConnecting ? <Spinner size={14} /> : <LinkIcon size={14} />}
                      {plexConfig.token ? "Reconnect to Plex" : "Connect to Plex"}
                    </Button>
                    {plexConfig.token && (
                      <span className="flex items-center gap-1.5 text-sm text-green-500">
                        <CheckCircle size={14} />
                        Token saved
                      </span>
                    )}
                  </div>
                </div>
              </CardContent>
              <CardFooter className="flex items-center gap-3">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => testConnection("plex", plexConfig.url, plexConfig.token)}
                  disabled={!plexConfig.url}
                >
                  Test
                </Button>
                {testResults.plex && <TestResult result={testResults.plex} />}
              </CardFooter>
            </Card>

            {/* Sonarr, Radarr, Overseerr */}
            {ARR_SERVICES.map((svc) => {
              const config = arrConfigs[svc.key] || { url: "", apiKey: "" };
              return (
                <Card key={svc.key}>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-lg">{svc.label}</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="space-y-1.5">
                      <Label>URL</Label>
                      <Input
                        value={config.url}
                        onChange={(e) => {
                          setArrConfigs((prev) => ({
                            ...prev,
                            [svc.key]: { ...prev[svc.key], url: e.target.value },
                          }));
                          setSaved(false);
                        }}
                        placeholder={svc.hint}
                      />
                      <p className="text-xs text-muted-foreground">e.g. {svc.hint}</p>
                    </div>
                    <div className="space-y-1.5">
                      <Label>API Key</Label>
                      <Input
                        type="password"
                        value={config.apiKey}
                        onChange={(e) => {
                          setArrConfigs((prev) => ({
                            ...prev,
                            [svc.key]: { ...prev[svc.key], apiKey: e.target.value },
                          }));
                          setSaved(false);
                        }}
                      />
                    </div>
                  </CardContent>
                  <CardFooter className="flex items-center gap-3">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => testConnection(svc.key, config.url, config.apiKey)}
                      disabled={!config.url}
                    >
                      Test
                    </Button>
                    {testResults[svc.key] && (
                      <TestResult result={testResults[svc.key]} />
                    )}
                  </CardFooter>
                </Card>
              );
            })}
          </TabsContent>

          {/* ===== TAB 3: MCP Settings ===== */}
          <TabsContent value="mcp" className="mt-4 space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">MCP Server</CardTitle>
                <CardDescription>
                  Connect third-party LLMs and services to your Thinkarr MCP tools.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label>MCP Endpoint</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      value={typeof window !== "undefined" ? `${window.location.origin}/api/mcp` : "/api/mcp"}
                      readOnly
                      className="font-mono text-sm"
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => navigator.clipboard.writeText(`${window.location.origin}/api/mcp`)}
                    >
                      <Copy size={14} />
                    </Button>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label>Bearer Token</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      value={mcpToken}
                      readOnly
                      className="font-mono text-sm"
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => navigator.clipboard.writeText(mcpToken)}
                    >
                      <Copy size={14} />
                    </Button>
                    <Button
                      variant="secondary"
                      size="icon"
                      onClick={regenerateMcpToken}
                      disabled={mcpTokenLoading}
                    >
                      {mcpTokenLoading ? <Spinner size={14} /> : <RefreshCw size={14} />}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Use this token as a Bearer token in the Authorization header.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label>Registered Tools</Label>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    {[
                      { name: "Plex", tools: ["search_library", "get_watch_history", "get_on_deck", "check_availability"] },
                      { name: "Sonarr", tools: ["search_series", "get_calendar", "get_queue", "list_series", "monitor_series"] },
                      { name: "Radarr", tools: ["search_movie", "list_movies", "get_queue", "monitor_movie"] },
                      { name: "Overseerr", tools: ["search", "request_movie", "request_tv", "list_requests"] },
                    ].map((svc) => (
                      <div key={svc.name} className="rounded-lg border p-3">
                        <p className="font-medium text-foreground mb-1">{svc.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {svc.tools.length} tool{svc.tools.length !== 1 ? "s" : ""}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ===== TAB 4: User Settings ===== */}
          <TabsContent value="users" className="mt-4 space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">User Management</CardTitle>
                <CardDescription>
                  Manage user permissions and default model assignments.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {users.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No users found.</p>
                ) : (
                  <div className="space-y-4">
                    {users.map((user) => (
                      <div
                        key={user.id}
                        className="flex items-start gap-3 rounded-lg border p-3"
                      >
                        <Avatar
                          src={user.plexAvatarUrl}
                          fallback={user.plexUsername}
                          size="sm"
                        />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">
                            {user.plexUsername}
                          </p>
                          {user.plexEmail && (
                            <p className="text-xs text-muted-foreground truncate">
                              {user.plexEmail}
                            </p>
                          )}

                          <div className="mt-2 flex flex-wrap gap-3">
                            {/* Role selector */}
                            <label className="flex items-center gap-1.5 text-sm">
                              <span className="text-muted-foreground">Role:</span>
                              <select
                                value={user.isAdmin ? "admin" : "user"}
                                onChange={(e) =>
                                  updateUser(user.id, {
                                    isAdmin: e.target.value === "admin",
                                  })
                                }
                                className="rounded border bg-background px-2 py-0.5 text-sm"
                              >
                                <option value="admin">Administrator</option>
                                <option value="user">User</option>
                              </select>
                            </label>

                            {/* Default model */}
                            <label className="flex items-center gap-1.5 text-sm">
                              <span className="text-muted-foreground">Model:</span>
                              <select
                                value={user.defaultModel || ""}
                                onChange={(e) =>
                                  updateUser(user.id, {
                                    defaultModel: e.target.value,
                                  })
                                }
                                className="rounded border bg-background px-2 py-0.5 text-sm"
                              >
                                <option value="">System Default</option>
                                {modelOptions.map((opt) => (
                                  <option key={opt.value} value={opt.value}>
                                    {opt.label}
                                  </option>
                                ))}
                              </select>
                            </label>

                            {/* Can change model */}
                            <label className="flex items-center gap-1.5 text-sm">
                              <input
                                type="checkbox"
                                checked={user.canChangeModel}
                                onChange={(e) =>
                                  updateUser(user.id, {
                                    canChangeModel: e.target.checked,
                                  })
                                }
                                className="rounded"
                              />
                              <span className="text-muted-foreground">
                                Can change model
                              </span>
                            </label>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* Save button (global) */}
        <div className="mt-6 flex items-center gap-3">
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Spinner className="mr-2" size={14} />}
            Save Changes
          </Button>
          {saved && (
            <CardDescription className="text-green-500">
              Settings saved successfully.
            </CardDescription>
          )}
        </div>
      </div>
    </div>
  );
}

function TestResult({ result }: { result: { success: boolean; message: string } }) {
  return (
    <div className="flex items-center gap-1.5 text-sm">
      {result.success ? (
        <CheckCircle size={14} className="text-green-500" />
      ) : (
        <XCircle size={14} className="text-destructive" />
      )}
      <span className={result.success ? "text-green-500" : "text-destructive"}>
        {result.message}
      </span>
    </div>
  );
}
