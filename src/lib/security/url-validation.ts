/**
 * SSRF protection utilities for validating user-supplied service URLs.
 *
 * This app is a home-server product designed to talk to local LAN services
 * (Plex, Sonarr, Radarr, Overseerr, Ollama, etc.), so blocking all RFC 1918
 * addresses would break legitimate use cases. Instead we block:
 *
 *   - Non-http(s) schemes (file://, ftp://, data://, etc.)
 *   - Link-local addresses (169.254.x.x / fe80::) used by cloud instance
 *     metadata services (AWS IMDSv1, GCP, Azure) — the primary SSRF risk
 *     for self-hosted apps deployed on VPS/cloud.
 *
 * All URL changes to service settings are also audit-logged by callers.
 */

/** CIDRs / patterns that must never be reachable via user-supplied URLs. */
const BLOCKED_HOST_PATTERNS: RegExp[] = [
  /^169\.254\.\d+\.\d+$/, // IPv4 link-local — cloud instance metadata (AWS, GCP, Azure, DigitalOcean)
  /^fe80:/i,              // IPv6 link-local
  /^0\.0\.0\.0$/,         // Unspecified address
];

export interface UrlValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate a user-supplied service URL for SSRF risks.
 * Returns { valid: true } if the URL is safe to use, or { valid: false, error } otherwise.
 */
export function validateServiceUrl(rawUrl: string): UrlValidationResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { valid: false, error: "Invalid URL format" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { valid: false, error: "URL must use http or https protocol" };
  }

  // Node's URL parser returns IPv6 addresses with surrounding brackets e.g. [fe80::1]
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  for (const pattern of BLOCKED_HOST_PATTERNS) {
    if (pattern.test(hostname)) {
      return { valid: false, error: "URL hostname is not permitted" };
    }
  }

  return { valid: true };
}
