import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getConfig } from "@/lib/config";
import type { ApiResponse } from "@/types/api";

export interface ModelOption {
  id: string;
  endpointId: string;
  endpointName: string;
  model: string;
  label: string;
}

interface LlmEndpoint {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  enabled: boolean;
}

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Not authenticated" },
      { status: 401 },
    );
  }

  // Check if user can change model
  const canChange = getConfig(`user.${session.user.id}.canChangeModel`) !== "false";
  const userDefault = getConfig(`user.${session.user.id}.defaultModel`) || "";

  // Get available endpoints
  let endpoints: LlmEndpoint[] = [];
  const raw = getConfig("llm.endpoints");
  if (raw) {
    try {
      endpoints = JSON.parse(raw);
    } catch {
      // Fall through
    }
  }

  // Fallback to legacy single endpoint
  if (endpoints.length === 0) {
    const baseUrl = getConfig("llm.baseUrl");
    const model = getConfig("llm.model");
    if (baseUrl && model) {
      endpoints = [{ id: "default", name: "Default", baseUrl, model, enabled: true }];
    }
  }

  const models: ModelOption[] = endpoints
    .filter((ep) => ep.enabled)
    .map((ep) => ({
      id: `${ep.id}:${ep.model}`,
      endpointId: ep.id,
      endpointName: ep.name,
      model: ep.model,
      label: endpoints.length > 1 ? `${ep.name} — ${ep.model}` : ep.model,
    }));

  return NextResponse.json<ApiResponse>({
    success: true,
    data: {
      models,
      canChangeModel: canChange,
      defaultModel: userDefault || (models.length > 0 ? models[0].id : ""),
    },
  });
}
