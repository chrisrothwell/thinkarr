import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getConfig } from "@/lib/config";
import type { ApiResponse } from "@/types/api";

export type ServiceStatusLevel = "green" | "amber" | "red";

export interface ServiceStatus {
  name: string;
  status: ServiceStatusLevel;
  message: string;
}

async function checkLlm(): Promise<ServiceStatus> {
  const baseUrl = getConfig("llm.baseUrl");
  const apiKey = getConfig("llm.apiKey");
  const model = getConfig("llm.model");

  if (!baseUrl || !apiKey) {
    return { name: "LLM", status: "red", message: "Not configured" };
  }

  try {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ baseURL: baseUrl, apiKey });
    if (model) {
      await client.chat.completions.create({
        model,
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 1,
      });
      return { name: "LLM", status: "green", message: `Connected (${model})` };
    }
    const models = await client.models.list();
    const count = (await Array.fromAsync(models)).length;
    return { name: "LLM", status: "green", message: `Connected (${count} models)` };
  } catch {
    return { name: "LLM", status: "amber", message: "Reachable but request failed" };
  }
}

async function checkPlex(): Promise<ServiceStatus> {
  const url = getConfig("plex.url");
  const token = getConfig("plex.token");

  if (!url) return { name: "Plex", status: "red", message: "Not configured" };

  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/identity`, {
      headers: { ...(token ? { "X-Plex-Token": token } : {}), Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return { name: "Plex", status: "amber", message: `HTTP ${res.status}` };
    }
    if (!token) {
      return { name: "Plex", status: "amber", message: "Reachable but no token" };
    }
    return { name: "Plex", status: "green", message: "Connected" };
  } catch {
    return { name: "Plex", status: "red", message: "Unreachable" };
  }
}

async function checkArr(
  name: string,
  urlKey: string,
  apiKeyKey: string,
): Promise<ServiceStatus> {
  const url = getConfig(urlKey);
  const apiKey = getConfig(apiKeyKey);

  if (!url) return { name, status: "red", message: "Not configured" };

  const endpoint = name === "Overseerr" ? "/api/v1/status" : "/api/v3/system/status";

  try {
    const res = await fetch(`${url.replace(/\/$/, "")}${endpoint}`, {
      headers: { ...(apiKey ? { "X-Api-Key": apiKey } : {}) },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      if (!apiKey) return { name, status: "amber", message: "Reachable but no API key" };
      return { name, status: "amber", message: `HTTP ${res.status}` };
    }
    if (!apiKey) {
      return { name, status: "amber", message: "Reachable but no API key" };
    }
    return { name, status: "green", message: "Connected" };
  } catch {
    return { name, status: "red", message: "Unreachable" };
  }
}

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Not authenticated" },
      { status: 401 },
    );
  }

  const [llm, plex, sonarr, radarr, overseerr] = await Promise.all([
    checkLlm(),
    checkPlex(),
    checkArr("Sonarr", "sonarr.url", "sonarr.apiKey"),
    checkArr("Radarr", "radarr.url", "radarr.apiKey"),
    checkArr("Overseerr", "overseerr.url", "overseerr.apiKey"),
  ]);

  return NextResponse.json<ApiResponse>({
    success: true,
    data: { services: [llm, plex, sonarr, radarr, overseerr] },
  });
}
