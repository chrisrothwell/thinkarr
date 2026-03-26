"use client";

import { useState, useEffect, useCallback, useRef } from "react";
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
  Search,
  FileText,
  Download,
} from "lucide-react";
import { DEFAULT_SYSTEM_PROMPT, DEFAULT_REALTIME_SYSTEM_PROMPT } from "@/lib/llm/default-prompt";
import { copyToClipboard } from "@/lib/utils";
import { usePwaInstall } from "@/hooks/use-pwa-install";

// --- Types ---

interface LlmEndpoint {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  enabled: boolean;
  isDefault: boolean;
  supportsVoice: boolean;
  supportsRealtime: boolean;
  realtimeModel: string;
  realtimeSystemPrompt: string;
  /** UI-only: tracks whether the user has chosen the default or a custom prompt. Not persisted. */
  promptMode?: "default" | "custom";
  /** UI-only: tracks whether the user has chosen the default or a custom realtime prompt. Not persisted. */
  realtimePromptMode?: "default" | "custom";
}

interface ArrConfig {
  url: string;
  apiKey: string;
}

interface PlexConfig {
  url: string;
  token: string;
}

interface PlexDevice {
  name: string;
  clientIdentifier: string;
  accessToken: string;
  owned: boolean;
  connections: { protocol: string; address: string; port: number; uri: string; local: boolean }[];
}

interface UserEntry {
  id: number;
  plexUsername: string;
  plexEmail: string | null;
  plexAvatarUrl: string | null;
  isAdmin: boolean | null;
  defaultModel: string;
  canChangeModel: boolean;
  rateLimitMessages: number;
  rateLimitPeriod: "hour" | "day" | "week" | "month";
  msgCount24h: number;
  msgCount7d: number;
  msgCount30d: number;
  mcpToken?: string;
  mcpTokenLoading?: boolean;
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

  // Current session user (determines admin vs non-admin view)
  const [currentUser, setCurrentUser] = useState<{ id: number; isAdmin: boolean; plexUsername: string; plexAvatarUrl: string | null; plexEmail: string | null } | null>(null);

  // LLM state (admin only)
  const [endpoints, setEndpoints] = useState<LlmEndpoint[]>([]);

  // Plex & Arrs state (admin only)
  const [plexConfig, setPlexConfig] = useState<PlexConfig>({ url: "", token: "" });
  const [arrConfigs, setArrConfigs] = useState<Record<string, ArrConfig>>({});

  // Initial setup mode + redirect countdown (admin only)
  const [isInitialSetup, setIsInitialSetup] = useState(false);
  const [redirectCountdown, setRedirectCountdown] = useState<number | null>(null);
  const countdownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track the last-saved config so we can warn on unsaved changes
  const savedConfigRef = useRef<string>("");

  // Plex discovery state (admin only)
  const [plexDiscovering, setPlexDiscovering] = useState(false);
  const [plexDevices, setPlexDevices] = useState<PlexDevice[]>([]);
  const [plexDiscoverError, setPlexDiscoverError] = useState<string | null>(null);

  // MCP state — admin global token; also per-user token for non-admins
  const [mcpToken, setMcpToken] = useState<string>("");
  const [mcpTokenLoading, setMcpTokenLoading] = useState(false);

  // User state (admin only)
  const [users, setUsers] = useState<UserEntry[]>([]);

