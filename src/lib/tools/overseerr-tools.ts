import { z } from "zod";
import { defineTool } from "./registry";
import * as overseerr from "@/lib/services/overseerr";

const pageParam = z.number().int().min(1).optional().describe("Page number (1-based). Omit or use 1 for the first page. Use hasMore from the previous response to know whether a next page exists.");

export function registerOverseerrTools() {
  defineTool({
    name: "overseerr_search",
    description: "Search for movies or TV shows on Overseerr. Returns availability, request status, rating, summary (synopsis), cast, thumbPath (poster), overseerrId, and overseerrMediaType — all fields map directly to display_titles. Returns up to 50 results per page with a hasMore flag.",
    schema: z.object({
      query: z.string().describe("Search query (movie or TV show title)"),
      page: pageParam,
    }),
    handler: async (args) => overseerr.search(args.query, args.page ?? 1),
  });

  defineTool({
    name: "overseerr_list_requests",
    description: "List recent media requests from Overseerr. Returns request metadata including thumbPath (poster), overseerrId, overseerrMediaType (as mediaType), mediaStatus, and title — all fields map directly to display_titles. ALWAYS follow with display_titles to render title cards. Use overseerr_search with the title if you also need rating and cast. Returns up to 50 results per page with a hasMore flag.",
    schema: z.object({
      page: pageParam,
    }),
    handler: async (args) => overseerr.listRequests(args.page ?? 1),
  });
}
