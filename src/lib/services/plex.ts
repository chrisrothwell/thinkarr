import { getConfig } from "@/lib/config";

function getPlexConfig() {
  const url = getConfig("plex.url");
  const token = getConfig("plex.token");
  if (!url || !token) throw new Error("Plex not configured");
  return { url: url.replace(/\/$/, ""), token };
}

async function plexFetch(path: string) {
  const { url, token } = getPlexConfig();
  const res = await fetch(`${url}${path}`, {
    headers: {
      "X-Plex-Token": token,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Plex API error: HTTP ${res.status}`);
  return res.json();
}

export interface PlexSearchResult {
  title: string;
  year?: number;
  type: string;
  summary?: string;
  rating?: number;
  thumb?: string;
  key: string;
}

export async function searchLibrary(query: string): Promise<PlexSearchResult[]> {
  const data = await plexFetch(`/hubs/search?query=${encodeURIComponent(query)}&limit=10`);
  const results: PlexSearchResult[] = [];
  for (const hub of data?.MediaContainer?.Hub || []) {
    for (const item of hub.Metadata || []) {
      results.push({
        title: item.title,
        year: item.year,
        type: hub.type || item.type,
        summary: item.summary?.substring(0, 200),
        rating: item.rating,
        key: item.key,
      });
    }
  }
  return results;
}

export async function getOnDeck(): Promise<PlexSearchResult[]> {
  const data = await plexFetch("/library/onDeck?X-Plex-Container-Start=0&X-Plex-Container-Size=10");
  return (data?.MediaContainer?.Metadata || []).map((item: Record<string, unknown>) => ({
    title: item.title as string,
    year: item.year as number,
    type: item.type as string,
    summary: (item.summary as string)?.substring(0, 200),
    key: item.key as string,
  }));
}

export async function getRecentlyAdded(): Promise<PlexSearchResult[]> {
  const data = await plexFetch("/library/recentlyAdded?X-Plex-Container-Start=0&X-Plex-Container-Size=10");
  return (data?.MediaContainer?.Metadata || []).map((item: Record<string, unknown>) => ({
    title: item.title as string,
    year: item.year as number,
    type: item.type as string,
    summary: (item.summary as string)?.substring(0, 200),
    key: item.key as string,
  }));
}

export async function checkAvailability(title: string): Promise<{ available: boolean; results: PlexSearchResult[] }> {
  const results = await searchLibrary(title);
  return {
    available: results.length > 0,
    results: results.slice(0, 5),
  };
}
