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
  logger.info("Plex API response", { url: fullUrl, status: res.status });
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
  imdbId?: string;              // IMDb ID from Plex Guid (e.g. "tt1234567") — pass to display_titles for More Info link
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

/** Extract IMDb ID from a Plex Guid array: [{"id":"imdb://tt1234567"},{"id":"tvdb://12345"}] */
function extractImdbId(item: Record<string, unknown>): string | undefined {
  const guids = (item.Guid as Array<{ id: string }> | undefined) ?? [];
  const imdbGuid = guids.find((g) => typeof g.id === "string" && g.id.startsWith("imdb://"));
  return imdbGuid ? imdbGuid.id.slice("imdb://".length) : undefined;
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
    imdbId: extractImdbId(item),
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
 * Resolve metadata from a Plex key: returns both the IMDb ID (from the show's Guid array)
 * and the item's own thumbPath. thumbPath is captured before following parentKey so it
 * reflects the actual item (e.g. a season's thumb), not the show's thumb.
 *
 * For season keys, follows parentKey to the show for IMDb resolution (Guid lives on the show).
 * Returns empty object if Plex is unreachable.
 *
 * Used by display-titles-tool as a side-query to recover imdbId and thumbPath when the LLM
 * drops them (issues #351, #364).
 */
export async function getMetadataFromPlexKey(plexKey: string): Promise<{ imdbId?: string; thumbPath?: string }> {
  // Strip /children to get the metadata item path (e.g. "/library/metadata/7938/children" → "/library/metadata/7938")
  const normalizedKey = plexKey.replace(/\/children\/?$/, "");
  const path = normalizedKey.startsWith("/") ? normalizedKey : `/${normalizedKey}`;

  const data = await plexFetch(path);
  let item: Record<string, unknown> = data?.MediaContainer?.Metadata?.[0] ?? {};

  // thumb lives on the item itself — capture before following parentKey
  const thumbPath = item.thumb as string | undefined;

  // IMDb Guid is on the show — follow parentKey for seasons, grandparentKey for episodes
  const itemType = item.type as string | undefined;
  if (itemType === "season" && item.parentKey) {
    const parentPath = (item.parentKey as string).startsWith("/")
      ? (item.parentKey as string)
      : `/${item.parentKey as string}`;
    try {
      const parentData = await plexFetch(parentPath);
      item = parentData?.MediaContainer?.Metadata?.[0] ?? item;
    } catch { /* fall through to season's own Guid */ }
  } else if (itemType === "episode" && item.grandparentKey) {
    const grandparentPath = (item.grandparentKey as string).startsWith("/")
      ? (item.grandparentKey as string)
      : `/${item.grandparentKey as string}`;
    try {
      const grandparentData = await plexFetch(grandparentPath);
      item = grandparentData?.MediaContainer?.Metadata?.[0] ?? item;
    } catch { /* fall through to episode's own Guid */ }
  }

  return { imdbId: extractImdbId(item), thumbPath };
}

/**
 * Resolve an IMDb ID for a given Plex metadata key.
 * @deprecated Use getMetadataFromPlexKey — returns both imdbId and thumbPath in one fetch.
 */
export async function getImdbIdFromPlexKey(plexKey: string): Promise<string | undefined> {
  return (await getMetadataFromPlexKey(plexKey)).imdbId;
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
  // Hub search limit is per-hub, not a global total. Fetch 50 per hub (the batch size);
  // sub-paginate to 10 items per LLM page (5 LLM pages per hub batch).
  const llmOffset = ((page - 1) % 5) * 10;
  const data = await plexFetch(`/hubs/search?query=${encodeURIComponent(query)}&limit=50`);
  const all: PlexSearchResult[] = [];
  for (const hub of data?.MediaContainer?.Hub || []) {
    for (const item of hub.Metadata || []) {
      const resolvedType = hub.type || item.type;
      // Skip individual episodes — callers should use plex_get_series_episodes for those
      if (resolvedType === "episode") continue;
      all.push(mapMetadata(item, resolvedType));
    }
  }
  const hasMore = all.length > llmOffset + 10;
  return { results: all.slice(llmOffset, llmOffset + 10), hasMore };
}

/**
 * Find the Plex metadata key for a TV series by title (and optionally year).
 * Scans ALL hubs returned by the hub search — not just the first 10 items —
 * so that show-level results buried behind episode/season hubs are found.
 * Returns the key of the first show-level result whose title matches, or
 * undefined if no match is found.
 *
 * Used by display_titles to inject plexKey for TV series from Overseerr (#117).
 */
export async function findShowPlexKey(title: string, year?: number): Promise<string | undefined> {
  const data = await plexFetch(`/hubs/search?query=${encodeURIComponent(title)}&limit=50`);
  const titleLower = title.toLowerCase();

  // Collect all raw hub items so we can search across all hubs, not just the first 10.
  // Priority: show-level hits first, then season hits (by showTitle), then episode hits.
  let showMatch: string | undefined;
  let seasonFallback: string | undefined;  // parentKey of a matching season
  let episodeFallback: string | undefined; // parentKey of a matching episode (via grandparentTitle)

  for (const hub of data?.MediaContainer?.Hub || []) {
    for (const item of hub.Metadata as Record<string, unknown>[]) {
      const resolvedType = ((hub.type || item.type) as string | undefined) ?? "";

      if (resolvedType === "show") {
        const itemTitle = (item.title as string | undefined)?.toLowerCase();
        const itemYear = item.year as number | undefined;
        if (itemTitle === titleLower && (!year || !itemYear || itemYear === year)) {
          // Exact show match — best possible result, return immediately
          return item.key as string;
        }
      } else if (resolvedType === "season" && !seasonFallback) {
        // Season: parentTitle is the show name; parentKey is the show's metadata key
        const parentTitle = (item.parentTitle as string | undefined)?.toLowerCase();
        const parentKey = item.parentKey as string | undefined;
        if (parentTitle === titleLower && parentKey) {
          seasonFallback = parentKey;
        }
      } else if (resolvedType === "episode" && !episodeFallback) {
        // Episode: grandparentTitle is the show name; grandparentKey is the show's metadata key
        const grandparentTitle = (item.grandparentTitle as string | undefined)?.toLowerCase();
        const grandparentKey = item.grandparentKey as string | undefined;
        if (grandparentTitle === titleLower && grandparentKey) {
          episodeFallback = grandparentKey;
        }
      }
    }
  }

  return showMatch ?? seasonFallback ?? episodeFallback;
}

export async function getOnDeck(page = 1): Promise<{ results: PlexSearchResult[]; hasMore: boolean }> {
  // Fetch 50 items per API batch; return 10 per LLM page (5 LLM pages per batch).
  const apiBatch = Math.floor((page - 1) / 5);
  const llmOffset = ((page - 1) % 5) * 10;
  const start = apiBatch * 50;
  const data = await plexFetch(`/library/onDeck?X-Plex-Container-Start=${start}&X-Plex-Container-Size=50`);
  const items: PlexSearchResult[] = (data?.MediaContainer?.Metadata || []).map((item: Record<string, unknown>) => mapMetadata(item));
  const hasMore = items.length > llmOffset + 10;
  return { results: items.slice(llmOffset, llmOffset + 10), hasMore };
}

export async function getRecentlyAdded(page = 1): Promise<{ results: PlexSearchResult[]; hasMore: boolean }> {
  // Fetch 200 raw items so deduplication is stable; return 10 deduplicated items per LLM page.
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

  const offset = (page - 1) * 10;
  const hasMore = deduped.length > offset + 10;
  return { results: deduped.slice(offset, offset + 10), hasMore };
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
    // Fetch all children; return 10 per LLM page.
    const offset = (page - 1) * 10;
    const hasMore = all.length > offset + 10;
    return { results: all.slice(offset, offset + 10), hasMore };
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

  // Fetch 50 items per API batch; return 10 per LLM page (5 LLM pages per batch).
  const apiBatch = Math.floor((page - 1) / 5);
  const llmOffset = ((page - 1) % 5) * 10;
  const apiBatchStart = apiBatch * 50;
  const needed = apiBatchStart + llmOffset + 11; // one extra item to detect hasMore

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

  const hasMore = all.length > apiBatchStart + llmOffset + 10;
  return { results: all.slice(apiBatchStart + llmOffset, apiBatchStart + llmOffset + 10), hasMore };
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
export interface PlexSeriesEpisodesResult {
  results: PlexSearchResult[];
  hasMore: boolean;
}

/**
 * Return season or episode data for a Plex TV series.
 *
 * - No season/episode: returns one card per season ordered by season number.
 *   Each card has totalEpisodes and watchedEpisodes from the season metadata.
 * - season only: returns episodes from that season ordered by episode number.
 * - season + episode: returns a single matching episode.
 *
 * plexKey must be the show-level metadata key (e.g. "/library/metadata/123").
 */
export async function getSeriesEpisodes(
  plexKey: string,
  season?: number,
  episode?: number,
): Promise<PlexSeriesEpisodesResult> {
  // Plex hub search returns show keys with a trailing /children suffix.
  // Strip it so we can append /children ourselves without double-pathing.
  const normalizedKey = plexKey.replace(/\/children\/?$/, "");
  const showPath = normalizedKey.startsWith("/") ? normalizedKey : `/${normalizedKey}`;

  // Fetch the direct children of the given key
  const childrenData = await plexFetch(`${showPath}/children`);
  const allChildren = ((childrenData?.MediaContainer?.Metadata || []) as Record<string, unknown>[]);

  // If the key already points at a season (its children are episodes), fetch episodes directly.
  // This happens when the AI re-uses a season-level plexKey from a prior plex_get_series_episodes
  // result and passes it back alongside a season number — issue #211.
  const isSeasonKey = allChildren.some((c) => (c.type as string) === "episode");
  if (isSeasonKey) {
    const mapped: PlexSearchResult[] = allChildren
      .filter((e) => (e.type as string) === "episode")
      .sort((a, b) => (a.index as number) - (b.index as number))
      .map((e) => mapMetadata(e, "episode"));

    if (episode !== undefined) {
      const single = mapped.find((e) => e.episodeNumber === episode);
      return { results: single ? [single] : [], hasMore: false };
    }
    return { results: mapped, hasMore: false };
  }

  const rawSeasons = allChildren
    .filter((s) => (s.type as string) === "season" && (s.index as number) > 0)
    .sort((a, b) => (a.index as number) - (b.index as number));

  if (season === undefined) {
    // Return one card per season ordered by season number
    return { results: rawSeasons.map((s) => mapMetadata(s, "season")), hasMore: false };
  }

  // Find the matching season
  const matchingSeason = rawSeasons.find((s) => (s.index as number) === season);
  if (!matchingSeason) {
    return { results: [], hasMore: false };
  }

  // The season's ratingKey lets us fetch its children (episodes)
  const seasonRatingKey = matchingSeason.ratingKey as string | number;
  const seasonPath = `/library/metadata/${seasonRatingKey}/children`;
  const episodesData = await plexFetch(seasonPath);
  const mapped: PlexSearchResult[] = ((episodesData?.MediaContainer?.Metadata || []) as Record<string, unknown>[])
    .filter((e) => (e.type as string) === "episode")
    .sort((a, b) => (a.index as number) - (b.index as number))
    .map((e) => mapMetadata(e, "episode"));

  if (episode !== undefined) {
    const single = mapped.find((e) => e.episodeNumber === episode);
    return { results: single ? [single] : [], hasMore: false };
  }

  return { results: mapped, hasMore: false };
}

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
