import { z } from "zod";
import { defineTool } from "./registry";
import * as sonarr from "@/lib/services/sonarr";
import * as plex from "@/lib/services/plex";
import * as overseerr from "@/lib/services/overseerr";
import type { SonarrSeries, SonarrSeriesStatus } from "@/lib/services/sonarr";

/**
 * Enrich a single Sonarr series result with poster, cast, and overseerrId by:
 * 1. Checking Plex first (gives plexKey, thumbPath, cast — best quality)
 * 2. Falling back to Overseerr search + getDetails (gives overseerrId, thumbPath, cast, imdbId)
 * Non-fatal: returns the unmodified series if both lookups fail.
 */
async function enrichSonarrSeries(s: SonarrSeries): Promise<SonarrSeries> {
  // --- Plex check ---
  try {
    const { results } = await plex.searchLibrary(s.title);
    const titleLower = s.title.toLowerCase();
    const match = results.find(
      (r) =>
        r.mediaType === "tv" &&
        r.title.toLowerCase() === titleLower &&
        (!s.year || !r.year || r.year === s.year),
    );
    if (match) {
      return {
        ...s,
        thumbPath: match.thumbPath ? plex.buildThumbUrl(match.thumbPath) : undefined,
        plexKey: match.plexKey,
        cast: match.cast,
      };
    }
  } catch { /* Plex not configured or unavailable */ }

  // --- Overseerr fallback ---
  try {
    const { results: ovrResults } = await overseerr.search(s.title, 1);
    const titleLower = s.title.toLowerCase();
    const match = ovrResults.find(
      (r) =>
        r.overseerrMediaType === "tv" &&
        r.title.toLowerCase() === titleLower &&
        (!s.year || !r.year || r.year === String(s.year)),
    );
    if (match) {
      // getDetails gives accurate cast and imdbId; thumbPath is already on the search result
      const detail = await overseerr.getDetails(match.overseerrId, "tv");
      return {
        ...s,
        thumbPath: match.thumbPath ?? detail.thumbPath,
        overseerrId: match.overseerrId,
        cast: detail.cast,
        imdbId: detail.imdbId,
      };
    }
  } catch { /* Overseerr not configured or unavailable */ }

  return s;
}

export function registerSonarrTools() {
  defineTool({
    name: "sonarr_search_series",
    description: "Search for a TV series by title. Returns results from Sonarr's lookup including monitored status, season count, and whether it's in the Sonarr library. Each result is automatically enriched with thumbPath (poster), plexKey (if available in Plex), overseerrId (if found in Overseerr), cast, and imdbId — pass these directly to display_titles. For mediaStatus: use 'available' if the show is in Plex (plexKey present), 'pending' if monitored in Sonarr but plexKey absent, or derive from the Overseerr mediaStatus field if present.",
    schema: z.object({
      term: z.string().describe("Search term (TV show title)"),
    }),
    handler: async (args) => {
      const results = await sonarr.searchSeries(args.term);
      return Promise.all(results.map(enrichSonarrSeries));
    },
    /** Strip overview from history — 200-char overview × 10 results is noise once the
     *  LLM has already acted on the search. Keep all identity, status, and enrichment fields. */
    llmSummary: (result: unknown) => {
      return (result as SonarrSeries[]).map(
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
