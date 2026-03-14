import { getConfig } from "@/lib/config";
import { logger } from "@/lib/logger";

function getPlexConfig() {
  const url = getConfig("plex.url");
  const token = getConfig("plex.token");
  if (!url || !token) throw new Error("Plex not configured");
  return { url: url.replace(/\/$/, ""), token };
}

async function plexFetch(path: string) {
  const { url, token } = getPlexConfig();
  const fullUrl = `${url}${path}`;
  logger.info("Plex API request", { method: "GET", url: fullUrl });
  const res = await fetch(fullUrl, {
    headers: {
      "X-Plex-Token": token,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    logger.warn("Plex API error", { url: fullUrl, status: res.status });
    throw new Error(`Plex API error: HTTP ${res.status}`);
  }
  const data = await res.json();
  logger.info("Plex API response", { url: fullUrl, status: res.status, body: JSON.stringify(data).slice(0, 5000) });
  return data;
}

export interface PlexSearchResult {
  title: string;
  year?: number;
  type: string;
  summary?: string;
  rating?: number;
  key: string;
  thumb?: string;           // Thumbnail path (e.g. /library/metadata/123/thumb/...)
  cast?: string[];          // First 4 cast member names
  // Show-specific fields
  seasons?: number;         // Number of seasons (childCount)
  totalEpisodes?: number;   // Total episodes in library (leafCount)
  watchedEpisodes?: number; // Episodes watched (viewedLeafCount)
  dateAdded?: string;       // ISO date string (addedAt Unix → ISO)
  // Episode-specific fields
  showTitle?: string;       // Parent show title (grandparentTitle)
  seasonNumber?: number;    // Season number (parentIndex)
  episodeNumber?: number;   // Episode number within season (index)
}

function mapMetadata(item: Record<string, unknown>, type?: string): PlexSearchResult {
  const addedAt = item.addedAt as number | undefined;
  const resolvedType = (type || item.type) as string;
  const roles = (item.Role as Array<{ tag: string }> | undefined) ?? [];
  return {
    title: item.title as string,
    year: item.year as number | undefined,
    type: resolvedType,
    summary: (item.summary as string | undefined)?.substring(0, 300),
    rating: item.rating as number | undefined,
    key: item.key as string,
    thumb: item.thumb as string | undefined,
    cast: roles.slice(0, 4).map((r) => r.tag),
    seasons: item.childCount as number | undefined,
    totalEpisodes: item.leafCount as number | undefined,
    watchedEpisodes: item.viewedLeafCount as number | undefined,
    dateAdded: addedAt ? new Date(addedAt * 1000).toISOString().split("T")[0] : undefined,
    // Episode fields — only populated when type is "episode"
    showTitle: resolvedType === "episode" ? (item.grandparentTitle as string | undefined) : undefined,
    seasonNumber: resolvedType === "episode" ? (item.parentIndex as number | undefined) : undefined,
    episodeNumber: resolvedType === "episode" ? (item.index as number | undefined) : undefined,
  };
}

let cachedMachineId: string | undefined;

/** Returns the Plex server's machineIdentifier (cached in memory). */
export async function getPlexMachineId(): Promise<string | undefined> {
  if (cachedMachineId) return cachedMachineId;
  try {
    const data = await plexFetch("/");
    const id = data?.MediaContainer?.machineIdentifier as string | undefined;
    if (id) cachedMachineId = id;
    return id;
  } catch {
    return undefined;
  }
}

/**
 * Build a thumbnail URL that routes through the server-side proxy.
 * The proxy fetches the image from Plex using the stored token so the
 * token is never exposed to the browser.
 *
 * Returns undefined if Plex is not configured or thumbPath is empty.
 */
export function buildThumbUrl(thumbPath: string): string | undefined {
  const url = getConfig("plex.url");
  const token = getConfig("plex.token");
  if (!url || !token || !thumbPath) return undefined;
  return `/api/plex/thumb?path=${encodeURIComponent(thumbPath)}`;
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
