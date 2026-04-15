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
  logger.info("Sonarr API response", { url: fullUrl, status: res.status });
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
  // Internal: raw per-season data from Sonarr /series — consumed by enrichSonarrSeries,
  // never exposed to the LLM (stripped by llmSummary).
  sonarrSeasons?: Array<{ seasonNumber: number; episodeCount: number; monitored: boolean }>;
  // Enrichment fields — populated by the tool handler via Plex / Overseerr lookups
  thumbPath?: string;
  plexKey?: string;
  overseerrId?: number;
  cast?: string[];
  imdbId?: string;
  mediaStatus?: string;
  /** Per-season status derived from Sonarr episode counts. Only set when mediaStatus is
   *  'partial' (show spans multiple seasons, some downloaded and some not). The LLM uses
   *  this to assign the correct mediaStatus to each individual season card. */
  seasons?: Array<{ seasonNumber: number; mediaStatus: string }>;
}

export async function searchSeries(term: string): Promise<SonarrSeries[]> {
  const data = await sonarrFetch("/series");
  const needle = term.toLowerCase();
  const yearMatch = /^\d{4}$/.test(term.trim()) ? parseInt(term.trim(), 10) : null;
  return (data || [])
    .filter((s: Record<string, unknown>) =>
      (s.title as string)?.toLowerCase().includes(needle) ||
      (yearMatch !== null && s.year === yearMatch),
    )
    .slice(0, 10)
    .map((s: Record<string, unknown>) => {
      const rawSeasons = ((s.seasons as Array<Record<string, unknown>>) || [])
        .filter((season) => (season.seasonNumber as number) > 0);
      return {
        id: s.id as number,
        title: s.title as string,
        year: s.year as number,
        overview: (s.overview as string)?.substring(0, 200),
        status: s.status as string,
        seasonCount: rawSeasons.length || undefined,
        monitored: s.monitored as boolean,
        tvdbId: s.tvdbId as number,
        sonarrSeasons: rawSeasons.map((season) => {
          const stats = season.statistics as Record<string, unknown> | undefined;
          return {
            seasonNumber: season.seasonNumber as number,
            monitored: season.monitored as boolean,
            episodeCount: (stats?.episodeCount as number) ?? 0,
          };
        }),
      };
    });
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
  const needle = title.toLowerCase();
  // Prefer exact title match; fall back to substring only if nothing exact is found.
  const match = (
    (allSeries || []).find((s: Record<string, unknown>) =>
      (s.title as string).toLowerCase() === needle,
    ) ??
    (allSeries || []).find((s: Record<string, unknown>) =>
      (s.title as string).toLowerCase().includes(needle),
    )
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
    totalSeasons: ((detail.seasons as Array<Record<string, unknown>>) || []).filter((s) => (s.seasonNumber as number) > 0).length,
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
