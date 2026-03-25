import { z } from "zod";
import { defineTool } from "./registry";
import * as overseerr from "@/lib/services/overseerr";
import type { OverseerrSearchResult, OverseerrRequest, OverseerrDetails } from "@/lib/services/overseerr";

const pageParam = z.number().int().min(1).optional().describe("Page number (1-based). Omit or use 1 for the first page. Use hasMore from the previous response to know whether a next page exists.");

export function registerOverseerrTools() {
  defineTool({
    name: "overseerr_search",
    description: "Search for movies or TV shows on Overseerr. Returns mediaStatus, summary, rating, thumbPath, overseerrId, overseerrMediaType, and seasonCount. NOTE: seasonCount is sourced from the TMDB search API which does not include it for untracked shows — it may be 0 or missing. For TV shows always call overseerr_get_details to get the accurate season count before display_titles. Returns up to 10 results per page with a hasMore flag.",
    schema: z.object({
      query: z.string().describe("Search query (movie or TV show title)"),
      page: pageParam,
    }),
    handler: async (args) => overseerr.search(args.query, args.page ?? 1),
    llmSummary: (result: unknown) => {
      const r = result as { results: OverseerrSearchResult[]; hasMore: boolean };
      return {
        // thumbPath preserved: the LLM needs the poster URL to pass to
        // display_titles in follow-up turns without re-searching.
        // summary stripped: 300 chars × 10 results = main token saving.
        results: r.results.map(({ overseerrId, overseerrMediaType, title, year, rating, mediaStatus, seasonCount, thumbPath }) => ({
          overseerrId, overseerrMediaType, title, year, rating, mediaStatus, seasonCount, thumbPath,
        })),
        hasMore: r.hasMore,
      };
    },
  });

  defineTool({
    name: "overseerr_get_details",
    description: "Get full details for a specific movie or TV show from Overseerr. For TV shows this MUST be called before display_titles — it returns the accurate seasonCount from TMDB (the search result's seasonCount is unreliable) and a compact per-season availability string needed to set correct mediaStatus on each season card. Also returns cast (top 10), imdbId, genres, and runtime for all media types.",
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
      // Map Overseerr status strings to display_titles mediaStatus values
      const statusMap: Record<string, string> = {
        "Available": "available",
        "Partially Available": "partial",
        "Pending": "pending",
        "Processing": "pending",
      };
      const seasonsCompact = r.seasons && r.seasons.length > 0
        ? r.seasons
            .map((s) => `S${s.seasonNumber}:${statusMap[s.status] ?? "not_requested"}`)
            .join(" ")
        : undefined;
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
    handler: async (args) => overseerr.listRequests(args.page ?? 1),
    llmSummary: (result: unknown) => {
      const r = result as { results: OverseerrRequest[]; hasMore: boolean };
      return {
        results: r.results.map(({ mediaType, title, year, status, mediaStatus, requestedBy, overseerrId, seasonsRequested }) => ({
          mediaType, title, year, status, mediaStatus, requestedBy, overseerrId, seasonsRequested,
        })),
        hasMore: r.hasMore,
      };
    },
  });
}
