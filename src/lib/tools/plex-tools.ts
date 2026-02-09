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
    description: "Get recently added content in the Plex library.",
    schema: z.object({}),
    handler: async () => plex.getRecentlyAdded(),
  });
}
