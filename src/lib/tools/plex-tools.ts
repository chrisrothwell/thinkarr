import { z } from "zod";
import { defineTool } from "./registry";
import * as plex from "@/lib/services/plex";

export function registerPlexTools() {
  defineTool({
    name: "plex_search_library",
    description: "Search the Plex media library for movies, TV shows, or other content by title or keyword.",
    schema: z.object({
      query: z.string().describe("Search query (title, keyword, or actor name)"),
    }),
    handler: async (args) => plex.searchLibrary(args.query),
  });

  defineTool({
    name: "plex_check_availability",
    description: "Check if a specific movie or TV show is available in the Plex library.",
    schema: z.object({
      title: z.string().describe("Title of the movie or TV show to check"),
    }),
    handler: async (args) => plex.checkAvailability(args.title),
  });

  defineTool({
    name: "plex_get_on_deck",
    description: "Get the list of shows/movies currently on deck (in progress) in Plex.",
    schema: z.object({}),
    handler: async () => plex.getOnDeck(),
  });

  defineTool({
    name: "plex_get_recently_added",
    description: "Get recently added content in the Plex library. Returns up to 10 items, deduplicated by show for TV series. Each result includes a 'type' field ('movie', 'show', 'season', or 'episode') to differentiate content types. TV seasons and episodes include 'showTitle' for the parent series name.",
    schema: z.object({}),
    handler: async () => plex.getRecentlyAdded(),
  });

  defineTool({
    name: "plex_search_collection",
    description: "Find titles belonging to a specific named Plex collection (e.g. 'Marvel Cinematic Universe', 'Christopher Nolan'). Returns the media items inside the matching collection.",
    schema: z.object({
      collectionName: z.string().describe("Name of the Plex collection to search for"),
    }),
    handler: async (args) => plex.searchCollections(args.collectionName),
  });

  defineTool({
    name: "plex_search_by_tag",
    description:
      "Discover titles in the Plex library filtered by a tag value within a specific tag category. " +
      "Use tagType to specify the category: 'genre' (e.g. 'Action', 'Horror', 'Comedy'), " +
      "'director' (e.g. 'Christopher Nolan'), 'actor' (e.g. 'Tom Hanks'), " +
      "'country' (e.g. 'Canada', 'United Kingdom'), 'studio' (e.g. 'A24'), " +
      "'contentRating' (e.g. 'R', 'PG-13'), or 'label' for custom labels. " +
      "Examples: movies from Canada → tagType='country', tag='Canada'; horror movies → tagType='genre', tag='Horror'.",
    schema: z.object({
      tag: z.string().describe("Tag value to filter by (e.g. 'Horror', 'Canada', 'Christopher Nolan')"),
      tagType: z
        .enum(["genre", "director", "actor", "country", "studio", "contentRating", "label", "mood"])
        .optional()
        .describe("Category of the tag. Defaults to 'genre'. Use 'country' for country queries, 'director' for director queries, etc."),
    }),
    handler: async (args) => plex.searchByTag(args.tag, args.tagType ?? "genre"),
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
  });
}
