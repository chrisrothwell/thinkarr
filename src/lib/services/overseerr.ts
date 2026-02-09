import { getConfig } from "@/lib/config";

function getOverseerrConfig() {
  const url = getConfig("overseerr.url");
  const apiKey = getConfig("overseerr.apiKey");
  if (!url || !apiKey) throw new Error("Overseerr not configured");
  return { url: url.replace(/\/$/, ""), apiKey };
}

async function overseerrFetch(path: string, options?: RequestInit) {
  const { url, apiKey } = getOverseerrConfig();
  const res = await fetch(`${url}/api/v1${path}`, {
    ...options,
    headers: {
      "X-Api-Key": apiKey,
      "Content-Type": "application/json",
      ...options?.headers,
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Overseerr API error: HTTP ${res.status}`);
  return res.json();
}

export interface OverseerrSearchResult {
  id: number;
  mediaType: string;
  title: string;
  overview?: string;
  releaseDate?: string;
  status: number;
  mediaStatus?: string;
}

export async function search(query: string): Promise<OverseerrSearchResult[]> {
  const data = await overseerrFetch(`/search?query=${encodeURIComponent(query)}&page=1&language=en`);
  return (data?.results || []).slice(0, 10).map((r: Record<string, unknown>) => ({
    id: r.id as number,
    mediaType: r.mediaType as string,
    title: (r.title || r.name) as string,
    overview: (r.overview as string)?.substring(0, 200),
    releaseDate: (r.releaseDate || r.firstAirDate) as string,
    status: r.status as number,
    mediaStatus: mediaStatusLabel(r.mediaInfo as Record<string, unknown> | undefined),
  }));
}

function mediaStatusLabel(info?: Record<string, unknown>): string {
  if (!info) return "Unknown";
  switch (info.status) {
    case 1: return "Unknown";
    case 2: return "Pending";
    case 3: return "Processing";
    case 4: return "Partially Available";
    case 5: return "Available";
    default: return "Not Requested";
  }
}

export interface OverseerrRequest {
  id: number;
  type: string;
  title: string;
  status: string;
  requestedBy: string;
  createdAt: string;
}

export async function listRequests(): Promise<OverseerrRequest[]> {
  const data = await overseerrFetch("/request?take=20&skip=0&sort=added");
  return (data?.results || []).map((r: Record<string, unknown>) => {
    const media = r.media as Record<string, unknown> | undefined;
    return {
      id: r.id as number,
      type: r.type as string,
      title: (media?.title || media?.name || "Unknown") as string,
      status: requestStatusLabel(r.status as number),
      requestedBy: ((r.requestedBy as Record<string, unknown>)?.displayName || "Unknown") as string,
      createdAt: r.createdAt as string,
    };
  });
}

function requestStatusLabel(status: number): string {
  switch (status) {
    case 1: return "Pending Approval";
    case 2: return "Approved";
    case 3: return "Declined";
    default: return "Unknown";
  }
}

export async function requestMovie(tmdbId: number): Promise<{ success: boolean; message: string }> {
  try {
    await overseerrFetch("/request", {
      method: "POST",
      body: JSON.stringify({ mediaType: "movie", mediaId: tmdbId }),
    });
    return { success: true, message: "Movie request submitted successfully" };
  } catch (e: unknown) {
    return { success: false, message: e instanceof Error ? e.message : "Request failed" };
  }
}

export async function requestTv(
  tvdbId: number,
  seasons?: number[],
): Promise<{ success: boolean; message: string }> {
  try {
    const body: Record<string, unknown> = {
      mediaType: "tv",
      mediaId: tvdbId,
    };
    if (seasons && seasons.length > 0) {
      body.seasons = seasons;
    }
    await overseerrFetch("/request", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { success: true, message: "TV show request submitted successfully" };
  } catch (e: unknown) {
    return { success: false, message: e instanceof Error ? e.message : "Request failed" };
  }
}
