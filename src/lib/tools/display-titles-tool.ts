import { z } from "zod";
import { defineTool } from "./registry";
import { buildThumbUrl, getPlexMachineId, searchLibrary } from "@/lib/services/plex";
import { getConfig } from "@/lib/config";
import type { DisplayTitle } from "@/types/titles";

const titleInputSchema = z.object({
  mediaType: z.enum(["movie", "tv", "episode"]),
  title: z.string(),
  year: z.number().nullish(),
  summary: z.string().nullish(),
  rating: z.number().nullish(),
  thumbPath: z.string().nullish(),
  plexKey: z.string().nullish(),
  overseerrId: z.number().nullish(),
  overseerrMediaType: z.enum(["movie", "tv"]).nullish(),
  imdbId: z.string().nullish(),
  mediaStatus: z.enum(["available", "partial", "pending", "not_requested"]),
  cast: z.array(z.string()).nullish(),
  airDate: z.string().nullish(),
  showTitle: z.string().nullish(),
  seasonNumber: z.number().nullish(),
  episodeNumber: z.number().nullish(),
});

export function registerDisplayTitlesTool() {
  defineTool({
    name: "display_titles",
    description: `Display rich title cards for movies, TV shows, or episodes in the chat UI.
Call this tool after searching Plex or Overseerr — even when titles are not in Plex.

All Plex and Overseerr tools now return field names that map directly to this tool's input — no translation needed:
- plexKey ← Plex result "plexKey" field
- thumbPath ← Plex result "thumbPath" OR Overseerr result "thumbPath"
- overseerrId ← Overseerr result "overseerrId"
- overseerrMediaType ← Overseerr result "overseerrMediaType"
- summary ← Plex result "summary" OR Overseerr result "summary"
- rating ← Plex result "rating" OR Overseerr result "rating"
- cast ← Plex result "cast" OR Overseerr result "cast"

mediaStatus mapping:
- "available": title exists in the Plex library
- "partial": TV show exists in Plex but not all seasons
- "pending": requested in Overseerr but not yet downloaded
- "not_requested": not in Plex and not in Overseerr

IMPORTANT — multi-season TV shows:
If an Overseerr TV result has seasonCount > 1, you MUST call this tool with one entry per season (S1 through S{seasonCount}), not one entry for the whole show. Set seasonNumber on each entry. Do NOT create a single card for a multi-season show — it will cause the request to fail.`,
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
          await Promise.all(
            needsLookup.map(async ({ t, i }) => {
              try {
                const { results } = await searchLibrary(t.title);
                const titleLower = t.title.toLowerCase();
                const match = results.find((r) => {
                  if (r.title.toLowerCase() !== titleLower) return false;
                  if (t.year && r.year) return r.year === t.year;
                  return true;
                });
                if (match) plexKeyOverrides.set(i, match.plexKey);
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
  });
}
