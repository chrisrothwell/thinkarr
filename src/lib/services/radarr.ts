import { getConfig } from "@/lib/config";

function getRadarrConfig() {
  const url = getConfig("radarr.url");
  const apiKey = getConfig("radarr.apiKey");
  if (!url || !apiKey) throw new Error("Radarr not configured");
  return { url: url.replace(/\/$/, ""), apiKey };
}

async function radarrFetch(path: string) {
  const { url, apiKey } = getRadarrConfig();
  const res = await fetch(`${url}/api/v3${path}`, {
    headers: { "X-Api-Key": apiKey },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Radarr API error: HTTP ${res.status}`);
  return res.json();
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
}

export async function searchMovie(term: string): Promise<RadarrMovie[]> {
  const data = await radarrFetch(`/movie/lookup?term=${encodeURIComponent(term)}`);
  return (data || []).slice(0, 10).map((m: Record<string, unknown>) => ({
    id: m.id as number | undefined,
    title: m.title as string,
    year: m.year as number,
    overview: (m.overview as string)?.substring(0, 200),
    status: m.status as string,
    monitored: m.monitored as boolean,
    hasFile: m.hasFile as boolean,
    tmdbId: m.tmdbId as number,
  }));
}

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

export interface RadarrQueueItem {
  movieTitle: string;
  status: string;
  timeLeft: string;
  size: number;
  sizeleft: number;
}

export async function getQueue(): Promise<RadarrQueueItem[]> {
  const data = await radarrFetch("/queue?pageSize=20");
  return (data?.records || []).map((q: Record<string, unknown>) => ({
    movieTitle: (q.movie as Record<string, unknown>)?.title as string || "Unknown",
    status: q.status as string,
    timeLeft: q.timeleft as string || "",
    size: q.size as number,
    sizeleft: q.sizeleft as number,
  }));
}