  // Test results (admin only)
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; message: string }>>({});

  // PWA install (also registers SW and captures beforeinstallprompt)
  const { isAvailable: pwaInstallAvailable, isMobile: pwaMobile, isIosDevice: pwaIsIos, install: triggerPwaInstall } = usePwaInstall();

  // GitHub config (admin only)
  const [githubConfig, setGithubConfig] = useState({ token: "", owner: "", repo: "" });

  // Log state (admin only)
  const [logFiles, setLogFiles] = useState<{ name: string; size: number; modified: string }[]>([]);
  const [logFilesLoading, setLogFilesLoading] = useState(false);
  const [logFilesLoaded, setLogFilesLoaded] = useState(false);
  const [selectedLogFile, setSelectedLogFile] = useState<string | null>(null);
  const [logContent, setLogContent] = useState<string>("");
  const [logContentLoading, setLogContentLoading] = useState(false);
  const [logTotalLines, setLogTotalLines] = useState(0);
  const [logShowing, setLogShowing] = useState(0);

  // Internal API key state (admin only)
  const [internalApiKey, setInternalApiKey] = useState<string>("");
  const [internalApiKeyLoading, setInternalApiKeyLoading] = useState(false);

  // --- Load data ---
  useEffect(() => {
    // Always fetch session first to determine admin status
    fetch("/api/auth/session")
      .then((r) => r.json())
      .then(async (sessionData) => {
        if (!sessionData.success) return;
        const user = sessionData.data.user;
        setCurrentUser(user);

        if (user.isAdmin) {
          // Admin: load full settings
          const [settingsData, usersData, mcpData] = await Promise.all([
            fetch("/api/settings").then((r) => r.json()),
            fetch("/api/settings/users").then((r) => r.json()),
            fetch("/api/settings/mcp-token").then((r) => r.json()),
          ]);

          if (settingsData.success) {
            const d = settingsData.data;
            if ((d.llmEndpoints || []).length === 0) setIsInitialSetup(true);
            setEndpoints(
              (d.llmEndpoints || []).map((ep: LlmEndpoint) => ({
                ...ep,
                supportsVoice: ep.supportsVoice ?? false,
                supportsRealtime: ep.supportsRealtime ?? false,
                realtimeModel: ep.realtimeModel ?? "",
                realtimeSystemPrompt: ep.realtimeSystemPrompt ?? "",
                promptMode: ep.systemPrompt ? "custom" : "default",
                realtimePromptMode: ep.realtimeSystemPrompt ? "custom" : "default",
              })),
            );
            const loadedPlex = { url: d.plex?.url || "", token: d.plex?.token || "" };
            setPlexConfig(loadedPlex);
            const arrs: Record<string, ArrConfig> = {};
            for (const svc of ARR_SERVICES) {
              arrs[svc.key] = {
                url: d[svc.key]?.url || "",
                apiKey: d[svc.key]?.apiKey || "",
              };
            }
            setArrConfigs(arrs);
            setGithubConfig({
              token: d.github?.token || "",
              owner: d.github?.owner || "",
              repo: d.github?.repo || "",
            });
            // Snapshot the freshly loaded config so we can detect unsaved changes later
            savedConfigRef.current = JSON.stringify({
              endpoints: (d.llmEndpoints || []).map((ep: LlmEndpoint) => ({
                ...ep,
                promptMode: undefined,
                realtimePromptMode: undefined,
              })),
              plex: loadedPlex,
              arrs,
            });
          }
          if (usersData.success) {
            setUsers(
              (usersData.data || []).map((u: UserEntry) => ({
                ...u,
                rateLimitMessages: u.rateLimitMessages ?? 100,
                rateLimitPeriod: u.rateLimitPeriod ?? "day",
                msgCount24h: u.msgCount24h ?? 0,
                msgCount7d: u.msgCount7d ?? 0,
                msgCount30d: u.msgCount30d ?? 0,
              })),
            );
          }
          if (mcpData.success) setMcpToken(mcpData.data?.token || "");
        } else {
          // Non-admin: load only their own MCP token
          try {
            const mcpData = await fetch(`/api/settings/mcp-token/user/${user.id}`).then((r) => r.json());
            if (mcpData.success) setMcpToken(mcpData.data?.token || "");
          } catch { /* non-fatal */ }
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Countdown tick: decrement every second, redirect at 0
  useEffect(() => {
    if (redirectCountdown === null) return;
    if (redirectCountdown <= 0) {
      router.push("/chat");
      return;
    }
    countdownTimerRef.current = setTimeout(
      () => setRedirectCountdown((prev) => (prev !== null ? prev - 1 : null)),
      1000,
    );
    return () => {
      if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
    };
  }, [redirectCountdown, router]);

  // Warn before browser navigation when initial setup is incomplete
  useEffect(() => {
    if (!isInitialSetup || redirectCountdown !== null) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isInitialSetup, redirectCountdown]);

  // --- Save ---
  const handleSave = useCallback(async () => {
    setSaving(true);
    const body: Record<string, unknown> = {
      llmEndpoints: endpoints.map(({ promptMode: _pm, realtimePromptMode: _rpm, ...ep }) => ({
        ...ep,
        // If user chose "default" mode, save empty string so the app default is used
        systemPrompt: _pm === "default" ? "" : ep.systemPrompt,
        realtimeSystemPrompt: _rpm === "default" ? "" : ep.realtimeSystemPrompt,
      })),
      plex: { url: plexConfig.url, token: plexConfig.token },
      github: githubConfig,
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
      if (data.success) {
        setSaved(true);
        // Update the saved snapshot so the back button no longer warns about unsaved changes
        savedConfigRef.current = JSON.stringify({
          endpoints: endpoints.map(({ promptMode: _pm, realtimePromptMode: _rpm, ...ep }) => ep),
          plex: plexConfig,
          arrs: arrConfigs,
        });
        // In initial setup: check if critical services are now working; if so, start redirect countdown
        if (isInitialSetup && redirectCountdown === null) {
          try {
            const statusRes = await fetch("/api/services/status");
            const statusData = await statusRes.json();
            if (statusData.success) {
              const services: { name: string; status: string }[] = statusData.data.services;
              const llmOk = services.find((s) => s.name === "LLM")?.status === "green";
              const plexOk = services.find((s) => s.name === "Plex")?.status === "green";
              if (llmOk && plexOk) setRedirectCountdown(5);
            }
          } catch {
            // Status check failing doesn't prevent saving
          }
        }
      }
    } catch {
      // Silent fail
    } finally {
      setSaving(false);
    }
  }, [endpoints, plexConfig, arrConfigs, githubConfig, isInitialSetup, redirectCountdown]);

  // --- Plex server discovery ---
  async function discoverPlexServers() {
    setPlexDiscovering(true);
    setPlexDiscoverError(null);
    setPlexDevices([]);
    try {
      const res = await fetch("/api/settings/plex-devices");
      const data = await res.json();
      if (data.success) {
        setPlexDevices(data.data || []);
        if ((data.data || []).length === 0) {
          setPlexDiscoverError("No Plex servers found on your account.");
        }
      } else {
        setPlexDiscoverError(data.error || "Discovery failed");
      }
    } catch {
      setPlexDiscoverError("Network error — could not reach server");
    } finally {
      setPlexDiscovering(false);
    }
  }

  function selectPlexDevice(device: PlexDevice) {
    // Prefer a local http connection, fall back to first available
    const best =
      device.connections.find((c) => c.local && c.protocol === "http") ||
      device.connections.find((c) => c.local) ||
      device.connections[0];
    const url = best ? `${best.protocol}://${best.address}:${best.port}` : "";
    setPlexConfig({ url, token: device.accessToken });
    setPlexDevices([]);
    setSaved(false);
  }

  // --- Test connection ---
  async function testConnection(sectionKey: string, url: string, apiKey: string, model?: string, endpointId?: string) {
    if (!url) return;
    try {
      const res = await fetch("/api/setup/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: sectionKey === "llm" ? "llm" : sectionKey,
          url,
          // Send masked/empty apiKey as-is — server will look up stored credential
          apiKey: apiKey === "••••••••" ? "" : apiKey,
          model,
          endpointId,
        }),
      });
      const data = await res.json();
      const result = data.data;
      // Use a per-endpoint key for LLM results so each endpoint shows its own test outcome
      const resultKey = sectionKey === "llm" && endpointId ? `llm-${endpointId}` : sectionKey;
      setTestResults((prev) => ({
        ...prev,
        [resultKey]: {
          success: result?.success ?? false,
          message: result?.message || data.error,
        },
      }));
      // If LLM test succeeded and capabilities were detected, update the endpoint
      if (sectionKey === "llm" && endpointId && result?.success && result?.capabilities) {
        const caps = result.capabilities as { supportsVoice: boolean; realtimeModel: string | null };
        setEndpoints((prev) =>
          prev.map((ep) => {
            if (ep.id !== endpointId) return ep;
            const realtimeModel = caps.realtimeModel ?? ep.realtimeModel ?? "";
            return {
              ...ep,
              supportsVoice: caps.supportsVoice,
              supportsRealtime: realtimeModel !== "",
              realtimeModel,
            };
          }),
        );
        setSaved(false);
      }
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
        isDefault: prev.length === 0,
        supportsVoice: false,
        supportsRealtime: false,
        realtimeModel: "",
        realtimeSystemPrompt: "",
        promptMode: "default" as const,
        realtimePromptMode: "default" as const,
      },
    ]);
    setSaved(false);
  }

  function setDefaultEndpoint(id: string) {
    setEndpoints((prev) =>
      prev.map((ep) => ({ ...ep, isDefault: ep.id === id })),
    );
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

  async function regenerateOwnMcpToken() {
    if (!currentUser) return;
    setMcpTokenLoading(true);
    try {
      const res = await fetch(`/api/settings/mcp-token/user/${currentUser.id}`, { method: "POST" });
      const data = await res.json();
      if (data.success) setMcpToken(data.data.token);
    } catch {
      // Silent fail
    } finally {
      setMcpTokenLoading(false);
    }
  }

  // --- Logs ---
  async function loadLogFiles() {
    if (logFilesLoaded) return;
    setLogFilesLoading(true);
    try {
      const res = await fetch("/api/settings/logs");
      const data = await res.json();
      if (data.success) setLogFiles(data.data || []);
    } catch {
      // Silent fail
    } finally {
      setLogFilesLoading(false);
      setLogFilesLoaded(true);
    }
  }

  async function loadLogContent(filename: string, full = false) {
    setSelectedLogFile(filename);
    setLogContentLoading(true);
    setLogContent("");
    try {
      const url = `/api/settings/logs/${encodeURIComponent(filename)}${full ? "?full=true" : ""}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.success) {
        setLogContent(data.data.content);
        setLogTotalLines(data.data.totalLines);
        setLogShowing(data.data.showing);
      }
    } catch {
      setLogContent("Failed to load log file.");
    } finally {
      setLogContentLoading(false);
    }
  }

  // --- Internal API key ---
  async function loadInternalApiKey() {
    setInternalApiKeyLoading(true);
    try {
      const res = await fetch("/api/settings/internal-api-key");
      const data = await res.json();
      if (data.success) setInternalApiKey(data.data.key);
    } catch {
      // Silent fail
    } finally {
      setInternalApiKeyLoading(false);
    }
  }

  async function regenerateInternalApiKey() {
    setInternalApiKeyLoading(true);
    try {
      const res = await fetch("/api/settings/internal-api-key", { method: "POST" });
      const data = await res.json();
      if (data.success) setInternalApiKey(data.data.key);
    } catch {
      // Silent fail
    } finally {
      setInternalApiKeyLoading(false);
    }
  }

  // --- User management ---
  async function updateUser(userId: number, updates: Partial<Pick<UserEntry, "isAdmin" | "defaultModel" | "canChangeModel" | "rateLimitMessages" | "rateLimitPeriod">>) {
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

  // --- Per-user MCP tokens ---
  async function loadUserMcpToken(userId: number) {
    setUsers((prev) =>
      prev.map((u) => (u.id === userId ? { ...u, mcpTokenLoading: true } : u)),
    );
    try {
      const res = await fetch(`/api/settings/mcp-token/user/${userId}`);
      const data = await res.json();
      if (data.success) {
        setUsers((prev) =>
          prev.map((u) => (u.id === userId ? { ...u, mcpToken: data.data.token, mcpTokenLoading: false } : u)),
        );
      }
    } catch {
      setUsers((prev) =>
        prev.map((u) => (u.id === userId ? { ...u, mcpTokenLoading: false } : u)),
      );
    }
  }

  async function regenerateUserMcpToken(userId: number) {
    setUsers((prev) =>
      prev.map((u) => (u.id === userId ? { ...u, mcpTokenLoading: true } : u)),
    );
    try {
      const res = await fetch(`/api/settings/mcp-token/user/${userId}`, { method: "POST" });
      const data = await res.json();
      if (data.success) {
        setUsers((prev) =>
          prev.map((u) => (u.id === userId ? { ...u, mcpToken: data.data.token, mcpTokenLoading: false } : u)),
        );
      }
    } catch {
      setUsers((prev) =>
        prev.map((u) => (u.id === userId ? { ...u, mcpTokenLoading: false } : u)),
      );
    }
  }

  // The master admin is the user with the lowest ID — their role cannot be changed
  const masterAdminId = users.length > 0 ? Math.min(...users.map((u) => u.id)) : -1;

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
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              if (isInitialSetup && redirectCountdown === null) {
                if (!window.confirm("Setup is not complete. Are you sure you want to leave?")) return;
              } else if (savedConfigRef.current) {
                const currentSnapshot = JSON.stringify({
                  endpoints: endpoints.map(({ promptMode: _pm, realtimePromptMode: _rpm, ...ep }) => ep),
                  plex: plexConfig,
                  arrs: arrConfigs,
                });
                if (currentSnapshot !== savedConfigRef.current) {
                  if (!window.confirm("You have unsaved changes. If you leave now they will be lost.")) return;
                }
              }
              router.push("/chat");
            }}
          >
            <ArrowLeft size={18} />
          </Button>
          <h1 className="text-2xl font-semibold">Settings</h1>
        </div>

        {/* Redirect countdown banner */}
        {redirectCountdown !== null && (
          <div className="mb-4 flex items-center justify-between rounded-lg border border-green-500/30 bg-green-500/10 px-4 py-3">
            <p className="text-sm text-green-400">
              All critical services connected. Redirecting to chat in{" "}
              <span className="font-semibold">{redirectCountdown}s</span>…
            </p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
                setRedirectCountdown(null);
              }}
              className="text-muted-foreground hover:text-foreground"
            >
              Cancel
            </Button>
          </div>
        )}

        <Tabs defaultValue={isInitialSetup ? "llm" : "general"} onValueChange={(v) => { if (v === "logs") { loadLogFiles(); loadInternalApiKey(); } }}>
          <TabsList>
            <TabsTrigger value="general">General</TabsTrigger>
            {currentUser?.isAdmin && <TabsTrigger value="llm">LLM Setup</TabsTrigger>}
            {currentUser?.isAdmin && <TabsTrigger value="services">Plex & Arrs</TabsTrigger>}
            <TabsTrigger value="mcp">MCP</TabsTrigger>
            <TabsTrigger value="users">Users</TabsTrigger>
            {currentUser?.isAdmin && <TabsTrigger value="logs">Logs</TabsTrigger>}
          </TabsList>

          {/* ===== TAB: General ===== */}
          <TabsContent value="general" className="mt-4 space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Install as App (PWA)</CardTitle>
                <CardDescription>
                  Thinkarr can be installed as a Progressive Web App for quick access from your
                  home screen or taskbar.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {pwaIsIos && pwaMobile ? (
                  <p className="text-sm text-muted-foreground">
                    To install on iOS, open Thinkarr in{" "}
                    <span className="font-medium text-foreground">Safari</span>, tap the{" "}
                    <span className="font-medium text-foreground">Share</span> button, then choose{" "}
                    <span className="font-medium text-foreground">Add to Home Screen</span>.
                    Requires iOS 16.4 or later for full functionality.
                  </p>
                ) : pwaInstallAvailable ? (
                  <div className="flex items-center gap-3">
                    <p className="flex-1 text-sm text-muted-foreground">
                      {pwaMobile
                        ? "Tap Install to add Thinkarr to your home screen for quick access."
                        : "Click Install to add Thinkarr as a desktop app for quick access."}
                    </p>
                    <Button variant="outline" size="sm" onClick={() => triggerPwaInstall()}>
                      <Download className="mr-2 h-4 w-4" />
                      Install
                    </Button>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Installation is not currently available. This may be because the app is already
                    installed or your browser has not yet offered the install prompt. Try reloading
                    the page.
                  </p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ===== TAB 1: LLM Setup (admin only) ===== */}
          <TabsContent value="llm" className="mt-4 space-y-4">
            {endpoints.map((ep) => (
              <Card key={ep.id}>
                <CardHeader className="pb-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        value={ep.name}
                        onChange={(e) => updateEndpoint(ep.id, "name", e.target.value)}
                        className="h-8 w-full text-sm font-semibold sm:w-48"
                      />
                      <div className="flex items-center gap-3">
                        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
                          <input
                            type="checkbox"
                            checked={ep.enabled}
                            onChange={(e) => updateEndpoint(ep.id, "enabled", e.target.checked)}
                            className="rounded"
                          />
                          Enabled
                        </label>
                        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
                          <input
                            type="radio"
                            name="defaultEndpoint"
                            checked={ep.isDefault}
                            onChange={() => setDefaultEndpoint(ep.id)}
                            className="rounded"
                          />
                          Default
                        </label>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => removeEndpoint(ep.id)}
                      className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
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
                    <Label>System Prompt</Label>
                    {/* Radio: Use Default / Use Custom */}
                    <div className="flex gap-4 text-sm">
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="radio"
                          name={`promptMode-${ep.id}`}
                          checked={(ep.promptMode ?? "default") === "default"}
                          onChange={() => updateEndpoint(ep.id, "promptMode", "default")}
                        />
                        Use Default Prompt
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="radio"
                          name={`promptMode-${ep.id}`}
                          checked={ep.promptMode === "custom"}
                          onChange={() => updateEndpoint(ep.id, "promptMode", "custom")}
                        />
                        Use Custom Prompt
                      </label>
                    </div>
                    <Textarea
                      value={(ep.promptMode ?? "default") === "default" ? DEFAULT_SYSTEM_PROMPT : ep.systemPrompt}
                      onChange={(e) => {
                        // Auto-switch to custom when the user edits the text
                        if ((ep.promptMode ?? "default") === "default") {
                          updateEndpoint(ep.id, "promptMode", "custom");
                        }
                        updateEndpoint(ep.id, "systemPrompt", e.target.value);
                      }}
                      rows={6}
                    />
                    <p className="text-xs text-muted-foreground">
                      Use <code className="font-mono">{"{{serviceList}}"}</code> as a placeholder for the configured services list.
                    </p>
                  </div>

                  {/* Capability badges (auto-detected after Test Connection) */}
                  <div className="space-y-1.5">
                    <Label>Capabilities</Label>
                    <div className="flex flex-wrap gap-2 text-xs">
                      <span className={`rounded-full px-2 py-0.5 font-medium ${ep.supportsVoice ? "bg-green-500/15 text-green-600 dark:text-green-400" : "bg-muted text-muted-foreground"}`}>
                        {ep.supportsVoice ? "✓ Voice (Whisper)" : "✗ No voice"}
                      </span>
                      <span className={`rounded-full px-2 py-0.5 font-medium ${ep.supportsRealtime ? "bg-green-500/15 text-green-600 dark:text-green-400" : "bg-muted text-muted-foreground"}`}>
                        {ep.supportsRealtime ? `✓ Realtime (${ep.realtimeModel || "configured"})` : "✗ No realtime"}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">Click Test to auto-detect capabilities.</p>
                  </div>

                  {/* Realtime model override */}
                  <div className="space-y-1.5">
                    <Label>Realtime Model <span className="text-muted-foreground font-normal">(optional — leave blank to disable)</span></Label>
                    <Input
                      value={ep.realtimeModel}
                      onChange={(e) => {
                        const val = e.target.value;
                        updateEndpoint(ep.id, "realtimeModel", val);
                        updateEndpoint(ep.id, "supportsRealtime", val !== "");
                      }}
                      placeholder="gpt-4o-realtime-preview-2024-12-17"
                    />
                  </div>

                  {/* Realtime system prompt — only shown when a realtime model is set */}
                  {ep.realtimeModel && (
                    <div className="space-y-1.5">
                      <Label>Realtime System Prompt</Label>
                      <div className="flex gap-4 text-sm">
                        <label className="flex items-center gap-1.5 cursor-pointer">
                          <input
                            type="radio"
                            name={`realtimePromptMode-${ep.id}`}
                            checked={(ep.realtimePromptMode ?? "default") === "default"}
                            onChange={() => updateEndpoint(ep.id, "realtimePromptMode", "default")}
                          />
                          Use Default Realtime Prompt
                        </label>
                        <label className="flex items-center gap-1.5 cursor-pointer">
                          <input
                            type="radio"
                            name={`realtimePromptMode-${ep.id}`}
                            checked={ep.realtimePromptMode === "custom"}
                            onChange={() => updateEndpoint(ep.id, "realtimePromptMode", "custom")}
                          />
                          Use Custom Prompt
                        </label>
                      </div>
                      <Textarea
                        value={(ep.realtimePromptMode ?? "default") === "default" ? DEFAULT_REALTIME_SYSTEM_PROMPT : ep.realtimeSystemPrompt}
                        onChange={(e) => {
                          if ((ep.realtimePromptMode ?? "default") === "default") {
                            updateEndpoint(ep.id, "realtimePromptMode", "custom");
                          }
                          updateEndpoint(ep.id, "realtimeSystemPrompt", e.target.value);
                        }}
                        rows={6}
                      />
                      <p className="text-xs text-muted-foreground">
                        Use <code className="font-mono">{"{{serviceList}}"}</code> as a placeholder for the configured services list.
                      </p>
                    </div>
                  )}
                </CardContent>
                <CardFooter className="flex items-center gap-3">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => testConnection("llm", ep.baseUrl, ep.apiKey, ep.model, ep.id)}
                    disabled={!ep.baseUrl}
                  >
                    Test
                  </Button>
                  {testResults[`llm-${ep.id}`] && (
                    <TestResult result={testResults[`llm-${ep.id}`]} />
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
                <CardDescription>
                  Discover servers automatically using your linked Plex account, or enter details manually.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {/* Discovery button */}
                <div className="flex items-center gap-3">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={discoverPlexServers}
                    disabled={plexDiscovering}
                    className="gap-2"
                  >
                    {plexDiscovering ? <Spinner size={14} /> : <Search size={14} />}
                    Discover Servers
                  </Button>
                  {plexDiscoverError && (
                    <span className="text-sm text-destructive">{plexDiscoverError}</span>
                  )}
                </div>

                {/* Server list */}
                {plexDevices.length > 0 && (
                  <div className="rounded-lg border divide-y">
                    {plexDevices.map((device) => (
                      <button
                        key={device.clientIdentifier}
                        onClick={() => selectPlexDevice(device)}
                        className="w-full flex items-center justify-between px-3 py-2.5 text-left hover:bg-muted/50 transition-colors"
                      >
                        <div>
                          <p className="text-sm font-medium">{device.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {device.connections.length} connection{device.connections.length !== 1 ? "s" : ""}
                            {device.owned ? " · Owned" : " · Shared"}
                          </p>
                        </div>
                        <span className="text-xs text-primary">Select →</span>
                      </button>
                    ))}
                  </div>
                )}

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
                  <Input
                    type="password"
                    value={plexConfig.token}
                    onChange={(e) => {
                      setPlexConfig((prev) => ({ ...prev, token: e.target.value }));
                      setSaved(false);
                    }}
                    placeholder="Paste your Plex token (or use Discover above)"
                  />
                  <p className="text-xs text-muted-foreground">
                    Manual entry: Plex Web → Settings → Troubleshooting → Your Account Token.
                  </p>
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
                      onClick={() => copyToClipboard(`${window.location.origin}/api/mcp`)}
                    >
                      <Copy size={14} />
                    </Button>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label>{currentUser?.isAdmin ? "Admin Bearer Token" : "Your Bearer Token"}</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      value={mcpToken}
                      readOnly
                      className="font-mono text-sm"
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => copyToClipboard(mcpToken)}
                    >
                      <Copy size={14} />
                    </Button>
                    <Button
                      variant="secondary"
                      size="icon"
                      onClick={currentUser?.isAdmin ? regenerateMcpToken : regenerateOwnMcpToken}
                      disabled={mcpTokenLoading}
                    >
                      {mcpTokenLoading ? <Spinner size={14} /> : <RefreshCw size={14} />}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Use this token as a Bearer token in the Authorization header.
                  </p>
                </div>

                {currentUser?.isAdmin && (
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
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ===== TAB 4: User Settings ===== */}
          <TabsContent value="users" className="mt-4 space-y-4">
            {/* Non-admin: read-only view of own account */}
            {!currentUser?.isAdmin && currentUser && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Your Account</CardTitle>
                  <CardDescription>Your account details.</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex items-start gap-3 rounded-lg border p-3">
                    <Avatar
                      src={currentUser.plexAvatarUrl}
                      fallback={currentUser.plexUsername}
                      size="sm"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{currentUser.plexUsername}</p>
                      {currentUser.plexEmail && (
                        <p className="text-xs text-muted-foreground truncate">{currentUser.plexEmail}</p>
                      )}
                      <div className="mt-2 flex flex-wrap gap-3">
                        <span className="text-sm text-muted-foreground">
                          Role: <span className="text-foreground">User</span>
                        </span>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Admin: full user management */}
            {currentUser?.isAdmin && (
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
                              {user.id === masterAdminId ? (
                                <span className="rounded border bg-background px-2 py-0.5 text-sm text-muted-foreground">
                                  Administrator (locked)
                                </span>
                              ) : (
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
                              )}
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

                            {/* Rate limit */}
                            <label className="flex items-center gap-1.5 text-sm">
                              <span className="text-muted-foreground">Limit:</span>
                              <input
                                type="number"
                                min={1}
                                value={user.rateLimitMessages}
                                onChange={(e) =>
                                  updateUser(user.id, {
                                    rateLimitMessages: Math.max(1, parseInt(e.target.value, 10) || 1),
                                  })
                                }
                                className="w-16 rounded border bg-background px-2 py-0.5 text-sm"
                              />
                              <span className="text-muted-foreground">messages per</span>
                              <select
                                value={user.rateLimitPeriod}
                                onChange={(e) =>
                                  updateUser(user.id, {
                                    rateLimitPeriod: e.target.value as UserEntry["rateLimitPeriod"],
                                  })
                                }
                                className="rounded border bg-background px-2 py-0.5 text-sm"
                              >
                                <option value="hour">hour</option>
                                <option value="day">day</option>
                                <option value="week">week</option>
                                <option value="month">month</option>
                              </select>
                            </label>
                          </div>

                          {/* Message stats */}
                          <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
                            <span>Messages: <span className="font-medium text-foreground">{user.msgCount24h}</span> / 24h</span>
                            <span><span className="font-medium text-foreground">{user.msgCount7d}</span> / 7d</span>
                            <span><span className="font-medium text-foreground">{user.msgCount30d}</span> / 30d</span>
                          </div>

                          {/* Per-user MCP token */}
                          <div className="mt-2">
                            {user.mcpToken ? (
                              <div className="flex items-center gap-2">
                                <span className="text-xs text-muted-foreground">MCP token:</span>
                                <code className="flex-1 truncate rounded bg-muted px-2 py-0.5 text-xs font-mono max-w-[200px]">
                                  {user.mcpToken}
                                </code>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6"
                                  onClick={() => copyToClipboard(user.mcpToken!)}
                                >
                                  <Copy size={12} />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6"
                                  onClick={() => regenerateUserMcpToken(user.id)}
                                  disabled={user.mcpTokenLoading}
                                >
                                  {user.mcpTokenLoading ? <Spinner size={12} /> : <RefreshCw size={12} />}
                                </Button>
                              </div>
                            ) : (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 text-xs text-muted-foreground px-2"
                                onClick={() => loadUserMcpToken(user.id)}
                                disabled={user.mcpTokenLoading}
                              >
                                {user.mcpTokenLoading ? <Spinner size={12} /> : "Show MCP token"}
                              </Button>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
            )} {/* end admin user management */}
          </TabsContent>

          {/* ===== TAB 5: Logs (admin only) ===== */}
          <TabsContent value="logs" className="mt-4 space-y-4">
            {/* Internal API Key */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Internal API Key</CardTitle>
                <CardDescription>
                  Use this key with the <code className="font-mono text-xs">/beta-logs</code> Claude slash command to pull live diagnostic logs.
                  Set it as <code className="font-mono text-xs">THINKARR_INTERNAL_KEY</code> in your Claude settings.json.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-2">
                  <Input
                    value={internalApiKey}
                    readOnly
                    className="font-mono text-sm"
                    placeholder={internalApiKeyLoading ? "Loading…" : "Click regenerate to reveal key"}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => copyToClipboard(internalApiKey)}
                    disabled={!internalApiKey}
                  >
                    <Copy size={14} />
                  </Button>
                  <Button
                    variant="secondary"
                    size="icon"
                    onClick={regenerateInternalApiKey}
                    disabled={internalApiKeyLoading}
                  >
                    {internalApiKeyLoading ? <Spinner size={14} /> : <RefreshCw size={14} />}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  Regenerating issues a new key immediately — update your Claude settings.json after regenerating.
                </p>
              </CardContent>
            </Card>

            {/* GitHub issue reporting config */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">GitHub Issue Reporting</CardTitle>
                <CardDescription>
                  When configured, the &quot;Report Issue&quot; button in the chat window will create GitHub
                  issues tagged <code className="font-mono text-xs">user-reported</code>. Leave
                  blank to log reports locally only.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="github-token">Personal Access Token</Label>
                  <Input
                    id="github-token"
                    type="password"
                    placeholder="ghp_••••••••"
                    value={githubConfig.token}
                    onChange={(e) => setGithubConfig((prev) => ({ ...prev, token: e.target.value }))}
                  />
                  <p className="text-xs text-muted-foreground">
                    Requires <code className="font-mono">repo</code> scope (or{" "}
                    <code className="font-mono">public_repo</code> for public repos).
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="github-owner">Repository Owner</Label>
                    <Input
                      id="github-owner"
                      placeholder="chrisrothwell"
                      value={githubConfig.owner}
                      onChange={(e) => setGithubConfig((prev) => ({ ...prev, owner: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="github-repo">Repository Name</Label>
                    <Input
                      id="github-repo"
                      placeholder="thinkarr"
                      value={githubConfig.repo}
                      onChange={(e) => setGithubConfig((prev) => ({ ...prev, repo: e.target.value }))}
                    />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  The <code className="font-mono text-xs">user-reported</code> label must exist in
                  the repository before issues can be filed. Values from{" "}
                  <code className="font-mono text-xs">GITHUB_TOKEN</code>,{" "}
                  <code className="font-mono text-xs">GITHUB_OWNER</code>, and{" "}
                  <code className="font-mono text-xs">GITHUB_REPO</code> environment variables
                  take precedence over these settings.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Application Logs</CardTitle>
                <CardDescription>
                  View and download log files from <code className="font-mono text-xs">/config/logs/</code>.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {logFilesLoading ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Spinner size={14} /> Loading…
                  </div>
                ) : (
                  <div className="flex gap-4 min-h-64">
                    {/* File list */}
                    <div className="w-48 shrink-0 space-y-1">
                      {logFiles.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No log files found.</p>
                      ) : (
                        logFiles.map((f) => (
                          <button
                            key={f.name}
                            onClick={() => loadLogContent(f.name)}
                            className={`w-full text-left rounded-lg px-3 py-2 text-sm transition-colors ${
                              selectedLogFile === f.name
                                ? "bg-primary/10 text-primary"
                                : "hover:bg-muted text-foreground"
                            }`}
                          >
                            <p className="font-medium truncate flex items-center gap-1.5">
                              <FileText size={13} />
                              {f.name}
                            </p>
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {(f.size / 1024).toFixed(1)} KB
                            </p>
                          </button>
                        ))
                      )}
                    </div>

                    {/* Log content viewer */}
                    {selectedLogFile && (
                      <div className="flex-1 min-w-0 flex flex-col gap-2">
                        {/* Toolbar */}
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <p className="text-xs text-muted-foreground">
                            {logShowing < logTotalLines
                              ? `Showing last ${logShowing} of ${logTotalLines} lines`
                              : `${logTotalLines} lines`}
                          </p>
                          <div className="flex items-center gap-2">
                            {logShowing < logTotalLines && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 text-xs"
                                onClick={() => loadLogContent(selectedLogFile, true)}
                                disabled={logContentLoading}
                              >
                                Load Full
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 text-xs gap-1"
                              onClick={() => window.open(`/api/settings/logs/${encodeURIComponent(selectedLogFile)}?download=true`)}
                            >
                              <Download size={12} />
                              Download
                            </Button>
                          </div>
                        </div>

                        {logContentLoading ? (
                          <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Spinner size={14} /> Loading…
                          </div>
                        ) : (
                          <pre className="font-mono text-xs bg-muted/50 rounded-lg p-3 max-h-96 overflow-auto whitespace-pre-wrap break-all">
                            {logContent || "(empty)"}
                          </pre>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* Save button (admin only) */}
        {currentUser?.isAdmin && (
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
        )}
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
