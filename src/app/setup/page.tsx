"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { CheckCircle, XCircle, ArrowRight, ArrowLeft } from "lucide-react";

interface ServiceConfig {
  url: string;
  apiKey: string;
  model?: string;
}

interface ConnectionStatus {
  testing: boolean;
  success: boolean | null;
  message: string;
}

const STEPS = ["LLM", "Plex", "Sonarr", "Radarr", "Overseerr"] as const;

const STEP_INFO: Record<string, { title: string; description: string; required: boolean }> = {
  LLM: {
    title: "LLM Provider",
    description: "Configure your OpenAI-compatible LLM endpoint. This powers the chat assistant.",
    required: true,
  },
  Plex: {
    title: "Plex Media Server",
    description: "Connect to your Plex server for library search and authentication.",
    required: true,
  },
  Sonarr: {
    title: "Sonarr",
    description: "Connect to Sonarr for TV show management. This is optional.",
    required: false,
  },
  Radarr: {
    title: "Radarr",
    description: "Connect to Radarr for movie management. This is optional.",
    required: false,
  },
  Overseerr: {
    title: "Overseerr",
    description: "Connect to Overseerr for media requests. This is optional.",
    required: false,
  },
};

export default function SetupPage() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  const [configs, setConfigs] = useState<Record<string, ServiceConfig>>({
    LLM: { url: "", apiKey: "", model: "" },
    Plex: { url: "", apiKey: "" },
    Sonarr: { url: "", apiKey: "" },
    Radarr: { url: "", apiKey: "" },
    Overseerr: { url: "", apiKey: "" },
  });

  const [statuses, setStatuses] = useState<Record<string, ConnectionStatus>>({
    LLM: { testing: false, success: null, message: "" },
    Plex: { testing: false, success: null, message: "" },
    Sonarr: { testing: false, success: null, message: "" },
    Radarr: { testing: false, success: null, message: "" },
    Overseerr: { testing: false, success: null, message: "" },
  });

  const currentStep = STEPS[step];
  const info = STEP_INFO[currentStep];
  const config = configs[currentStep];
  const status = statuses[currentStep];

  function updateConfig(field: string, value: string) {
    setConfigs((prev) => ({
      ...prev,
      [currentStep]: { ...prev[currentStep], [field]: value },
    }));
    // Reset status when config changes
    setStatuses((prev) => ({
      ...prev,
      [currentStep]: { testing: false, success: null, message: "" },
    }));
  }

  async function testConnection() {
    setStatuses((prev) => ({
      ...prev,
      [currentStep]: { testing: true, success: null, message: "Testing..." },
    }));

    try {
      const type = currentStep === "LLM" ? "llm" : currentStep.toLowerCase();
      const res = await fetch("/api/setup/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          url: config.url,
          apiKey: config.apiKey,
          model: config.model,
        }),
      });
      const data = await res.json();
      setStatuses((prev) => ({
        ...prev,
        [currentStep]: {
          testing: false,
          success: data.data?.success ?? false,
          message: data.data?.message || data.error || "Unknown error",
        },
      }));
    } catch {
      setStatuses((prev) => ({
        ...prev,
        [currentStep]: { testing: false, success: false, message: "Network error" },
      }));
    }
  }

  function canProceed(): boolean {
    if (!info.required) return true;
    return status.success === true;
  }

  function isStepFilled(): boolean {
    if (!info.required && !config.url && !config.apiKey) return false; // optional & empty = skip
    return !!(config.url && config.apiKey);
  }

  async function handleFinish() {
    setSaving(true);
    setSaveError("");

    const body: Record<string, unknown> = {
      llm: {
        baseUrl: configs.LLM.url,
        apiKey: configs.LLM.apiKey,
        model: configs.LLM.model,
      },
      plex: {
        url: configs.Plex.url,
        token: configs.Plex.apiKey,
      },
    };

    if (configs.Sonarr.url && configs.Sonarr.apiKey) {
      body.sonarr = { url: configs.Sonarr.url, apiKey: configs.Sonarr.apiKey };
    }
    if (configs.Radarr.url && configs.Radarr.apiKey) {
      body.radarr = { url: configs.Radarr.url, apiKey: configs.Radarr.apiKey };
    }
    if (configs.Overseerr.url && configs.Overseerr.apiKey) {
      body.overseerr = { url: configs.Overseerr.url, apiKey: configs.Overseerr.apiKey };
    }

    try {
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.success) {
        router.push("/");
      } else {
        setSaveError(data.error || "Failed to save configuration");
      }
    } catch {
      setSaveError("Network error while saving");
    } finally {
      setSaving(false);
    }
  }

  const isLastStep = step === STEPS.length - 1;

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-lg">
        {/* Step indicator */}
        <div className="mb-8 flex items-center justify-center gap-2">
          {STEPS.map((s, i) => (
            <div
              key={s}
              className={`flex h-2.5 w-2.5 rounded-full transition-colors ${
                i === step
                  ? "bg-primary"
                  : i < step
                    ? statuses[s].success === true
                      ? "bg-primary/60"
                      : "bg-muted-foreground/40"
                    : "bg-muted"
              }`}
            />
          ))}
        </div>

        <Card>
          <CardHeader>
            <CardTitle>
              {info.title}
              {!info.required && (
                <span className="ml-2 text-sm font-normal text-muted-foreground">(Optional)</span>
              )}
            </CardTitle>
            <CardDescription>{info.description}</CardDescription>
          </CardHeader>

          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="url">{currentStep === "LLM" ? "Base URL" : "URL"}</Label>
              <Input
                id="url"
                placeholder={
                  currentStep === "LLM"
                    ? "https://api.openai.com/v1"
                    : currentStep === "Plex"
                      ? "http://localhost:32400"
                      : currentStep === "Overseerr"
                        ? "http://localhost:5055"
                        : `http://localhost:${currentStep === "Sonarr" ? "8989" : "7878"}`
                }
                value={config.url}
                onChange={(e) => updateConfig("url", e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="apiKey">{currentStep === "Plex" ? "Token" : "API Key"}</Label>
              <Input
                id="apiKey"
                type="password"
                placeholder={currentStep === "Plex" ? "Plex token" : "API key"}
                value={config.apiKey}
                onChange={(e) => updateConfig("apiKey", e.target.value)}
              />
            </div>

            {currentStep === "LLM" && (
              <div className="space-y-2">
                <Label htmlFor="model">Model</Label>
                <Input
                  id="model"
                  placeholder="gpt-4o, claude-sonnet-4-5-20250929, etc."
                  value={config.model || ""}
                  onChange={(e) => updateConfig("model", e.target.value)}
                />
              </div>
            )}

            {/* Test connection button + status */}
            <div className="flex items-center gap-3 pt-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={testConnection}
                disabled={status.testing || !isStepFilled()}
              >
                {status.testing && <Spinner className="mr-2" size={14} />}
                Test Connection
              </Button>

              {status.success !== null && !status.testing && (
                <div className="flex items-center gap-1.5 text-sm">
                  {status.success ? (
                    <CheckCircle className="text-green-500" size={16} />
                  ) : (
                    <XCircle className="text-destructive" size={16} />
                  )}
                  <span className={status.success ? "text-green-500" : "text-destructive"}>
                    {status.message}
                  </span>
                </div>
              )}
            </div>
          </CardContent>

          <CardFooter className="flex justify-between">
            <Button
              variant="ghost"
              onClick={() => setStep((s) => s - 1)}
              disabled={step === 0}
            >
              <ArrowLeft size={16} className="mr-1" />
              Back
            </Button>

            {isLastStep ? (
              <Button onClick={handleFinish} disabled={saving || !canProceed()}>
                {saving && <Spinner className="mr-2" size={14} />}
                Finish Setup
              </Button>
            ) : (
              <Button
                onClick={() => setStep((s) => s + 1)}
                disabled={!canProceed()}
              >
                {!info.required && !isStepFilled() ? "Skip" : "Next"}
                <ArrowRight size={16} className="ml-1" />
              </Button>
            )}
          </CardFooter>

          {saveError && (
            <div className="px-6 pb-4 text-sm text-destructive">{saveError}</div>
          )}
        </Card>
      </div>
    </div>
  );
}
