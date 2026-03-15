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
  // Episode / season fields — parent show context
  showTitle?: string;       // Parent show title (grandparentTitle for episode, parentTitle for season)
  seasonNumber?: number;    // Season number (parentIndex for episode, index for season)
  episodeNumber?: number;   // Episode number within season (index, episode only)
}

function mapMetadata(item: Record<string, unknown>, type?: string): PlexSearchResult {
  const addedAt = item.addedAt as number | undefined;
  const resolvedType = (type || item.type) as string;
  const roles = (item.Role as Array<{ tag: string }> | undefined) ?? [];

  // Derive parent show context depending on item type
  let showTitle: string | undefined;
  let seasonNumber: number | undefined;
  let episodeNumber: number | undefined;

  if (resolvedType === "episode") {
    showTitle = item.grandparentTitle as string | undefined;
    seasonNumber = item.parentIndex as number | undefined;
    episodeNumber = item.index as number | undefined;
  } else if (resolvedType === "season") {
    // Season items have the show name in parentTitle and season number in index
    showTitle = item.parentTitle as string | undefined;
    seasonNumber = item.index as number | undefined;
  }

  return {
    // For seasons, prefer the show title so callers don't see bare "Season N"
    title: resolvedType === "season" && showTitle
      ? `${showTitle} — Season ${seasonNumber ?? (item.index as number | undefined)}`
      : (item.title as string),
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
    showTitle,
    seasonNumber,
    episodeNumber,
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
  const data = await plexFetch("/library/recentlyAdded?X-Plex-Container-Start=0&X-Plex-Container-Size=20");
  const items: PlexSearchResult[] = (data?.MediaContainer?.Metadata || []).map(
    (item: Record<string, unknown>) => mapMetadata(item),
  );

  // Deduplicate TV seasons/episodes by show title — keep one representative entry per show
  // so the LLM doesn't receive 10 entries for the same series.
  const seen = new Set<string>();
  const deduped: PlexSearchResult[] = [];
  for (const item of items) {
    // Movies and shows use their own title as the dedup key; seasons/episodes use showTitle
    const key = (item.type === "season" || item.type === "episode") && item.showTitle
      ? `tv:${item.showTitle}`
      : `${item.type}:${item.title}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(item);
    }
    if (deduped.length >= 10) break;
  }
  return deduped;
}

export async function checkAvailability(title: string): Promise<{ available: boolean; results: PlexSearchResult[] }> {
  const results = await searchLibrary(title);
  return {
    available: results.length > 0,
    results: results.slice(0, 5),
  };
}
