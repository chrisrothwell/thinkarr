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
/** Derive per-season mediaStatus from Sonarr's own episode counts — no extra API call needed.
 *  episodeCount > 0 means Sonarr has downloaded episodes → "available".
 *  episodeCount === 0 + monitored → Sonarr is tracking it, will download when it airs → "pending"
 *    (suppresses Request button; does NOT imply any content is present, unlike "partial").
 *  episodeCount === 0 + not monitored → "not_requested". */
function sonarrPerSeasonStatus(
  sonarrSeasons: SonarrSeries["sonarrSeasons"],
): Array<{ seasonNumber: number; mediaStatus: string }> | undefined {
  if (!sonarrSeasons || sonarrSeasons.length < 2) return undefined;
  return sonarrSeasons.map(({ seasonNumber, episodeCount, monitored }) => ({
    seasonNumber,
    mediaStatus: episodeCount > 0 ? "available" : monitored ? "pending" : "not_requested",
  }));
}

async function enrichSonarrSeries(s: SonarrSeries): Promise<SonarrSeries> {
  // Strip internal sonarrSeasons — it's consumed here; the LLM sees the derived `seasons` field instead.
  const { sonarrSeasons, ...rest } = s;

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
      // If Plex has fewer seasons than Sonarr expects, the show is only partially available.
      // match.seasons is Plex childCount; s.seasonCount is derived from Sonarr (season 0 excluded).
      const isPartial = match.seasons != null && s.seasonCount != null && match.seasons < s.seasonCount;
      return {
        ...rest,
        thumbPath: match.thumbPath ? plex.buildThumbUrl(match.thumbPath) : undefined,
        plexKey: match.plexKey,
        cast: match.cast,
        mediaStatus: isPartial ? "partial" : "available",
        // When partial, include per-season status from Sonarr episode counts so the LLM
        // can assign the correct status to each season card without a Plex lookup.
        seasons: isPartial ? sonarrPerSeasonStatus(sonarrSeasons) : undefined,
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
        (!s.year || !r.year || r.year === s.year),
    );
    if (match) {
      // getDetails gives accurate cast and imdbId; thumbPath is already on the search result
      const detail = await overseerr.getDetails(match.overseerrId, "tv");
      return {
        ...rest,
        thumbPath: match.thumbPath ?? detail.thumbPath,
        overseerrId: match.overseerrId,
        cast: detail.cast,
        imdbId: detail.imdbId,
        // Normalize so the LLM sees display_titles-compatible values (issue #280)
        mediaStatus: overseerr.normalizeMediaStatus(match.mediaStatus),
      };
    }
  } catch { /* Overseerr not configured or unavailable */ }

  // In Sonarr library but not yet in Plex — it is being actively managed.
  // Use "partial" to suppress the request button; "pending" is reserved for Overseerr requests.
  return { ...rest, mediaStatus: s.monitored ? "partial" : "not_requested" };
}

export function registerSonarrTools() {
  defineTool({
    name: "sonarr_search_series",
    description: "Search for a TV series by title. Returns results from Sonarr's library with enriched metadata: thumbPath (poster), plexKey (if in Plex), overseerrId (if in Overseerr), cast, imdbId, and pre-computed mediaStatus. When creating per-season cards with display_titles: if seasons is set (only present when mediaStatus is 'partial'), use seasons[].mediaStatus for each individual season card. Otherwise use the series-level mediaStatus for all season cards.",
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
        ({ overview: _ov, sonarrSeasons: _raw, ...rest }) => rest,
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
