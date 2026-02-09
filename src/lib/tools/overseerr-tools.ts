import { z } from "zod";
import { defineTool } from "./registry";
import * as overseerr from "@/lib/services/overseerr";

export function registerOverseerrTools() {
  defineTool({
    name: "overseerr_search",
    description: "Search for movies or TV shows on Overseerr. Shows availability and request status.",
    schema: z.object({
      query: z.string().describe("Search query (movie or TV show title)"),
    }),
    handler: async (args) => overseerr.search(args.query),
  });

  defineTool({
    name: "overseerr_request_movie",
    description: "Request a movie to be added via Overseerr. Use overseerr_search first to get the tmdbId.",
    schema: z.object({
      tmdbId: z.number().describe("TMDB ID of the movie to request"),
    }),
    handler: async (args) => overseerr.requestMovie(args.tmdbId),
  });

  defineTool({
    name: "overseerr_request_tv",
    description: "Request a TV show to be added via Overseerr. Use overseerr_search first to get the tvdbId.",
    schema: z.object({
      tvdbId: z.number().describe("TVDB ID of the TV show to request"),
      seasons: z.array(z.number()).optional().describe("Specific season numbers to request (omit for all)"),
    }),
    handler: async (args) => overseerr.requestTv(args.tvdbId, args.seasons),
  });

  defineTool({
    name: "overseerr_list_requests",
    description: "List recent media requests from Overseerr.",
    schema: z.object({}),
    handler: async () => overseerr.listRequests(),
  });
}
