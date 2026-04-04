import { z } from "zod";
import { defineTool } from "./registry";
import * as overseerr from "@/lib/services/overseerr";
import type { OverseerrSearchResult, OverseerrRequest, OverseerrDetails, OverseerrDiscoverResult, OverseerrEpisode } from "@/lib/services/overseerr";

const pageParam = z.number().int().min(1).optional().describe("Page number (1-based). Omit or use 1 for the first page. Use hasMore from the previous response to know whether a next page exists.");

/** Compact seasons string "S1:available S2:pending …" from a details object. */
function compactSeasons(detail: OverseerrDetails): string | undefined {
  if (!detail.seasons || detail.seasons.length === 0) return undefined;
  const statusMap: Record<string, string> = {
    "Available": "available",
    "Partially Available": "partial",
    "Pending": "pending",
    "Processing": "pending",
  };
  return detail.seasons
    .map((s) => `S${s.seasonNumber}:${statusMap[s.status] ?? "not_requested"}`)
    .join(" ");
}

export function registerOverseerrTools() {
  defineTool({
    name: "overseerr_search",
    description: "Search for a specific movie or TV show by title on Overseerr. IMPORTANT: The query MUST be a title (e.g. 'Breaking Bad', 'The Dark Knight'). Do NOT search by year, genre, actor, or keyword — use overseerr_discover for genre/trending browsing. Returns full details for each result including cast, imdbId, accurate seasonCount, per-season availability (seasons), mediaStatus, summary, rating, thumbPath, overseerrId, and overseerrMediaType. You can pass these fields directly to display_titles without calling overseerr_get_details first. Returns up to 10 results per page with a hasMore flag.",
    schema: z.object({
      query: z.string().describe("The exact or approximate title to search for (e.g. 'Inception', 'The Office'). Must be a title — not a year, genre, or keyword."),
      page: pageParam,
    }),
    handler: async (args) => {
      const { results, hasMore } = await overseerr.search(args.query, args.page ?? 1);
      // Enrich each result with cast, imdbId, accurate seasonCount, and per-season
      // availability by calling getDetails in parallel. Non-fatal: returns the base
      // search result if the detail fetch fails for any individual title.
      const enriched = await Promise.all(
        results.map(async (r) => {
          try {
            const mediaType = r.overseerrMediaType === "tv" ? "tv" : "movie";
            const detail = await overseerr.getDetails(r.overseerrId, mediaType);
            return {
              ...r,
              thumbPath: r.thumbPath ?? detail.thumbPath,
              cast: detail.cast,
              imdbId: detail.imdbId,
              ...(mediaType === "tv" ? {
                seasonCount: detail.seasonCount ?? r.seasonCount,
                seasons: detail.seasons,
              } : {}),
            };
          } catch {
            return r;
          }
        }),
      );
      // Normalize mediaStatus to lowercase display_titles-compatible values so the
      // LLM never sees title-cased strings like "Processing" or "Not Requested"
      // that would cause display_titles validation to fail (issues #281, #282).
      return {
        results: enriched.map((r) => ({ ...r, mediaStatus: overseerr.normalizeMediaStatus(r.mediaStatus) })),
        hasMore,
      };
    },
    llmSummary: (result: unknown) => {
      const r = result as { results: (OverseerrSearchResult & { cast?: string[]; imdbId?: string; seasons?: overseerr.OverseerrSeasonStatus[] })[]; hasMore: boolean };
      return {
        results: r.results.map(({ overseerrId, overseerrMediaType, title, year, rating, mediaStatus, seasonCount, thumbPath, cast, imdbId, seasons }) => ({
          overseerrId, overseerrMediaType, title, year, rating, mediaStatus, seasonCount, thumbPath,
          ...(cast && cast.length > 0 ? { cast: cast.slice(0, 3) } : {}),
          ...(imdbId ? { imdbId } : {}),
          // Compact seasons string for TV to preserve per-season status without
          // bloating history with full objects.
          ...(seasons && seasons.length > 0
            ? { seasons: seasons.map((s) => `S${s.seasonNumber}:${s.status.toLowerCase().replace(/ /g, "_")}`).join(" ") }
            : {}),
        })),
        hasMore: r.hasMore,
      };
    },
  });

  defineTool({
    name: "overseerr_get_details",
    description: "Get full details for a specific movie or TV show from Overseerr. NOTE: overseerr_search already returns cast, imdbId, seasonCount, per-season availability, and thumbPath — you do not need to call this after a search. Use this tool only when you need additional fields not returned by search (genres, runtime, episodeRuntime, full request history) or when you have an overseerrId without a prior search result.",
    schema: z.object({
      id: z.number().int().describe("Overseerr media ID (overseerrId from overseerr_search results)"),
      mediaType: z.enum(["movie", "tv"]).describe("Media type"),
    }),
    handler: async (args) => overseerr.getDetails(args.id, args.mediaType),
    /** Compact history summary: keep identity + cast (5) + genres + runtime fields.
     *  Seasons: compact string "S1:available S2:pending S3:not_requested" instead
     *  of full objects — preserves ALL per-season statuses so the LLM can set
     *  correct mediaStatus on follow-up display_titles calls (pending seasons must
     *  not be shown as not_requested, which would display a fake Request button).
     *  Request history dropped entirely (not needed after initial display). */
    llmSummary: (result: unknown) => {
      const r = result as OverseerrDetails;
      const seasonsCompact = compactSeasons(r);
      return {
        overseerrId: r.overseerrId,
        overseerrMediaType: r.overseerrMediaType,
        title: r.title,
        year: r.year,
        imdbId: r.imdbId,
        cast: r.cast?.slice(0, 5),
        genres: r.genres,
        runtime: r.runtime,
        episodeRuntime: r.episodeRuntime,
        seasonCount: r.seasonCount,
        ...(seasonsCompact ? { seasons: seasonsCompact } : {}),
      };
    },
  });

  defineTool({
    name: "overseerr_list_requests",
    description: "List recent media requests from Overseerr. Returns request metadata including thumbPath (poster), overseerrId, overseerrMediaType (as mediaType), mediaStatus, and title — all fields map directly to display_titles. ALWAYS follow with display_titles to render title cards. Use overseerr_search with the title if you also need rating and cast. Returns up to 50 results per page with a hasMore flag.",
    schema: z.object({
      page: pageParam,
    }),
    handler: async (args) => {
      const { results, hasMore } = await overseerr.listRequests(args.page ?? 1);
      // Enrich each result with thumbPath and (for TV) per-season availability by
      // calling getDetails in parallel. The /request endpoint does not reliably
      // include posterPath in the media object, so this is the only way to get
      // poster images and accurate season statuses for the title cards.
      const enriched = await Promise.all(
        results.map(async (r) => {
          if (!r.overseerrId) return r;
          try {
            const mediaType = r.mediaType === "tv" ? "tv" : "movie";
            const detail = await overseerr.getDetails(r.overseerrId, mediaType);
            return {
              ...r,
              thumbPath: r.thumbPath ?? detail.thumbPath,
              ...(mediaType === "tv" ? {
                seasons: detail.seasons,
                seasonCount: detail.seasonCount,
              } : {}),
            };
          } catch {
            return r;
          }
        }),
      );
      return { results: enriched, hasMore };
    },
    llmSummary: (result: unknown) => {
      const r = result as { results: (OverseerrRequest & { seasons?: overseerr.OverseerrSeasonStatus[]; seasonCount?: number })[]; hasMore: boolean };
      return {
        results: r.results.map(({ mediaType, title, year, status, mediaStatus, requestedBy, overseerrId, seasonsRequested, thumbPath, seasons }) => ({
          mediaType, title, year, status, mediaStatus, requestedBy, overseerrId, seasonsRequested,
          ...(thumbPath ? { thumbPath } : {}),
          ...(seasons && seasons.length > 0
            ? { seasons: seasons.map((s) => `S${s.seasonNumber}:${s.status.toLowerCase().replace(/ /g, "_")}`).join(" ") }
            : {}),
        })),
        hasMore: r.hasMore,
      };
    },
  });

  defineTool({
    name: "overseerr_get_season_episodes",
    description: "Get episode-level details (air dates, names, runtimes) for a specific season of a TV show from Overseerr. Use this when the user asks about episode air dates, premiere dates, or individual episode schedules — especially for pending or requested shows not yet in the library. Requires overseerrId and season number from a prior overseerr_search or overseerr_get_details call.",
    schema: z.object({
      id: z.number().int().describe("Overseerr TV show ID (overseerrId from search or details)"),
      seasonNumber: z.number().int().min(1).describe("Season number to fetch episodes for"),
    }),
    handler: async (args) => overseerr.getSeasonEpisodes(args.id, args.seasonNumber),
    llmSummary: (result: unknown) => {
      const r = result as { seasonNumber: number; episodes: OverseerrEpisode[] };
      return {
        seasonNumber: r.seasonNumber,
        episodes: r.episodes.map(({ episodeNumber, name, airDate, runtime, thumbPath }) => ({
          episodeNumber,
          name,
          ...(airDate ? { airDate } : {}),
          ...(runtime ? { runtime } : {}),
          ...(thumbPath ? { thumbPath } : {}),
        })),
      };
    },
  });

  defineTool({
    name: "overseerr_discover",
    description: "Discover movies or TV shows from Overseerr/TMDB without a specific title. Use this when the user asks for trending content, popular titles, upcoming releases, or wants to browse by genre (e.g. 'what movies are trending', 'show me upcoming movies', 'find some action movies'). Returns full details for each result including cast, imdbId, accurate seasonCount, per-season availability, mediaStatus, summary, rating, thumbPath, overseerrId, and overseerrMediaType — pass directly to display_titles. Returns up to 10 results per page with a hasMore flag.",
    schema: z.object({
      mediaType: z.enum(["movie", "tv"]).describe("Whether to discover movies or TV shows"),
      genre: z.string().optional().describe("Genre name to filter by (e.g. 'Action', 'Comedy', 'Drama'). Omit for general trending results."),
      category: z.enum(["trending", "upcoming"]).optional().describe("'trending' for popular titles (default), 'upcoming' for titles not yet released"),
      page: pageParam,
    }),
    handler: async (args) => {
      const { results, hasMore } = await overseerr.discover(args.mediaType, args.genre, args.category ?? "trending", args.page ?? 1);
      const enriched = await Promise.all(
        results.map(async (r) => {
          try {
            const mediaType = r.overseerrMediaType === "tv" ? "tv" : "movie";
            const detail = await overseerr.getDetails(r.overseerrId, mediaType);
            return {
              ...r,
              thumbPath: r.thumbPath ?? detail.thumbPath,
              cast: detail.cast,
              imdbId: detail.imdbId,
              ...(mediaType === "tv" ? {
                seasonCount: detail.seasonCount ?? r.seasonCount,
                seasons: detail.seasons,
              } : {}),
            };
          } catch {
            return r;
          }
        }),
      );
      // Normalize mediaStatus for the same reason as overseerr_search (issues #281, #282).
      return {
        results: enriched.map((r) => ({ ...r, mediaStatus: overseerr.normalizeMediaStatus(r.mediaStatus) })),
        hasMore,
      };
    },
    llmSummary: (result: unknown) => {
      const r = result as { results: (OverseerrDiscoverResult & { cast?: string[]; imdbId?: string; seasons?: overseerr.OverseerrSeasonStatus[] })[]; hasMore: boolean };
      return {
        results: r.results.map(({ overseerrId, overseerrMediaType, title, year, rating, mediaStatus, seasonCount, thumbPath, cast, imdbId, seasons }) => ({
          overseerrId, overseerrMediaType, title, year, rating, mediaStatus, seasonCount, thumbPath,
          ...(cast && cast.length > 0 ? { cast: cast.slice(0, 3) } : {}),
          ...(imdbId ? { imdbId } : {}),
          ...(seasons && seasons.length > 0
            ? { seasons: seasons.map((s) => `S${s.seasonNumber}:${s.status.toLowerCase().replace(/ /g, "_")}`).join(" ") }
            : {}),
        })),
        hasMore: r.hasMore,
      };
    },
  });
}
