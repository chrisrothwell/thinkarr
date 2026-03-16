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
    description: "Discover titles in the Plex library filtered by a tag such as genre, mood, or custom user-defined tag (e.g. 'Action', 'Comedy', 'Family'). Searches across all movie and TV show sections.",
    schema: z.object({
      tag: z.string().describe("Tag value to filter by (genre, mood, or custom tag)"),
    }),
    handler: async (args) => plex.searchByTag(args.tag),
  });
}
