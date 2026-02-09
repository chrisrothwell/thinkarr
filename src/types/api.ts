export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface SetupStatus {
  complete: boolean;
  hasLlm: boolean;
  hasPlex: boolean;
  hasSonarr: boolean;
  hasRadarr: boolean;
  hasOverseerr: boolean;
}

export interface TestConnectionRequest {
  type: "llm" | "plex" | "sonarr" | "radarr" | "overseerr";
  url: string;
  apiKey: string;
  model?: string;
}

export interface TestConnectionResponse {
  success: boolean;
  message: string;
}

export interface SetupSaveRequest {
  llm: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
  plex: {
    url: string;
    token: string;
  };
  sonarr?: {
    url: string;
    apiKey: string;
  };
  radarr?: {
    url: string;
    apiKey: string;
  };
  overseerr?: {
    url: string;
    apiKey: string;
  };
}
