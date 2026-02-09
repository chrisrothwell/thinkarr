"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { ArrowLeft, CheckCircle, XCircle } from "lucide-react";
import type { TestConnectionRequest } from "@/types/api";

interface ServiceConfig {
  url: string;
  apiKey: string;
  model?: string;
}

const SECTIONS = [
  { key: "llm", label: "LLM Provider", urlLabel: "Base URL", secretLabel: "API Key", hasModel: true },
  { key: "plex", label: "Plex", urlLabel: "URL", secretLabel: "Token", hasModel: false },
  { key: "sonarr", label: "Sonarr", urlLabel: "URL", secretLabel: "API Key", hasModel: false },
  { key: "radarr", label: "Radarr", urlLabel: "URL", secretLabel: "API Key", hasModel: false },
  { key: "overseerr", label: "Overseerr", urlLabel: "URL", secretLabel: "API Key", hasModel: false },
] as const;

export default function SettingsPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [configs, setConfigs] = useState<Record<string, ServiceConfig>>({});
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; message: string }>>({});

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => {
        if (data.success) {
          const mapped: Record<string, ServiceConfig> = {};
          for (const section of SECTIONS) {
            const d = data.data[section.key] || {};
            mapped[section.key] = {
              url: d.baseUrl || d.url || "",
              apiKey: d.apiKey || d.token || "",
              model: d.model || "",
            };
          }
          setConfigs(mapped);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  function updateConfig(section: string, field: string, value: string) {
    setConfigs((prev) => ({
      ...prev,
      [section]: { ...prev[section], [field]: value },
    }));
    setSaved(false);
  }

  async function testConnection(sectionKey: string) {
    const config = configs[sectionKey];
    if (!config?.url) return;

    const body: TestConnectionRequest = {
      type: sectionKey === "llm" ? "llm" : sectionKey as TestConnectionRequest["type"],
      url: config.url,
      apiKey: config.apiKey === "••••••••" ? "" : config.apiKey,
      model: config.model,
    };

    try {
      const res = await fetch("/api/setup/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      setTestResults((prev) => ({
        ...prev,
        [sectionKey]: { success: data.data?.success ?? false, message: data.data?.message || data.error },
      }));
    } catch {
      setTestResults((prev) => ({
        ...prev,
        [sectionKey]: { success: false, message: "Network error" },
      }));
    }
  }

  async function handleSave() {
    setSaving(true);
    const body: Record<string, Record<string, string>> = {};

    for (const section of SECTIONS) {
      const config = configs[section.key];
      if (!config) continue;

      if (section.key === "llm") {
        body.llm = { baseUrl: config.url, apiKey: config.apiKey, model: config.model || "" };
      } else if (section.key === "plex") {
        body.plex = { url: config.url, token: config.apiKey };
      } else {
        body[section.key] = { url: config.url, apiKey: config.apiKey };
      }
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
      // Silently fail
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner size={24} />
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4">
      <div className="mx-auto max-w-2xl">
        <div className="mb-6 flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => router.push("/chat")}>
            <ArrowLeft size={18} />
          </Button>
          <h1 className="text-2xl font-semibold">Settings</h1>
        </div>

        <div className="space-y-4">
          {SECTIONS.map((section) => {
            const config = configs[section.key] || { url: "", apiKey: "", model: "" };
            const result = testResults[section.key];

            return (
              <Card key={section.key}>
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg">{section.label}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="space-y-1.5">
                    <Label>{section.urlLabel}</Label>
                    <Input
                      value={config.url}
                      onChange={(e) => updateConfig(section.key, "url", e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{section.secretLabel}</Label>
                    <Input
                      type="password"
                      value={config.apiKey}
                      onChange={(e) => updateConfig(section.key, "apiKey", e.target.value)}
                    />
                  </div>
                  {section.hasModel && (
                    <div className="space-y-1.5">
                      <Label>Model</Label>
                      <Input
                        value={config.model || ""}
                        onChange={(e) => updateConfig(section.key, "model", e.target.value)}
                      />
                    </div>
                  )}
                </CardContent>
                <CardFooter className="flex items-center gap-3">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => testConnection(section.key)}
                    disabled={!config.url}
                  >
                    Test
                  </Button>
                  {result && (
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
                  )}
                </CardFooter>
              </Card>
            );
          })}
        </div>

        <div className="mt-6 flex items-center gap-3">
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Spinner className="mr-2" size={14} />}
            Save Changes
          </Button>
          {saved && (
            <CardDescription className="text-green-500">Settings saved. Restart may be needed for some changes.</CardDescription>
          )}
        </div>
      </div>
    </div>
  );
}
