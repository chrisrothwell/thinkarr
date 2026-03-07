import { getConfig } from "@/lib/config";
import { logger } from "@/lib/logger";

function getSonarrConfig() {
  const url = getConfig("sonarr.url");
  const apiKey = getConfig("sonarr.apiKey");
  if (!url || !apiKey) throw new Error("Sonarr not configured");
  return { url: url.replace(/\/$/, ""), apiKey };
}

async function sonarrFetch(path: string) {
  const { url, apiKey } = getSonarrConfig();
  const fullUrl = `${url}/api/v3${path}`;
  logger.info("Sonarr API request", { method: "GET", url: fullUrl });
  const res = await fetch(fullUrl, {
    headers: { "X-Api-Key": apiKey },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    logger.warn("Sonarr API error", { url: fullUrl, status: res.status });
    throw new Error(`Sonarr API error: HTTP ${res.status}`);
  }
  const data = await res.json();
  logger.info("Sonarr API response", { url: fullUrl, status: res.status, body: JSON.stringify(data).slice(0, 5000) });
  return data;
}

export interface SonarrSeries {
  id?: number;
  title: string;
  year?: number;
  overview?: string;
  status?: string;
  seasonCount?: number;
  monitored?: boolean;
  tvdbId?: number;
}

export async function searchSeries(term: string): Promise<SonarrSeries[]> {
  const data = await sonarrFetch(`/series/lookup?term=${encodeURIComponent(term)}`);
  return (data || []).slice(0, 10).map((s: Record<string, unknown>) => ({
    id: s.id as number | undefined,
    title: s.title as string,
    year: s.year as number,
    overview: (s.overview as string)?.substring(0, 200),
    status: s.status as string,
    seasonCount: s.seasonCount as number,
    monitored: s.monitored as boolean,
    tvdbId: s.tvdbId as number,
  }));
}

/** @deprecated Avoid in LLM tools — returns all series as a large payload. Use getSeriesStatus instead. */
export async function listSeries(): Promise<SonarrSeries[]> {
  const data = await sonarrFetch("/series");
  return (data || []).map((s: Record<string, unknown>) => ({
    id: s.id as number,
    title: s.title as string,
    year: s.year as number,
    status: s.status as string,
    seasonCount: s.seasonCount as number,
    monitored: s.monitored as boolean,
  }));
}

export interface SonarrSeriesStatus {
  title: string;
  year?: number;
  networkStatus: string;   // continuing, ended, etc.
  monitored: boolean;
  totalSeasons: number;
  totalEpisodes: number;
  downloadedEpisodes: number;
  missingEpisodes: number;
  nextAiring?: string;
  seasons: Array<{
    seasonNumber: number;
    totalEpisodes: number;
    downloadedEpisodes: number;
    monitored: boolean;
  }>;
}

/**
 * Find a specific series in Sonarr and return detailed download/availability status.
 * Returns null if the series is not managed by Sonarr.
 */
export async function getSeriesStatus(title: string): Promise<SonarrSeriesStatus | null> {
  const allSeries = await sonarrFetch("/series");
  const match = (allSeries || []).find((s: Record<string, unknown>) =>
    (s.title as string).toLowerCase().includes(title.toLowerCase()),
  ) as Record<string, unknown> | undefined;

  if (!match || !match.id) return null;

  // Fetch full detail with per-season statistics
  const detail = await sonarrFetch(`/series/${match.id as number}`);
  const stats = detail.statistics as Record<string, unknown> | undefined;

  return {
    title: detail.title as string,
    year: detail.year as number | undefined,
    networkStatus: detail.status as string,
    monitored: detail.monitored as boolean,
    totalSeasons: (detail.seasons as unknown[])?.length ?? 0,
    totalEpisodes: (stats?.totalEpisodeCount as number) ?? 0,
    downloadedEpisodes: (stats?.episodeCount as number) ?? 0,
    missingEpisodes: ((stats?.totalEpisodeCount as number) ?? 0) - ((stats?.episodeCount as number) ?? 0),
    nextAiring: detail.nextAiring as string | undefined,
    seasons: ((detail.seasons as Record<string, unknown>[]) || [])
      .filter((s) => (s.seasonNumber as number) > 0)
      .map((s) => {
        const seasonStats = s.statistics as Record<string, unknown> | undefined;
        return {
          seasonNumber: s.seasonNumber as number,
          totalEpisodes: (seasonStats?.totalEpisodeCount as number) ?? 0,
          downloadedEpisodes: (seasonStats?.episodeCount as number) ?? 0,
          monitored: s.monitored as boolean,
        };
      }),
  };
}

export interface SonarrCalendarEntry {
  seriesTitle: string;
  episodeTitle: string;
  seasonNumber: number;
  episodeNumber: number;
  airDateUtc: string;
  hasFile: boolean;
}

export async function getCalendar(days: number = 7): Promise<SonarrCalendarEntry[]> {
  const start = new Date().toISOString().split("T")[0];
  const end = new Date(Date.now() + days * 86400000).toISOString().split("T")[0];
  const data = await sonarrFetch(`/calendar?start=${start}&end=${end}`);
  return (data || []).map((e: Record<string, unknown>) => ({
    seriesTitle: (e.series as Record<string, unknown>)?.title as string || "Unknown",
    episodeTitle: e.title as string,
    seasonNumber: e.seasonNumber as number,
    episodeNumber: e.episodeNumber as number,
    airDateUtc: e.airDateUtc as string,
    hasFile: e.hasFile as boolean,
  }));
}

export interface SonarrQueueItem {
  seriesTitle: string;
  seasonNumber: number;
  episodeNumber: number;
  episodeTitle: string;
  status: string;
  timeLeft: string;
  downloadPercent: number;
}

export async function getQueue(): Promise<SonarrQueueItem[]> {
  const data = await sonarrFetch("/queue?pageSize=20");
  return (data?.records || []).map((q: Record<string, unknown>) => {
    const size = (q.size as number) || 0;
    const sizeLeft = (q.sizeleft as number) || 0;
    const downloaded = size - sizeLeft;
    const pct = size > 0 ? Math.round((downloaded / size) * 100) : 0;
    const episode = q.episode as Record<string, unknown> | undefined;
    return {
      seriesTitle: (q.series as Record<string, unknown>)?.title as string || "Unknown",
      seasonNumber: (episode?.seasonNumber as number) ?? 0,
      episodeNumber: (episode?.episodeNumber as number) ?? 0,
      episodeTitle: episode?.title as string || "Unknown",
      status: q.status as string,
      timeLeft: (q.timeleft as string) || "",
      downloadPercent: pct,
    };
  });
}
