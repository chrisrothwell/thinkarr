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
  mediaType: string;            // "movie" | "tv" | "episode" — normalized from Plex type ("show" → "tv")
  summary?: string;
  rating?: number;
  plexKey: string;              // Plex metadata key — pass directly as plexKey to display_titles
  thumbPath?: string;           // Plex thumb path — pass directly as thumbPath to display_titles
  cast?: string[];              // First 4 cast member names
  // Show-specific fields
  seasons?: number;             // Number of seasons (childCount)
  totalEpisodes?: number;       // Total episodes in library (leafCount)
  watchedEpisodes?: number;     // Episodes watched (viewedLeafCount)
  dateAdded?: string;           // ISO date string (addedAt Unix → ISO)
  // Episode / season fields — parent show context
  showTitle?: string;           // Parent show title (grandparentTitle for episode, parentTitle for season)
  seasonNumber?: number;        // Season number (parentIndex for episode, index for season)
  episodeNumber?: number;       // Episode number within season (index, episode only)
}

function mapMetadata(item: Record<string, unknown>, type?: string): PlexSearchResult {
  const addedAt = item.addedAt as number | undefined;
  const resolvedType = (type || item.type) as string;
  const roles = (item.Role as Array<{ tag: string }> | undefined) ?? [];

  // Normalize Plex type to display_titles mediaType values.
  // "show" and "season" both map to "tv"; others pass through as-is.
  const mediaType = (resolvedType === "show" || resolvedType === "season") ? "tv" : resolvedType;

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
    mediaType,
    summary: (item.summary as string | undefined)?.substring(0, 300),
    rating: item.rating as number | undefined,
    plexKey: item.key as string,
    thumbPath: item.thumb as string | undefined,
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

export async function searchLibrary(query: string, page = 1): Promise<{ results: PlexSearchResult[]; hasMore: boolean }> {
  const offset = (page - 1) * 50;
  const data = await plexFetch(`/hubs/search?query=${encodeURIComponent(query)}&limit=${offset + 51}`);
  const all: PlexSearchResult[] = [];
  for (const hub of data?.MediaContainer?.Hub || []) {
    for (const item of hub.Metadata || []) {
      all.push(mapMetadata(item, hub.type || item.type));
    }
  }
  const hasMore = all.length > offset + 50;
  return { results: all.slice(offset, offset + 50), hasMore };
}

export async function getOnDeck(page = 1): Promise<{ results: PlexSearchResult[]; hasMore: boolean }> {
  const start = (page - 1) * 50;
  const data = await plexFetch(`/library/onDeck?X-Plex-Container-Start=${start}&X-Plex-Container-Size=51`);
  const items: PlexSearchResult[] = (data?.MediaContainer?.Metadata || []).map((item: Record<string, unknown>) => mapMetadata(item));
  const hasMore = items.length > 50;
  return { results: items.slice(0, 50), hasMore };
}

export async function getRecentlyAdded(page = 1): Promise<{ results: PlexSearchResult[]; hasMore: boolean }> {
  // Fetch a large raw window to survive deduplication and return 50 unique entries per page.
  // We fetch 200 items from the start each time so deduplication is stable across pages.
  const data = await plexFetch("/library/recentlyAdded?X-Plex-Container-Start=0&X-Plex-Container-Size=200");
  const items: PlexSearchResult[] = (data?.MediaContainer?.Metadata || []).map(
    (item: Record<string, unknown>) => mapMetadata(item),
  );

  // Deduplicate TV seasons/episodes by show title — keep one representative entry per show
  // so the LLM doesn't receive many entries for the same series.
  const seen = new Set<string>();
  const deduped: PlexSearchResult[] = [];
  for (const item of items) {
    const key = item.showTitle
      ? `tv:${item.showTitle}`
      : `${item.mediaType}:${item.title}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(item);
    }
  }

  const offset = (page - 1) * 50;
  const hasMore = deduped.length > offset + 50;
  return { results: deduped.slice(offset, offset + 50), hasMore };
}

export async function checkAvailability(title: string): Promise<{ available: boolean; results: PlexSearchResult[] }> {
  const { results } = await searchLibrary(title);
  return {
    available: results.length > 0,
    results: results.slice(0, 5),
  };
}

/**
 * Find titles belonging to a named Plex collection.
 * Searches all library sections for a matching collection name and returns
 * the media items inside it.
 */
export async function searchCollections(collectionName: string, page = 1): Promise<{ results: PlexSearchResult[]; hasMore: boolean }> {
  const sectionsData = await plexFetch("/library/sections");
  const sections: Array<{ key: string }> = sectionsData?.MediaContainer?.Directory || [];

  for (const section of sections) {
    const collectionsData = await plexFetch(
      `/library/sections/${section.key}/collections?title=${encodeURIComponent(collectionName)}`,
    );
    const collections: Array<Record<string, unknown>> = collectionsData?.MediaContainer?.Metadata || [];

    if (collections.length === 0) continue;

    // Use the first matching collection; fetch its children
    const collection = collections[0];
    const collectionKey = (collection.ratingKey as string | undefined) || (collection.key as string | undefined);
    if (!collectionKey) continue;

    const childrenData = await plexFetch(`/library/collections/${collectionKey}/children`);
    const all: PlexSearchResult[] = (childrenData?.MediaContainer?.Metadata || []).map(
      (item: Record<string, unknown>) => mapMetadata(item),
    );
    const offset = (page - 1) * 50;
    const hasMore = all.length > offset + 50;
    return { results: all.slice(offset, offset + 50), hasMore };
  }

  return { results: [], hasMore: false };
}

/**
 * Valid Plex filter tag types for library searches.
 * Maps to the corresponding Plex API query parameter name.
 */
const TAG_TYPE_PARAM: Record<string, string> = {
  genre: "genre",
  director: "director",
  actor: "actor",
  country: "country",
  studio: "studio",
  contentRating: "contentRating",
  label: "label",
  mood: "mood",
};

/**
 * Search the Plex library by a tag value within a specific tag category.
 * Supports genre, director, actor, country, studio, contentRating, label, and mood.
 * Queries all movie and TV sections for items matching the tag.
 */
export async function searchByTag(tag: string, tagType: string = "genre", page = 1): Promise<{ results: PlexSearchResult[]; hasMore: boolean }> {
  const sectionsData = await plexFetch("/library/sections");
  const sections: Array<{ key: string; type: string }> = sectionsData?.MediaContainer?.Directory || [];

  // Resolve the Plex API query parameter for the given tag type
  const paramName = TAG_TYPE_PARAM[tagType] ?? "genre";

  const offset = (page - 1) * 50;
  const needed = offset + 51; // collect one extra to determine hasMore
  const all: PlexSearchResult[] = [];

  for (const section of sections) {
    // Only movie (type=movie) and show (type=show) sections support tag filtering
    if (section.type !== "movie" && section.type !== "show") continue;

    const plexType = section.type === "movie" ? "1" : "2";
    const data = await plexFetch(
      `/library/sections/${section.key}/all?type=${plexType}&${paramName}=${encodeURIComponent(tag)}`,
    );
    const items: Record<string, unknown>[] = data?.MediaContainer?.Metadata || [];
    for (const item of items) {
      all.push(mapMetadata(item));
      if (all.length >= needed) break;
    }
    if (all.length >= needed) break;
  }

  const hasMore = all.length > offset + 50;
  return { results: all.slice(offset, offset + 50), hasMore };
}

export interface PlexTitleTags {
  key: string;
  title: string;
  genres: string[];
  directors: string[];
  actors: string[];
  countries: string[];
  studio?: string;
  contentRating?: string;
  labels: string[];
}

/**
 * Retrieve all tags (genre, director, actor, country, etc.) associated with a
 * specific Plex title. Pass the Plex metadata key (e.g. "/library/metadata/123").
 *
 * Tags are stored at the show level, not on individual seasons or episodes.
 * When a season or episode key is passed, this function automatically fetches
 * the parent show's metadata instead.
 */
export async function getTagsForTitle(metadataKey: string): Promise<PlexTitleTags> {
  // Plex metadata keys start with /library/metadata/ — strip leading slash for fetch
  const path = metadataKey.startsWith("/") ? metadataKey : `/${metadataKey}`;
  const data = await plexFetch(path);
  let item: Record<string, unknown> = data?.MediaContainer?.Metadata?.[0] ?? {};

  // Tags live on the show, not on individual seasons or episodes.
  // Follow parentKey (season → show) or grandparentKey (episode → show).
  const itemType = item.type as string | undefined;
  if (itemType === "season") {
    const parentKey = item.parentKey as string | undefined;
    if (parentKey) {
      const parentPath = parentKey.startsWith("/") ? parentKey : `/${parentKey}`;
      try {
        const parentData = await plexFetch(parentPath);
        item = parentData?.MediaContainer?.Metadata?.[0] ?? item;
      } catch {
        // Non-fatal — fall back to season metadata (will have empty tags)
      }
    }
  } else if (itemType === "episode") {
    const grandparentKey = item.grandparentKey as string | undefined;
    if (grandparentKey) {
      const grandparentPath = grandparentKey.startsWith("/") ? grandparentKey : `/${grandparentKey}`;
      try {
        const grandparentData = await plexFetch(grandparentPath);
        item = grandparentData?.MediaContainer?.Metadata?.[0] ?? item;
      } catch {
        // Non-fatal — fall back to episode metadata
      }
    }
  }

  function extractTags(field: unknown): string[] {
    if (!Array.isArray(field)) return [];
    return (field as Array<{ tag: string }>).map((t) => t.tag).filter(Boolean);
  }

  return {
    key: metadataKey,
    title: item.title as string ?? "",
    genres: extractTags(item.Genre),
    directors: extractTags(item.Director),
    actors: extractTags(item.Role),
    countries: extractTags(item.Country),
    studio: item.studio as string | undefined,
    contentRating: item.contentRating as string | undefined,
    labels: extractTags(item.Label),
  };
}
