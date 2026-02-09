import { z } from "zod";
import { defineTool } from "./registry";
import * as sonarr from "@/lib/services/sonarr";

export function registerSonarrTools() {
  defineTool({
    name: "sonarr_search_series",
    description: "Search for TV series by title. Returns results from Sonarr's lookup (includes both monitored and unmonitored series).",
    schema: z.object({
      term: z.string().describe("Search term (TV show title)"),
    }),
    handler: async (args) => sonarr.searchSeries(args.term),
  });

  defineTool({
    name: "sonarr_list_series",
    description: "List all TV series currently managed by Sonarr.",
    schema: z.object({}),
    handler: async () => sonarr.listSeries(),
  });

  defineTool({
    name: "sonarr_get_calendar",
    description: "Get upcoming TV episode air dates from Sonarr.",
    schema: z.object({
      days: z.number().optional().default(7).describe("Number of days to look ahead (default 7)"),
    }),
    handler: async (args) => sonarr.getCalendar(args.days),
  });

  defineTool({
    name: "sonarr_get_queue",
    description: "Get the current Sonarr download queue showing episodes being downloaded.",
    schema: z.object({}),
    handler: async () => sonarr.getQueue(),
  });
}
