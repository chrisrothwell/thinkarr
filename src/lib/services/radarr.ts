import { getConfig } from "@/lib/config";
import { logger } from "@/lib/logger";

function getRadarrConfig() {
  const url = getConfig("radarr.url");
  const apiKey = getConfig("radarr.apiKey");
  if (!url || !apiKey) throw new Error("Radarr not configured");
  return { url: url.replace(/\/$/, ""), apiKey };
}

async function radarrFetch(path: string) {
  const { url, apiKey } = getRadarrConfig();
  const fullUrl = `${url}/api/v3${path}`;
  logger.info("Radarr API request", { method: "GET", url: fullUrl });
  const res = await fetch(fullUrl, {
    headers: { "X-Api-Key": apiKey },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    logger.warn("Radarr API error", { url: fullUrl, status: res.status });
    throw new Error(`Radarr API error: HTTP ${res.status}`);
  }
  const data = await res.json();
  logger.info("Radarr API response", { url: fullUrl, status: res.status });
  return data;
}

export interface RadarrMovie {
  id?: number;
  title: string;
  year?: number;
  overview?: string;
  status?: string;
  monitored?: boolean;
  hasFile?: boolean;
  tmdbId?: number;
  // Enrichment fields — populated by the tool handler via Plex / Overseerr lookups
  thumbPath?: string;
  plexKey?: string;
  overseerrId?: number;
  cast?: string[];
  imdbId?: string;
  mediaStatus?: string;
}

export async function searchMovie(term: string): Promise<RadarrMovie[]> {
  const data = await radarrFetch("/movie");
  const needle = term.toLowerCase();
  const yearMatch = /^\d{4}$/.test(term.trim()) ? parseInt(term.trim(), 10) : null;
  return (data || [])
    .filter((m: Record<string, unknown>) =>
      (m.title as string)?.toLowerCase().includes(needle) ||
      (yearMatch !== null && m.year === yearMatch),
    )
    .slice(0, 10)
    .map((m: Record<string, unknown>) => ({
      id: m.id as number,
      title: m.title as string,
      year: m.year as number,
      overview: (m.overview as string)?.substring(0, 200),
      status: m.status as string,
      monitored: m.monitored as boolean,
      hasFile: m.hasFile as boolean,
      tmdbId: m.tmdbId as number,
    }));
}

/** @deprecated Avoid in LLM tools — returns all movies as a large payload. Use getMovieStatus instead. */
export async function listMovies(): Promise<RadarrMovie[]> {
  const data = await radarrFetch("/movie");
  return (data || []).map((m: Record<string, unknown>) => ({
    id: m.id as number,
    title: m.title as string,
    year: m.year as number,
    status: m.status as string,
    monitored: m.monitored as boolean,
    hasFile: m.hasFile as boolean,
  }));
}

export interface RadarrMovieStatus {
  title: string;
  year?: number;
  releaseStatus: string;   // announced, inCinemas, released, deleted
  monitored: boolean;
  downloaded: boolean;
  inQueue: boolean;
  downloadPercent?: number;
  timeLeft?: string;
  tmdbId?: number;
}

/**
 * Find a specific movie in Radarr and return detailed download/availability status.
 * Returns null if the movie is not managed by Radarr.
 */
export async function getMovieStatus(title: string): Promise<RadarrMovieStatus | null> {
  const allMovies = await radarrFetch("/movie");
  const match = (allMovies || []).find((m: Record<string, unknown>) =>
    (m.title as string).toLowerCase().includes(title.toLowerCase()),
  ) as Record<string, unknown> | undefined;

  if (!match) return null;

  // Check download queue for this movie
  const queue = await radarrFetch("/queue?pageSize=50");
  const queueItem = (queue?.records || []).find(
    (q: Record<string, unknown>) => (q.movie as Record<string, unknown>)?.id === match.id,
  ) as Record<string, unknown> | undefined;

  let downloadPercent: number | undefined;
  if (queueItem) {
    const size = (queueItem.size as number) || 0;
    const sizeLeft = (queueItem.sizeleft as number) || 0;
    downloadPercent = size > 0 ? Math.round(((size - sizeLeft) / size) * 100) : 0;
  }

  return {
    title: match.title as string,
    year: match.year as number | undefined,
    releaseStatus: match.status as string,
    monitored: match.monitored as boolean,
    downloaded: match.hasFile as boolean,
    inQueue: !!queueItem,
    downloadPercent,
    timeLeft: queueItem ? (queueItem.timeleft as string) || undefined : undefined,
    tmdbId: match.tmdbId as number | undefined,
  };
}

export interface RadarrQueueItem {
  movieTitle: string;
  status: string;
  timeLeft: string;
  downloadPercent: number;
}

export async function getQueue(): Promise<RadarrQueueItem[]> {
  const data = await radarrFetch("/queue?pageSize=20");
  return (data?.records || []).map((q: Record<string, unknown>) => {
    const size = (q.size as number) || 0;
    const sizeLeft = (q.sizeleft as number) || 0;
    const pct = size > 0 ? Math.round(((size - sizeLeft) / size) * 100) : 0;
    return {
      movieTitle: (q.movie as Record<string, unknown>)?.title as string || "Unknown",
      status: q.status as string,
      timeLeft: (q.timeleft as string) || "",
      downloadPercent: pct,
    };
  });
}
