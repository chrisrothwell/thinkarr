import { z } from "zod";
import { defineTool } from "./registry";
import * as sonarr from "@/lib/services/sonarr";
import type { SonarrSeries, SonarrSeriesStatus } from "@/lib/services/sonarr";

export function registerSonarrTools() {
  defineTool({
    name: "sonarr_search_series",
    description: "Search for a TV series by title. Returns results from Sonarr's lookup including monitored status, season count, and whether it's in the Sonarr library.",
    schema: z.object({
      term: z.string().describe("Search term (TV show title)"),
    }),
    handler: async (args) => sonarr.searchSeries(args.term),
    /** Strip overview from history — 200-char overview × 10 results is noise once the
     *  LLM has already acted on the search. Keep all identity and status fields. */
    llmSummary: (result: unknown) => {
      return (result as SonarrSeries[]).map(
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        ({ overview: _ov, ...rest }) => rest,
      );
    },
  });

  defineTool({
    name: "sonarr_get_series_status",
    description: "Get detailed download and availability status for a specific TV series managed by Sonarr. Returns per-season episode counts (total vs downloaded), monitored status, and next episode air date. Use this to answer questions like 'how many episodes do I have', 'is it complete', or 'when is the next episode'.",
    schema: z.object({
      title: z.string().describe("Title of the TV series to look up"),
    }),
    handler: async (args) => sonarr.getSeriesStatus(args.title),
    /** Compact history summary: keep top-level totals and nextAiring; compress the
     *  per-season array (which can be 10+ objects) to a single compact string like
     *  "S1:10/10 S2:5/8 S3:0/12" so subsequent turns don't carry the full breakdown. */
    llmSummary: (result: unknown) => {
      if (!result) return null;
      const r = result as SonarrSeriesStatus;
      return {
        title: r.title,
        year: r.year,
        networkStatus: r.networkStatus,
        monitored: r.monitored,
        totalEpisodes: r.totalEpisodes,
        downloadedEpisodes: r.downloadedEpisodes,
        missingEpisodes: r.missingEpisodes,
        nextAiring: r.nextAiring,
        seasons: r.seasons
          .map((s) => `S${s.seasonNumber}:${s.downloadedEpisodes}/${s.totalEpisodes}`)
          .join(" "),
      };
    },
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
