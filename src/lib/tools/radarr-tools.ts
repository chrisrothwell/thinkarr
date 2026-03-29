import { z } from "zod";
import { defineTool } from "./registry";
import * as radarr from "@/lib/services/radarr";
import type { RadarrMovie } from "@/lib/services/radarr";

export function registerRadarrTools() {
  defineTool({
    name: "radarr_search_movie",
    description: "Search for movies by title. Returns results from Radarr's lookup including whether the movie is in the library, downloaded, and monitored.",
    schema: z.object({
      term: z.string().describe("Search term (movie title)"),
    }),
    handler: async (args) => radarr.searchMovie(args.term),
    /** Strip overview from history — 200-char overview × 10 results is noise once the
     *  LLM has already acted on the search. Keep all identity and status fields. */
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
