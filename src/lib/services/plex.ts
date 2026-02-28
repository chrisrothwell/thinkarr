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
  key: string;
  // Show-specific fields
  seasons?: number;         // Number of seasons (childCount)
  totalEpisodes?: number;   // Total episodes in library (leafCount)
  watchedEpisodes?: number; // Episodes watched (viewedLeafCount)
  dateAdded?: string;       // ISO date string (addedAt Unix → ISO)
}

function mapMetadata(item: Record<string, unknown>, type?: string): PlexSearchResult {
  const addedAt = item.addedAt as number | undefined;
  return {
    title: item.title as string,
    year: item.year as number | undefined,
    type: (type || item.type) as string,
    summary: (item.summary as string | undefined)?.substring(0, 300),
    rating: item.rating as number | undefined,
    key: item.key as string,
    seasons: item.childCount as number | undefined,
    totalEpisodes: item.leafCount as number | undefined,
    watchedEpisodes: item.viewedLeafCount as number | undefined,
    dateAdded: addedAt ? new Date(addedAt * 1000).toISOString().split("T")[0] : undefined,
  };
}

export async function searchLibrary(query: string): Promise<PlexSearchResult[]> {
  const data = await plexFetch(`/hubs/search?query=${encodeURIComponent(query)}&limit=10`);
  const results: PlexSearchResult[] = [];
  for (const hub of data?.MediaContainer?.Hub || []) {
    for (const item of hub.Metadata || []) {
      results.push(mapMetadata(item, hub.type || item.type));
    }
  }
  return results;
}

export async function getOnDeck(): Promise<PlexSearchResult[]> {
  const data = await plexFetch("/library/onDeck?X-Plex-Container-Start=0&X-Plex-Container-Size=10");
  return (data?.MediaContainer?.Metadata || []).map((item: Record<string, unknown>) => mapMetadata(item));
}

export async function getRecentlyAdded(): Promise<PlexSearchResult[]> {
  const data = await plexFetch("/library/recentlyAdded?X-Plex-Container-Start=0&X-Plex-Container-Size=10");
  return (data?.MediaContainer?.Metadata || []).map((item: Record<string, unknown>) => mapMetadata(item));
}

export async function checkAvailability(title: string): Promise<{ available: boolean; results: PlexSearchResult[] }> {
  const results = await searchLibrary(title);
  return {
    available: results.length > 0,
    results: results.slice(0, 5),
  };
}
