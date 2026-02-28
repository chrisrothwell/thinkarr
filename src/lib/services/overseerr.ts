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

export interface OverseerrSeasonStatus {
  seasonNumber: number;
  status: string; // "Available" | "Partially Available" | "Pending" | "Not Requested"
}

export interface OverseerrSearchResult {
  id: number;
  mediaType: string;
  title: string;
  year?: string;
  overview?: string;
  releaseDate?: string;
  mediaStatus: string;
  // TV-specific
  seasonCount?: number;
  seasons?: OverseerrSeasonStatus[];
}

function mediaStatusLabel(info?: Record<string, unknown>): string {
  if (!info) return "Not Requested";
  switch (info.status) {
    case 1: return "Unknown";
    case 2: return "Pending";
    case 3: return "Processing";
    case 4: return "Partially Available";
    case 5: return "Available";
    default: return "Not Requested";
  }
}

function seasonStatusLabel(status: number): string {
  switch (status) {
    case 2: return "Pending";
    case 3: return "Processing";
    case 4: return "Partially Available";
    case 5: return "Available";
    default: return "Not Requested";
  }
}

export async function search(query: string): Promise<OverseerrSearchResult[]> {
  const data = await overseerrFetch(`/search?query=${encodeURIComponent(query)}&page=1&language=en`);
  return (data?.results || []).slice(0, 10).map((r: Record<string, unknown>) => {
    const mediaInfo = r.mediaInfo as Record<string, unknown> | undefined;
    const isTV = r.mediaType === "tv";
    const rawSeasons = (mediaInfo?.seasons as Record<string, unknown>[]) || [];

    return {
      id: r.id as number,
      mediaType: r.mediaType as string,
      title: (r.title || r.name) as string,
      year: ((r.releaseDate || r.firstAirDate) as string | undefined)?.substring(0, 4),
      overview: (r.overview as string | undefined)?.substring(0, 300),
      releaseDate: (r.releaseDate || r.firstAirDate) as string | undefined,
      mediaStatus: mediaStatusLabel(mediaInfo),
      seasonCount: isTV ? (r.numberOfSeasons as number | undefined) : undefined,
      seasons: isTV && rawSeasons.length > 0
        ? rawSeasons
            .filter((s) => (s.seasonNumber as number) > 0)
            .map((s) => ({
              seasonNumber: s.seasonNumber as number,
              status: seasonStatusLabel(s.status as number),
            }))
        : undefined,
    };
  });
}

export interface OverseerrRequest {
  id: number;
  type: string;
  title: string;
  year?: string;
  status: string;
  requestedBy: string;
  requestedAt: string;
  seasonsRequested?: number[];
}

export async function listRequests(): Promise<OverseerrRequest[]> {
  const data = await overseerrFetch("/request?take=20&skip=0&sort=added");
  return (data?.results || []).map((r: Record<string, unknown>) => {
    const media = r.media as Record<string, unknown> | undefined;
    const isTV = r.type === "tv";
    const seasonsList = isTV
      ? ((r.seasons as Record<string, unknown>[]) || []).map((s) => s.seasonNumber as number).sort((a, b) => a - b)
      : undefined;

    return {
      id: r.id as number,
      type: r.type as string,
      title: (media?.title || media?.name || "Unknown") as string,
      year: ((media?.releaseDate || media?.firstAirDate) as string | undefined)?.substring(0, 4),
      status: requestStatusLabel(r.status as number),
      requestedBy: ((r.requestedBy as Record<string, unknown>)?.displayName || "Unknown") as string,
      requestedAt: r.createdAt as string,
      seasonsRequested: seasonsList && seasonsList.length > 0 ? seasonsList : undefined,
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
