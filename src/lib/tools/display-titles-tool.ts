import { z } from "zod";
import { defineTool } from "./registry";
import { buildThumbUrl, getPlexMachineId, searchLibrary, findShowPlexKey } from "@/lib/services/plex";
import { getConfig } from "@/lib/config";
import type { DisplayTitle } from "@/types/titles";

const titleInputSchema = z.object({
  mediaType: z.enum(["movie", "tv", "episode"]).describe(
    "Media type: 'movie', 'tv' (whole show or a season card), or 'episode'",
  ),
  title: z.string().describe(
    "Display title. For season cards: 'Show Name — Season N'. For episode cards: episode title.",
  ),
  year: z.coerce.number().nullish().describe(
    "Release year (movie) or first air year (TV show)",
  ),
  summary: z.string().nullish().describe("Short plot summary or description"),
  rating: z.number().nullish().describe("Audience/critic rating (e.g. 7.5)"),
  thumbPath: z.string().nullish().describe(
    "Poster image. Pass Plex '/library/metadata/N/thumb/...' path, or full https://image.tmdb.org URL from Overseerr. Field is named 'thumbPath' — never 'posterUrl'.",
  ),
  plexKey: z.string().nullish().describe(
    "Plex metadata key (e.g. '/library/metadata/123') from a Plex search result — required for the Watch Now button.",
  ),
  overseerrId: z.number().nullish().describe(
    "Overseerr numeric ID — required for the Request button. Pass 'overseerrId' from Overseerr search/details results.",
  ),
  overseerrMediaType: z.enum(["movie", "tv"]).nullish().describe(
    "'movie' or 'tv' — required alongside overseerrId for the Request button.",
  ),
  imdbId: z.string().nullish().describe(
    "IMDb ID (e.g. 'tt1234567') — enables the More Info button.",
  ),
  mediaStatus: z.enum(["available", "partial", "pending", "not_requested"]).describe(
    "'available': in Plex library | 'partial': in Plex but not all seasons — do NOT show Request button | 'pending': requested in Overseerr but not yet downloaded | 'not_requested': not in Plex and not in Overseerr",
  ),
  cast: z.array(z.string()).nullish().describe("Top cast member names"),
  airDate: z.string().nullish().describe("Air date string — for episode cards"),
  showTitle: z.string().nullish().describe(
    "Parent show name — required for episode cards",
  ),
  seasonNumber: z.number().nullish().describe(
    "Season number (1-based) — required on every season card; omit for movies and episode cards",
  ),
  episodeNumber: z.number().nullish().describe(
    "Episode number within the season — required for episode cards",
  ),
});

