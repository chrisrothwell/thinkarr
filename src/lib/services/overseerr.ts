import { getConfig } from "@/lib/config";
import { logger } from "@/lib/logger";

function getOverseerrConfig() {
  const url = getConfig("overseerr.url");
  const apiKey = getConfig("overseerr.apiKey");
  if (!url || !apiKey) throw new Error("Overseerr not configured");
  return { url: url.replace(/\/$/, ""), apiKey };
}

async function overseerrFetch(path: string, options?: RequestInit) {
  const { url, apiKey } = getOverseerrConfig();
  const fullUrl = `${url}/api/v1${path}`;
  const method = (options?.method ?? "GET").toUpperCase();
  logger.info("Overseerr API request", { method, url: fullUrl, body: options?.body ?? undefined });
  const res = await fetch(fullUrl, {
    ...options,
    headers: {
      "X-Api-Key": apiKey,
      "Content-Type": "application/json",
      ...options?.headers,
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    let detail = "";
    let rawBody: unknown;
    try {
      rawBody = await res.json();
      detail = (rawBody as Record<string, string>).message || (rawBody as Record<string, string>).error || JSON.stringify(rawBody);
    } catch { /* ignore parse failure */ }
    logger.warn("Overseerr API error", { method, url: fullUrl, status: res.status, body: rawBody });
    throw new Error(`Overseerr API error: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
  }
  const data = await res.json();
  logger.info("Overseerr API response", { method, url: fullUrl, status: res.status });
  return data;
}

export interface OverseerrSeasonStatus {
  seasonNumber: number;
  status: string; // "Available" | "Partially Available" | "Pending" | "Not Requested"
}

export interface OverseerrRequestSummary {
  id: number;
  status: string;
  requestedBy: string;
  requestedAt: string;
  seasonsRequested?: number[];
}

export interface OverseerrSearchResult {
  overseerrId: number;          // Overseerr media ID — pass directly as overseerrId to display_titles
  overseerrMediaType: string;   // "movie" | "tv" — pass directly as overseerrMediaType to display_titles
  title: string;
  year?: string;
  summary?: string;             // Synopsis — pass directly as summary to display_titles
  rating?: number;              // TMDB audience rating (0–10) — pass directly as rating to display_titles
  mediaStatus: string;
  thumbPath?: string;           // Full TMDB poster URL — pass directly as thumbPath to display_titles
  seasonCount?: number;         // TV only — total number of seasons; use to generate per-season cards
  // cast, imdbId, genres, runtime, seasons, requests → call overseerr_get_details
}

export interface OverseerrDetails {
  overseerrId: number;
  overseerrMediaType: string;
  title: string;
  year?: string;
  imdbId?: string;
  thumbPath?: string;            // Full TMDB poster URL — pass directly as thumbPath to display_titles
  cast?: string[];              // Top 10 cast members
  genres?: string[];
  runtime?: number;             // Movie: total runtime in minutes
  episodeRuntime?: number;      // TV: typical episode runtime in minutes
  seasonCount?: number;
  seasons?: OverseerrSeasonStatus[];   // Per-season availability
  requests?: OverseerrRequestSummary[]; // Pending/active requests
}

function mediaStatusLabel(info?: Record<string, unknown>): string {
  if (!info) return "Not Requested";
  switch (info.status) {
    case 1: return "Not Requested"; // Overseerr "Unknown" = tracked but nothing requested
    case 2: return "Pending";
    case 3: return "Processing";
    case 4: return "Partially Available";
    case 5: return "Available";
    default: return "Not Requested";
  }
}

function seasonStatusLabel(status: number): string {
  switch (status) {
    case 2: return "Pending";
    case 3: return "Processing";
    case 4: return "Partially Available";
    case 5: return "Available";
    default: return "Not Requested";
  }
}

export async function search(query: string, page = 1): Promise<{ results: OverseerrSearchResult[]; hasMore: boolean }> {
  // Overseerr/TMDB search returns ~20 items per API page.
  // We return 10 items per LLM page, so page maps 1:1 to TMDB pages.
  // Use encodeURIComponent to produce RFC 3986-compliant %20 encoding for spaces
  // and other reserved characters (#128). URLSearchParams uses + for spaces which
  // some servers do not decode as a space character.
  //
  // Overseerr validates the decoded query value server-side and rejects RFC 3986
  // reserved characters such as '(' and ')' with HTTP 400. Strip them before
  // encoding so queries like "Star Trek (2009)" succeed (#overseerr-paren-fix).
  const sanitized = query.replace(/[()[\]{}!$&'*+,;=?#@/\\]/g, " ").replace(/\s+/g, " ").trim();
  const data = await overseerrFetch(
    `/search?query=${encodeURIComponent(sanitized)}&page=${encodeURIComponent(String(page))}&language=en`,
  );
  const raw = (data?.results || []) as Record<string, unknown>[];
  const totalPages = (data?.totalPages as number | undefined) ?? 1;
  // Determine hasMore before slicing so we don't lose the count
  const hasMore = raw.length > 10 || page < totalPages;
  // Slice to the 10 items we'll return before fetching details — avoids
  // firing N detail calls for results that will be discarded (#151).
  const page10 = raw.slice(0, 10);

  // No per-result detail fetches: all fields needed for title cards are already
  // present in the search payload. cast, imdbId, genres, runtime, per-season
  // availability, and request history are available via overseerr_get_details.
  const results = page10.map((r) => {
    const mediaInfo = r.mediaInfo as Record<string, unknown> | undefined;
    const isTV = r.mediaType === "tv";
    const posterPath = r.posterPath as string | undefined;

    return {
      overseerrId: r.id as number,
      overseerrMediaType: r.mediaType as string,
      title: (r.title || r.name) as string,
      year: ((r.releaseDate || r.firstAirDate) as string | undefined)?.substring(0, 4),
      summary: (r.overview as string | undefined)?.substring(0, 300),
      rating: r.voteAverage as number | undefined,
      mediaStatus: mediaStatusLabel(mediaInfo),
      thumbPath: posterPath ? `https://image.tmdb.org/t/p/w300${posterPath}` : undefined,
      seasonCount: isTV ? (r.numberOfSeasons as number | undefined) : undefined,
    };
  });

  return { results, hasMore };
}

export async function getDetails(id: number, mediaType: "movie" | "tv"): Promise<OverseerrDetails> {
  const detail = await overseerrFetch(mediaType === "tv" ? `/tv/${id}` : `/movie/${id}`);

  const credits = detail?.credits as Record<string, unknown> | undefined;
  const castRaw = (credits?.cast as Record<string, unknown>[] | undefined) ?? [];
  const cast = castRaw.slice(0, 10).map((c) => c.name as string).filter(Boolean);

  const genreRaw = (detail?.genres as Record<string, unknown>[] | undefined) ?? [];
  const genres = genreRaw.map((g) => g.name as string).filter(Boolean);

  const extIds = detail?.externalIds as Record<string, unknown> | undefined;
  const imdbId = (extIds?.imdbId as string | undefined) || undefined;

  const mediaInfo = detail?.mediaInfo as Record<string, unknown> | undefined;
  const rawSeasons = (mediaInfo?.seasons as Record<string, unknown>[]) ?? [];
  const seasons: OverseerrSeasonStatus[] = rawSeasons
    .filter((s) => (s.seasonNumber as number) > 0)
    .map((s) => ({ seasonNumber: s.seasonNumber as number, status: seasonStatusLabel(s.status as number) }));

  const rawRequests = (mediaInfo?.requests as Record<string, unknown>[]) ?? [];
  const requests: OverseerrRequestSummary[] = rawRequests.map((req) => {
    const requester = req.requestedBy as Record<string, unknown> | undefined;
    const reqSeasons = mediaType === "tv"
      ? ((req.seasons as Record<string, unknown>[]) ?? [])
          .map((s) => s.seasonNumber as number)
          .sort((a, b) => a - b)
      : undefined;
    return {
      id: req.id as number,
      status: requestStatusLabel(req.status as number),
      requestedBy: (requester?.displayName as string | undefined) ?? "Unknown",
      requestedAt: req.createdAt as string,
      seasonsRequested: reqSeasons && reqSeasons.length > 0 ? reqSeasons : undefined,
    };
  });

  const title = (detail?.title || detail?.name) as string;
  const releaseDate = (detail?.releaseDate || detail?.firstAirDate) as string | undefined;
  const episodeRuntimes = detail?.episodeRunTime as number[] | undefined;
  const posterPath = detail?.posterPath as string | undefined;

  return {
    overseerrId: id,
    overseerrMediaType: mediaType,
    title,
    year: releaseDate?.substring(0, 4),
    imdbId,
    thumbPath: posterPath ? `https://image.tmdb.org/t/p/w300${posterPath}` : undefined,
    cast: cast.length > 0 ? cast : undefined,
    genres: genres.length > 0 ? genres : undefined,
    runtime: mediaType === "movie" ? (detail?.runtime as number | undefined) : undefined,
    episodeRuntime: mediaType === "tv" ? episodeRuntimes?.[0] : undefined,
    seasonCount: mediaType === "tv" ? (detail?.numberOfSeasons as number | undefined) : undefined,
    seasons: seasons.length > 0 ? seasons : undefined,
    requests: requests.length > 0 ? requests : undefined,
  };
}

/**
 * Normalise the human-readable Overseerr mediaStatus string (returned by the
 * search / discover endpoints) to the lowercase values expected by display_titles.
 */
export function normalizeMediaStatus(status: string): "available" | "partial" | "pending" | "not_requested" {
  switch (status) {
    case "Available": return "available";
    case "Partially Available": return "partial";
    case "Pending":
    case "Processing": return "pending";
    default: return "not_requested";
  }
}

export interface OverseerrRequest {
  id: number;           // Request ID (for tracking/admin purposes)
  mediaType: string;    // "movie" | "tv"
  title: string;
  year?: string;
  status: string;
  mediaStatus: string;  // "pending" | "not_requested" — maps directly to display_titles mediaStatus
  requestedBy: string;
  requestedAt: string;
  seasonsRequested?: number[];
  thumbPath?: string;   // Full TMDB poster URL — pass directly as thumbPath to display_titles
  tmdbId?: number;      // TMDB ID for cross-reference with overseerr_search
  overseerrId?: number; // Same as tmdbId — pass directly as overseerrId to display_titles
}

export async function listRequests(page = 1): Promise<{ results: OverseerrRequest[]; hasMore: boolean }> {
  // Fetch 50 items from the API; return 10 per LLM page (5 LLM pages per API batch).
  const apiBatch = Math.floor((page - 1) / 5);
  const skip = apiBatch * 50;
  const llmOffset = ((page - 1) % 5) * 10;
  const data = await overseerrFetch(`/request?take=50&skip=${skip}&sort=added`);
  const rawRequests: Record<string, unknown>[] = data?.results || [];

  // Build initial title map from fields already in the media object.
  // Some Overseerr/Jellyseerr versions include title/name in the media object;
  // for those that don't, fall back to fetching from /movie/{tmdbId} or /tv/{tmdbId}.
  const titleMap = new Map<number, string>();
  for (const r of rawRequests) {
    const media = r.media as Record<string, unknown> | undefined;
    const candidate = (media?.title || media?.name) as string | undefined;
    if (candidate) titleMap.set(r.id as number, candidate);
  }

  // Fetch titles in parallel only for requests where the media object lacked them
  const needsFetch = rawRequests.filter((r) => !titleMap.has(r.id as number));
  if (needsFetch.length > 0) {
    await Promise.all(
      needsFetch.map(async (r) => {
        const media = r.media as Record<string, unknown> | undefined;
        const tmdbId = media?.tmdbId as number | undefined;
        if (!tmdbId) return;
        try {
          if (r.type === "movie") {
            const detail = await overseerrFetch(`/movie/${tmdbId}`);
            const title = (detail?.title || detail?.originalTitle) as string | undefined;
            if (title) titleMap.set(r.id as number, title);
          } else if (r.type === "tv") {
            const detail = await overseerrFetch(`/tv/${tmdbId}`);
            const name = (detail?.name || detail?.originalName) as string | undefined;
            if (name) titleMap.set(r.id as number, name);
          }
        } catch { /* non-fatal — falls back to "Unknown" */ }
      }),
    );
  }

  const results: OverseerrRequest[] = rawRequests.map((r: Record<string, unknown>) => {
    const media = r.media as Record<string, unknown> | undefined;
    const isTV = r.type === "tv";
    const seasonsList = isTV
      ? ((r.seasons as Record<string, unknown>[]) || []).map((s) => s.seasonNumber as number).sort((a, b) => a - b)
      : undefined;
    const posterPath = media?.posterPath as string | undefined;
    const tmdbId = media?.tmdbId as number | undefined;

    // Derive mediaStatus from Overseerr media status — used by display_titles
    // status 3 = Declined request → content not_requested; all other active requests → pending
    const reqStatus = r.status as number;
    const mediaStatus = reqStatus === 3 ? "not_requested" : "pending";

    return {
      id: r.id as number,
      mediaType: r.type as string,
      title: (titleMap.get(r.id as number) ?? "Unknown") as string,
      year: ((media?.releaseDate || media?.firstAirDate) as string | undefined)?.substring(0, 4),
      status: requestStatusLabel(r.status as number),
      mediaStatus,
      requestedBy: ((r.requestedBy as Record<string, unknown>)?.displayName || "Unknown") as string,
      requestedAt: r.createdAt as string,
      seasonsRequested: seasonsList && seasonsList.length > 0 ? seasonsList : undefined,
      thumbPath: posterPath ? `https://image.tmdb.org/t/p/w300${posterPath}` : undefined,
      tmdbId: tmdbId ?? undefined,
      overseerrId: tmdbId ?? undefined,
    };
  });

  const pageInfo = data?.pageInfo as Record<string, number> | undefined;
  const total = pageInfo?.results ?? rawRequests.length;
  const hasMore = llmOffset + 10 < results.length || skip + rawRequests.length < total;
  return { results: results.slice(llmOffset, llmOffset + 10), hasMore };
}

export interface OverseerrDiscoverResult {
  overseerrId: number;
  overseerrMediaType: string;
  title: string;
  year?: string;
  summary?: string;
  rating?: number;
  mediaStatus: string;
  thumbPath?: string;
  seasonCount?: number;
}

export async function discover(
  mediaType: "movie" | "tv",
  genre?: string,
  category: "trending" | "upcoming" = "trending",
  page = 1,
): Promise<{ results: OverseerrDiscoverResult[]; hasMore: boolean }> {
  // Overseerr uses "movies" (plural) for movie discover endpoints but "movie" (singular)
  // for the genre list endpoint, and "tv" for both TV endpoints.
  const discoverSegment = mediaType === "movie" ? "movies" : "tv";

  // Resolve genre name to a TMDB genre ID when provided
  let genreId: number | undefined;
  if (genre) {
    const genresData = await overseerrFetch(`/discover/genres/${mediaType}`);
    const genres = (genresData as Array<{ id: number; name: string }>) ?? [];
    const match = genres.find((g) => g.name.toLowerCase() === genre.toLowerCase());
    genreId = match?.id;
  }

  let path: string;
  if (category === "upcoming") {
    path = `/discover/${discoverSegment}/upcoming?page=${page}`;
  } else {
    path = `/discover/${discoverSegment}?page=${page}`;
  }
  if (genreId != null) {
    path += `&genreIds=${genreId}`;
  }

  const data = await overseerrFetch(path);
  const raw = (data?.results || []) as Record<string, unknown>[];
  const totalPages = (data?.totalPages as number | undefined) ?? 1;
  const hasMore = raw.length > 10 || page < totalPages;
  const page10 = raw.slice(0, 10);

  const results: OverseerrDiscoverResult[] = page10.map((r) => {
    const mediaInfo = r.mediaInfo as Record<string, unknown> | undefined;
    const isTV = r.mediaType === "tv" || mediaType === "tv";
    const posterPath = r.posterPath as string | undefined;
    return {
      overseerrId: (r.id || r.tmdbId) as number,
      overseerrMediaType: mediaType,
      title: (r.title || r.name) as string,
      year: ((r.releaseDate || r.firstAirDate) as string | undefined)?.substring(0, 4),
      summary: (r.overview as string | undefined)?.substring(0, 300),
      rating: r.voteAverage as number | undefined,
      mediaStatus: mediaStatusLabel(mediaInfo),
      thumbPath: posterPath ? `https://image.tmdb.org/t/p/w300${posterPath}` : undefined,
      seasonCount: isTV ? (r.numberOfSeasons as number | undefined) : undefined,
    };
  });

  return { results, hasMore };
}

function requestStatusLabel(status: number): string {
  switch (status) {
    case 1: return "Pending Approval";
    case 2: return "Approved";
    case 3: return "Declined";
    default: return "Unknown";
  }
}

export async function requestMovie(tmdbId: number): Promise<{ success: boolean; message: string }> {
  try {
    await overseerrFetch("/request", {
      method: "POST",
      body: JSON.stringify({ mediaType: "movie", mediaId: tmdbId }),
    });
    return { success: true, message: "Movie request submitted successfully" };
  } catch (e: unknown) {
    return { success: false, message: e instanceof Error ? e.message : "Request failed" };
  }
}

export async function requestTv(
  tvdbId: number,
  seasons?: number[],
): Promise<{ success: boolean; message: string }> {
  try {
    const body: Record<string, unknown> = {
      mediaType: "tv",
      mediaId: tvdbId,
    };
    if (seasons && seasons.length > 0) {
      body.seasons = seasons;
    }
    await overseerrFetch("/request", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { success: true, message: "TV show request submitted successfully" };
  } catch (e: unknown) {
    return { success: false, message: e instanceof Error ? e.message : "Request failed" };
  }
}
