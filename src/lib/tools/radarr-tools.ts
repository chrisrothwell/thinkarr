import { z } from "zod";
import { defineTool } from "./registry";
import * as radarr from "@/lib/services/radarr";

export function registerRadarrTools() {
  defineTool({
    name: "radarr_search_movie",
    description: "Search for movies by title. Returns results from Radarr's lookup.",
    schema: z.object({
      term: z.string().describe("Search term (movie title)"),
    }),
    handler: async (args) => radarr.searchMovie(args.term),
  });

  defineTool({
    name: "radarr_list_movies",
    description: "List all movies currently managed by Radarr.",
    schema: z.object({}),
    handler: async () => radarr.listMovies(),
  });

  defineTool({
    name: "radarr_get_queue",
    description: "Get the current Radarr download queue showing movies being downloaded.",
    schema: z.object({}),
    handler: async () => radarr.getQueue(),
  });
}
