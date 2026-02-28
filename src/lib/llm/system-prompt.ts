import { getConfig } from "@/lib/config";
import { DEFAULT_SYSTEM_PROMPT } from "./default-prompt";
export { DEFAULT_SYSTEM_PROMPT };

/** Build the live {{serviceList}} block based on currently-configured services. */
function buildServiceList(): string {
  const services: string[] = [];

  if (getConfig("plex.url")) services.push("Plex (library search, watch history, on deck)");
  if (getConfig("sonarr.url")) services.push("Sonarr (TV show management, calendar, queue)");
  if (getConfig("radarr.url")) services.push("Radarr (movie management, queue)");
  if (getConfig("overseerr.url")) services.push("Overseerr (media requests)");

  return services.length > 0
    ? `You have access to the following services:\n${services.map((s) => `- ${s}`).join("\n")}`
    : "No media services are currently configured.";
}

/**
 * Build the system prompt to send to the LLM.
 * @param customPrompt - Optional per-endpoint prompt stored in settings.
 *   If provided, {{serviceList}} is substituted. Falls back to DEFAULT_SYSTEM_PROMPT.
 */
export function buildSystemPrompt(customPrompt?: string): string {
  const template = customPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;
  return template.replace("{{serviceList}}", buildServiceList());
}