export function registerDisplayTitlesTool() {
  defineTool({
    name: "display_titles",
    description: `Display rich title cards for movies, TV shows, or episodes in the chat UI. Call after searching Plex or Overseerr — even when titles are not in Plex. All search tools return field names that map directly to this schema — pass them through without renaming.

IMPORTANT: The exact function name is display_titles (snake_case, all lowercase). Always call it as display_titles({ titles: [...] }) — the argument must be an object with a "titles" array.

TV shows from overseerr_search or overseerr_discover: use the returned seasonCount and seasons fields to create one card per season (title = 'Show Name — Season N', seasonNumber set, mediaStatus from the seasons compact string). Never create a single card for an entire multi-season show — the Request button requires seasonNumber.

For overseerr_list_requests results: one card per request is correct (no season split needed).`,
    schema: z.object({
      titles: z.array(titleInputSchema).min(1).max(50),
    }),
    handler: async (args) => {
      const plexUrl = getConfig("plex.url");
      const baseUrl = plexUrl ? plexUrl.replace(/\/$/, "") : undefined;
      const machineId = baseUrl ? await getPlexMachineId() : undefined;

      // Issue #117: for available/partial titles from Overseerr (no plexKey), do a
      // side-query to Plex to find the matching item and populate plexKey so the
      // Watch Now button can be rendered.
      const plexKeyOverrides = new Map<number, string>();
      if (baseUrl) {
        const needsLookup = args.titles
          .map((t, i) => ({ t, i }))
          .filter(({ t }) =>
            (t.mediaStatus === "available" || t.mediaStatus === "partial") &&
            !t.plexKey &&
            t.title,
          );

        if (needsLookup.length > 0) {
          // Deduplicate Plex searches: multiple per-season entries for the same show
          // all resolve to the same search query. Group by (searchTitle, year) so we
          // fire one request per unique show rather than one per season card (#151).
          type LookupGroup = { indices: number[]; isTv: boolean; searchTitle: string; year?: number };
          const groups = new Map<string, LookupGroup>();

          for (const { t, i } of needsLookup) {
            const isTv = t.mediaType === "tv" || t.seasonNumber != null;
            let searchTitle: string;
            if (isTv) {
              const stripped = t.title.replace(/\s*[—–-]\s*Season\s+\d+\s*$/i, "").trim();
              searchTitle = t.showTitle ?? (stripped || t.title);
            } else {
              searchTitle = t.title;
            }
            const key = `${searchTitle}::${t.year ?? ""}::${isTv}`;
            const existing = groups.get(key);
            if (existing) {
              existing.indices.push(i);
            } else {
              groups.set(key, { indices: [i], isTv, searchTitle, year: t.year ?? undefined });
            }
          }

          await Promise.all(
            Array.from(groups.values()).map(async ({ indices, isTv, searchTitle, year }) => {
              try {
                let plexKey: string | undefined;
                if (isTv) {
                  plexKey = await findShowPlexKey(searchTitle, year);
                } else {
                  const { results } = await searchLibrary(searchTitle);
                  const titleLower = searchTitle.toLowerCase();
                  const match = results.find((r) => {
                    if (r.title.toLowerCase() !== titleLower) return false;
                    if (year && r.year) return r.year === year;
                    return true;
                  });
                  plexKey = match?.plexKey;
                }
                if (plexKey) {
                  for (const i of indices) plexKeyOverrides.set(i, plexKey);
                }
              } catch { /* non-fatal */ }
            }),
          );
        }
      }

      const displayTitles: DisplayTitle[] = args.titles.map((t, i) => ({
        mediaType: t.mediaType,
        title: t.title,
        year: t.year ?? undefined,
        summary: t.summary ?? undefined,
        rating: t.rating ?? undefined,
        thumbUrl: t.thumbPath
          ? (t.thumbPath.startsWith("http")
              // Proxy external TMDB/HTTP thumbnails through our server so they load
              // as same-origin resources (prevents ad-blocker / cross-origin blocking).
              ? `/api/tmdb/thumb?url=${encodeURIComponent(t.thumbPath)}`
              : buildThumbUrl(t.thumbPath))
          : undefined,
        plexKey: t.plexKey ?? plexKeyOverrides.get(i) ?? undefined,
        plexUrl: baseUrl,
        plexMachineId: machineId,
        overseerrId: t.overseerrId ?? undefined,
        overseerrMediaType: t.overseerrMediaType ?? undefined,
        imdbId: t.imdbId ?? undefined,
        mediaStatus: t.mediaStatus,
        cast: t.cast ?? undefined,
        airDate: t.airDate ?? undefined,
        showTitle: t.showTitle ?? undefined,
        seasonNumber: t.seasonNumber ?? undefined,
        episodeNumber: t.episodeNumber ?? undefined,
      }));

      return { displayTitles };
    },
    llmSummary: (result: unknown) => {
      const { displayTitles } = result as { displayTitles: { title: string; mediaType: string; seasonNumber?: number }[] };
      return {
        ok: true,
        count: displayTitles.length,
        titles: displayTitles.map((t) =>
          t.seasonNumber != null ? `${t.title} S${t.seasonNumber}` : t.title,
        ),
      };
    },
  });
}
