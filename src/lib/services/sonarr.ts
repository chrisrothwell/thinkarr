import { getConfig } from "@/lib/config";

function getSonarrConfig() {
  const url = getConfig("sonarr.url");
  const apiKey = getConfig("sonarr.apiKey");
  if (!url || !apiKey) throw new Error("Sonarr not configured");
  return { url: url.replace(/\/$/, ""), apiKey };
}

async function sonarrFetch(path: string) {
  const { url, apiKey } = getSonarrConfig();
  const res = await fetch(`${url}/api/v3${path}`, {
    headers: { "X-Api-Key": apiKey },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Sonarr API error: HTTP ${res.status}`);
  return res.json();
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
  episodeTitle: string;
  status: string;
  timeLeft: string;
  size: number;
  sizeleft: number;
}

export async function getQueue(): Promise<SonarrQueueItem[]> {
  const data = await sonarrFetch("/queue?pageSize=20");
  return (data?.records || []).map((q: Record<string, unknown>) => ({
    seriesTitle: (q.series as Record<string, unknown>)?.title as string || "Unknown",
    episodeTitle: (q.episode as Record<string, unknown>)?.title as string || "Unknown",
    status: q.status as string,
    timeLeft: q.timeleft as string || "",
    size: q.size as number,
    sizeleft: q.sizeleft as number,
  }));
}
