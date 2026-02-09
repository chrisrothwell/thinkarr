import { getConfig } from "@/lib/config";
import { registerPlexTools } from "./plex-tools";
import { registerSonarrTools } from "./sonarr-tools";
import { registerRadarrTools } from "./radarr-tools";
import { registerOverseerrTools } from "./overseerr-tools";

let initialized = false;

/** Register all tools based on configured services. Call once at startup. */
export function initializeTools() {
  if (initialized) return;
  initialized = true;

  // Always register Plex tools (required service)
  if (getConfig("plex.url")) {
    registerPlexTools();
  }

  if (getConfig("sonarr.url")) {
    registerSonarrTools();
  }

  if (getConfig("radarr.url")) {
    registerRadarrTools();
  }

  if (getConfig("overseerr.url")) {
    registerOverseerrTools();
  }
}
