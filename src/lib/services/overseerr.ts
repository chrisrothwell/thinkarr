import { getConfig } from "@/lib/config";
import { logger } from "@/lib/logger";

function getOverseerrConfig() {
  const url = getConfig("overseerr.url");
  const apiKey = getConfig("overseerr.apiKey");
  if (!url || !apiKey) throw new Error("Overseerr not configured");
  return { url: url.replace(/\/$/, ""), apiKey };
}

async function overseerrFetch(path: string, options?: RequestInit) {
  const { url, apiKey } = getOverseerrConfig();
  const fullUrl = `${url}/api/v1${path}`;
  const method = (options?.method ?? "GET").toUpperCase();
  logger.info("Overseerr API request", { method, url: fullUrl, body: options?.body ?? undefined });
  const res = await fetch(fullUrl, {
    ...options,
    headers: {
      "X-Api-Key": apiKey,
      "Content-Type": "application/json",
      ...options?.headers,
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    let detail = "";
    let rawBody: unknown;
    try {
      rawBody = await res.json();
      detail = (rawBody as Record<string, string>).message || (rawBody as Record<string, string>).error || JSON.stringify(rawBody);
    } catch { /* ignore parse failure */ }
    logger.warn("Overseerr API error", { method, url: fullUrl, status: res.status, body: rawBody });
    throw new Error(`Overseerr API error: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
  }
  const data = await res.json();
  logger.info("Overseerr API response", { method, url: fullUrl, status: res.status, body: JSON.stringify(data).slice(0, 5000) });
  return data;
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
  posterUrl?: string;       // Full TMDB poster URL (https://image.tmdb.org/t/p/w300/...)
  imdbId?: string;          // IMDB ID (e.g. "tt1234567") when available
  // TV-specific
  seasonCount?: number;
  seasons?: OverseerrSeasonStatus[];
}

function mediaStatusLabel(info?: Record<string, unknown>): string {
  if (!info) return "Not Requested";
  switch (info.status) {
    case 1: return "Not Requested"; // Overseerr "Unknown" = tracked but nothing requested
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
  const raw = (data?.results || []).slice(0, 10) as Record<string, unknown>[];

  // Fetch TV details in parallel to get numberOfSeasons (not in search results)
  const tvDetailMap = new Map<number, number>();
  await Promise.all(
    raw
      .filter((r) => r.mediaType === "tv")
      .map(async (r) => {
        try {
          const detail = await overseerrFetch(`/tv/${r.id as number}`);
          const count = detail?.numberOfSeasons as number | undefined;
          if (count) tvDetailMap.set(r.id as number, count);
        } catch { /* non-fatal — seasonCount stays undefined */ }
      }),
  );

  return raw.map((r) => {
    const mediaInfo = r.mediaInfo as Record<string, unknown> | undefined;
    const isTV = r.mediaType === "tv";
    const rawSeasons = (mediaInfo?.seasons as Record<string, unknown>[]) || [];

    const posterPath = r.posterPath as string | undefined;
    const extIds = r.externalIds as Record<string, unknown> | undefined;
    const imdbId = (r.imdbId as string | undefined) ?? (extIds?.imdbId as string | undefined);
    return {
      id: r.id as number,
      mediaType: r.mediaType as string,
      title: (r.title || r.name) as string,
      year: ((r.releaseDate || r.firstAirDate) as string | undefined)?.substring(0, 4),
      overview: (r.overview as string | undefined)?.substring(0, 300),
      releaseDate: (r.releaseDate || r.firstAirDate) as string | undefined,
      mediaStatus: mediaStatusLabel(mediaInfo),
      posterUrl: posterPath ? `https://image.tmdb.org/t/p/w300${posterPath}` : undefined,
      imdbId: imdbId || undefined,
      seasonCount: isTV ? (tvDetailMap.get(r.id as number) ?? (r.numberOfSeasons as number | undefined)) : undefined,
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
  const rawRequests: Record<string, unknown>[] = data?.results || [];

  // Fetch titles in parallel — the request endpoint's media object contains IDs but not titles
  const titleMap = new Map<number, string>();
  await Promise.all(
    rawRequests.map(async (r) => {
      const media = r.media as Record<string, unknown> | undefined;
      const tmdbId = media?.tmdbId as number | undefined;
      if (!tmdbId) return;
      try {
        if (r.type === "movie") {
          const detail = await overseerrFetch(`/movie/${tmdbId}`);
          const title = (detail?.title || detail?.originalTitle) as string | undefined;
          if (title) titleMap.set(r.id as number, title);
        } else if (r.type === "tv") {
          const detail = await overseerrFetch(`/tv/${tmdbId}`);
          const name = (detail?.name || detail?.originalName) as string | undefined;
          if (name) titleMap.set(r.id as number, name);
        }
      } catch { /* non-fatal — falls back to "Unknown" */ }
    }),
  );

  return rawRequests.map((r: Record<string, unknown>) => {
    const media = r.media as Record<string, unknown> | undefined;
    const isTV = r.type === "tv";
    const seasonsList = isTV
      ? ((r.seasons as Record<string, unknown>[]) || []).map((s) => s.seasonNumber as number).sort((a, b) => a - b)
      : undefined;

    return {
      id: r.id as number,
      type: r.type as string,
      title: titleMap.get(r.id as number) ?? (media?.title || media?.name || "Unknown") as string,
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
