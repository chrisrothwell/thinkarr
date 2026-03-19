import { z } from "zod";
import { defineTool } from "./registry";
import * as overseerr from "@/lib/services/overseerr";

export function registerOverseerrTools() {
  defineTool({
    name: "overseerr_search",
    description: "Search for movies or TV shows on Overseerr. Returns availability, request status, rating, summary (synopsis), cast, thumbPath (poster), overseerrId, and overseerrMediaType — all fields map directly to display_titles.",
    schema: z.object({
      query: z.string().describe("Search query (movie or TV show title)"),
    }),
    handler: async (args) => overseerr.search(args.query),
  });

  defineTool({
    name: "overseerr_list_requests",
    description: "List recent media requests from Overseerr. Returns request metadata including thumbPath (poster), overseerrId, overseerrMediaType (as mediaType), mediaStatus, and title — all fields map directly to display_titles. ALWAYS follow with display_titles to render title cards. Use overseerr_search with the title if you also need rating and cast.",
    schema: z.object({}),
    handler: async () => overseerr.listRequests(),
  });
}
