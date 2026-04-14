import { z } from "zod";
import { defineTool } from "./registry";
import * as radarr from "@/lib/services/radarr";
import * as plex from "@/lib/services/plex";
import * as overseerr from "@/lib/services/overseerr";
import type { RadarrMovie } from "@/lib/services/radarr";

/**
 * Enrich a single Radarr movie result with poster, cast, and overseerrId by:
 * 1. Checking Plex first (gives plexKey, thumbPath, cast — best quality)
 * 2. Falling back to Overseerr:
 *    - If tmdbId is available, call getDetails directly (more reliable than title search)
 *    - Otherwise, search by title and use the first movie match
 * Non-fatal: returns the unmodified movie if both lookups fail.
 */
async function enrichRadarrMovie(m: RadarrMovie): Promise<RadarrMovie> {
  // --- Plex check ---
  try {
    const { results } = await plex.searchLibrary(m.title);
    const titleLower = m.title.toLowerCase();
    const match = results.find(
      (r) =>
        r.mediaType === "movie" &&
        r.title.toLowerCase() === titleLower &&
        (!m.year || !r.year || r.year === m.year),
    );
    if (match) {
      return {
        ...m,
        thumbPath: match.thumbPath ? plex.buildThumbUrl(match.thumbPath) : undefined,
        plexKey: match.plexKey,
        cast: match.cast,
      };
    }
  } catch { /* Plex not configured or unavailable */ }

  // --- Overseerr fallback ---
  try {
    if (m.tmdbId) {
      // Direct lookup using tmdbId — more reliable than a title search
      const detail = await overseerr.getDetails(m.tmdbId, "movie");
      return {
        ...m,
        thumbPath: detail.thumbPath,
        overseerrId: m.tmdbId,
        cast: detail.cast,
        imdbId: detail.imdbId,
        mediaStatus: overseerr.normalizeMediaStatus(detail.mediaStatus ?? "Not Requested"),
      };
    }

    // No tmdbId — fall back to a title search
    const { results: ovrResults } = await overseerr.search(m.title, 1);
    const titleLower = m.title.toLowerCase();
    const match = ovrResults.find(
      (r) =>
        r.overseerrMediaType === "movie" &&
        r.title.toLowerCase() === titleLower &&
        (!m.year || !r.year || r.year === m.year),
    );
    if (match) {
      const detail = await overseerr.getDetails(match.overseerrId, "movie");
      return {
        ...m,
        thumbPath: match.thumbPath ?? detail.thumbPath,
        overseerrId: match.overseerrId,
        cast: detail.cast,
        imdbId: detail.imdbId,
        mediaStatus: overseerr.normalizeMediaStatus(match.mediaStatus),
      };
    }
  } catch { /* Overseerr not configured or unavailable */ }

  // In Radarr library but not found in Plex or Overseerr — being actively managed.
  // Use "partial" to suppress the request button; "pending" is reserved for Overseerr requests.
  return { ...m, mediaStatus: m.monitored ? "partial" : "not_requested" };
}

export function registerRadarrTools() {
  defineTool({
    name: "radarr_search_movie",
    description: "Search for movies by title. Returns results from the Radarr library only (never external lookups). Each result is automatically enriched with thumbPath (poster), plexKey (if available in Plex), overseerrId, cast, imdbId, and a pre-computed mediaStatus — pass these directly to display_titles without manual status inference.",
    schema: z.object({
      term: z.string().describe("Search term (movie title)"),
    }),
    handler: async (args) => {
      const results = await radarr.searchMovie(args.term);
      return Promise.all(results.map(enrichRadarrMovie));
    },
    /** Strip overview from history — 200-char overview × 10 results is noise once the
     *  LLM has already acted on the search. Keep all identity, status, and enrichment fields. */
    llmSummary: (result: unknown) => {
      return (result as RadarrMovie[]).map(
        ({ overview: _ov, ...rest }) => rest,
      );
    },
  });

  defineTool({
    name: "radarr_get_movie_status",
    description: "Get detailed download and availability status for a specific movie managed by Radarr. Returns whether it's downloaded, currently downloading (with progress % and time left), and monitored status. Use this to answer questions like 'is X downloaded', 'is X downloading', or 'when will X finish downloading'.",
    schema: z.object({
      title: z.string().describe("Title of the movie to look up"),
    }),
    handler: async (args) => radarr.getMovieStatus(args.title),
  });

  defineTool({
    name: "radarr_get_queue",
    description: "Get the current Radarr download queue showing movies actively downloading with progress percentage and estimated time remaining.",
    schema: z.object({}),
    handler: async () => radarr.getQueue(),
  });
}
