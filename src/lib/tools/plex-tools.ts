import { z } from "zod";
import { defineTool } from "./registry";
import * as plex from "@/lib/services/plex";

const pageParam = z.number().int().min(1).optional().describe("Page number (1-based). Omit or use 1 for the first page. Use hasMore from the previous response to know whether a next page exists.");

/** Compact history summary for a Plex result list — strips bulky fields (summary, thumbPath,
 *  secondary episode metadata) that are only needed in the current tool round when the LLM is
 *  constructing display_titles arguments. The full result is always used in-round; this summary
 *  is only loaded from DB for subsequent turns in the same conversation. */
function plexResultsLlmSummary(result: unknown): unknown {
  const r = result as { results: plex.PlexSearchResult[]; hasMore: boolean };
  return {
    results: r.results.map(({ title, year, mediaType, plexKey, rating, cast, showTitle, seasonNumber, episodeNumber }) => ({
      title, year, mediaType, plexKey, rating, cast, showTitle, seasonNumber, episodeNumber,
    })),
    hasMore: r.hasMore,
  };
}

export function registerPlexTools() {
  defineTool({
    name: "plex_search_library",
    description: "Search the Plex media library for movies, TV shows, or other content by title or keyword. Returns up to 50 results per page with a hasMore flag.",
    schema: z.object({
      query: z.string().describe("Search query (title, keyword, or actor name)"),
      page: pageParam,
    }),
    handler: async (args) => plex.searchLibrary(args.query, args.page ?? 1),
    llmSummary: plexResultsLlmSummary,
  });

  defineTool({
    name: "plex_check_availability",
    description: "Check if a specific movie or TV show is available in the Plex library.",
    schema: z.object({
      title: z.string().describe("Title of the movie or TV show to check"),
    }),
    handler: async (args) => plex.checkAvailability(args.title),
    llmSummary: (result: unknown) => {
      const r = result as { available: boolean; results: plex.PlexSearchResult[] };
      return {
        available: r.available,
        results: r.results.map(({ title, year, mediaType, plexKey, rating, cast, showTitle, seasonNumber, episodeNumber }) => ({
          title, year, mediaType, plexKey, rating, cast, showTitle, seasonNumber, episodeNumber,
        })),
      };
    },
  });

  defineTool({
    name: "plex_get_on_deck",
    description: "Get the list of shows/movies currently on deck (in progress) in Plex. Returns up to 50 results per page with a hasMore flag.",
    schema: z.object({
      page: pageParam,
    }),
    handler: async (args) => plex.getOnDeck(args.page ?? 1),
    llmSummary: plexResultsLlmSummary,
  });

  defineTool({
    name: "plex_get_recently_added",
    description: "Get recently added content in the Plex library. Returns up to 50 items per page, deduplicated by show for TV series. Each result includes a 'mediaType' field ('movie', 'tv', or 'episode'). TV seasons and episodes include 'showTitle' for the parent series name. Returns a hasMore flag for pagination.",
    schema: z.object({
      page: pageParam,
    }),
    handler: async (args) => plex.getRecentlyAdded(args.page ?? 1),
    llmSummary: plexResultsLlmSummary,
  });

  defineTool({
    name: "plex_search_collection",
    description: "Find titles belonging to a specific named Plex collection (e.g. 'Marvel Cinematic Universe', 'Christopher Nolan'). Returns the media items inside the matching collection. Returns up to 50 results per page with a hasMore flag.",
    schema: z.object({
      collectionName: z.string().describe("Name of the Plex collection to search for"),
      page: pageParam,
    }),
    handler: async (args) => plex.searchCollections(args.collectionName, args.page ?? 1),
    llmSummary: plexResultsLlmSummary,
  });

  defineTool({
    name: "plex_search_by_tag",
    description:
      "Discover titles in the Plex library filtered by a tag value within a specific tag category. " +
      "Use tagType to specify the category: 'genre' (e.g. 'Action', 'Horror', 'Comedy'), " +
      "'director' (e.g. 'Christopher Nolan'), 'actor' (e.g. 'Tom Hanks'), " +
      "'country' (e.g. 'Canada', 'United Kingdom'), 'studio' (e.g. 'A24'), " +
      "'contentRating' (e.g. 'R', 'PG-13'), or 'label' for custom labels. " +
      "Examples: movies from Canada → tagType='country', tag='Canada'; horror movies → tagType='genre', tag='Horror'. " +
      "Returns up to 50 results per page with a hasMore flag.",
    schema: z.object({
      tag: z.string().describe("Tag value to filter by (e.g. 'Horror', 'Canada', 'Christopher Nolan')"),
      tagType: z
        .enum(["genre", "director", "actor", "country", "studio", "contentRating", "label", "mood"])
        .optional()
        .describe("Category of the tag. Defaults to 'genre'. Use 'country' for country queries, 'director' for director queries, etc."),
      page: pageParam,
    }),
    handler: async (args) => plex.searchByTag(args.tag, args.tagType ?? "genre", args.page ?? 1),
    llmSummary: plexResultsLlmSummary,
  });

  defineTool({
    name: "plex_get_title_tags",
    description:
      "Retrieve all tags associated with a specific Plex title (genres, directors, actors, countries, studio, content rating, labels). " +
      "Use this when the user asks what tags, genres, or categories a specific title belongs to. " +
      "Pass the Plex metadata key from a previous search result (e.g. '/library/metadata/123').",
    schema: z.object({
      metadataKey: z
        .string()
        .describe("Plex metadata key for the title (e.g. '/library/metadata/123' from a search result's 'key' field)"),
    }),
    handler: async (args) => plex.getTagsForTitle(args.metadataKey),
    /** Compact history summary: limit directors to 3 and actors to 5 to avoid
     *  large uncapped arrays bloating subsequent turns. */
    llmSummary: (result: unknown) => {
      const r = result as plex.PlexTitleTags;
      return {
        key: r.key,
        title: r.title,
        genres: r.genres,
        directors: r.directors.slice(0, 3),
        actors: r.actors.slice(0, 5),
        countries: r.countries,
        studio: r.studio,
        contentRating: r.contentRating,
        labels: r.labels,
      };
    },
  });
}
