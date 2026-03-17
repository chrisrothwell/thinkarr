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
    name: "overseerr_list_requests",
    description: "List recent media requests from Overseerr. Returns request metadata (status, requester, date) along with poster URL and TMDB ID for each title. Use overseerr_search with the title for full availability details.",
    schema: z.object({}),
    handler: async () => overseerr.listRequests(),
  });
}
