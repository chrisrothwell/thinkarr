import { z } from "zod";
import { defineTool } from "./registry";
import * as sonarr from "@/lib/services/sonarr";

export function registerSonarrTools() {
  defineTool({
    name: "sonarr_search_series",
    description: "Search for a TV series by title. Returns results from Sonarr's lookup including monitored status, season count, and whether it's in the Sonarr library.",
    schema: z.object({
      term: z.string().describe("Search term (TV show title)"),
    }),
    handler: async (args) => sonarr.searchSeries(args.term),
  });

  defineTool({
    name: "sonarr_get_series_status",
    description: "Get detailed download and availability status for a specific TV series managed by Sonarr. Returns per-season episode counts (total vs downloaded), monitored status, and next episode air date. Use this to answer questions like 'how many episodes do I have', 'is it complete', or 'when is the next episode'.",
    schema: z.object({
      title: z.string().describe("Title of the TV series to look up"),
    }),
    handler: async (args) => sonarr.getSeriesStatus(args.title),
  });

  defineTool({
    name: "sonarr_get_calendar",
    description: "Get upcoming TV episode air dates from Sonarr. Useful for answering 'when is the next episode of X airing'.",
    schema: z.object({
      days: z.number().optional().default(7).describe("Number of days to look ahead (default 7)"),
    }),
    handler: async (args) => sonarr.getCalendar(args.days),
  });

  defineTool({
    name: "sonarr_get_queue",
    description: "Get the current Sonarr download queue showing episodes actively downloading with progress percentage and estimated time remaining.",
    schema: z.object({}),
    handler: async () => sonarr.getQueue(),
  });
}
