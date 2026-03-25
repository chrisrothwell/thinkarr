import { z } from "zod";
import { defineTool } from "./registry";
import * as overseerr from "@/lib/services/overseerr";
import type { OverseerrSearchResult, OverseerrRequest, OverseerrDetails } from "@/lib/services/overseerr";

const pageParam = z.number().int().min(1).optional().describe("Page number (1-based). Omit or use 1 for the first page. Use hasMore from the previous response to know whether a next page exists.");

export function registerOverseerrTools() {
  defineTool({
    name: "overseerr_search",
    description: "Search for movies or TV shows on Overseerr. Returns title card fields from the search payload directly — no extra fetches: mediaStatus (availability), summary (synopsis), rating, thumbPath (poster), seasonCount (TV), overseerrId, and overseerrMediaType. Returns up to 10 results per page with a hasMore flag. For cast, imdbId, genres, runtime, per-season availability, or request history, call overseerr_get_details.",
    schema: z.object({
      query: z.string().describe("Search query (movie or TV show title)"),
      page: pageParam,
    }),
    handler: async (args) => overseerr.search(args.query, args.page ?? 1),
    llmSummary: (result: unknown) => {
      const r = result as { results: OverseerrSearchResult[]; hasMore: boolean };
      return {
        results: r.results.map(({ overseerrId, overseerrMediaType, title, year, rating, mediaStatus, seasonCount }) => ({
          overseerrId, overseerrMediaType, title, year, rating, mediaStatus, seasonCount,
        })),
        hasMore: r.hasMore,
      };
    },
  });

  defineTool({
    name: "overseerr_get_details",
    description: "Get full details for a specific movie or TV show from Overseerr. Returns cast (top 10), imdbId, genres, runtime (movie) or episode runtime (TV), season-by-season availability, and pending/approved request history. Call this to enrich a title card with cast, or when the user asks for more information about a specific title.",
    schema: z.object({
      id: z.number().int().describe("Overseerr media ID (overseerrId from overseerr_search results)"),
      mediaType: z.enum(["movie", "tv"]).describe("Media type"),
    }),
    handler: async (args) => overseerr.getDetails(args.id, args.mediaType),
    /** Compact history summary: keep identity + cast (5) + genres + runtime fields.
     *  Strip the per-season status list (can be 20+ entries) and request history. */
    llmSummary: (result: unknown) => {
      const r = result as OverseerrDetails;
      const availableSeasons = r.seasons
        ?.filter((s) => s.status === "Available")
        .map((s) => s.seasonNumber);
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
        ...(availableSeasons && availableSeasons.length > 0 ? { availableSeasons } : {}),
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
