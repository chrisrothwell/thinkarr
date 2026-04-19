import { logger } from "@/lib/logger";
import { validateServiceUrl } from "@/lib/security/url-validation";

// Allow overriding the Plex API base for E2E testing
const PLEX_API_BASE = process.env.PLEX_API_BASE ?? "https://plex.tv";

const PLEX_HEADERS = {
  Accept: "application/json",
  "X-Plex-Product": "Thinkarr",
  "X-Plex-Version": "0.1.0",
  "X-Plex-Client-Identifier": "thinkarr",
};

export interface PlexPin {
  id: number;
  code: string;
  authUrl: string;
}

export interface PlexUser {
  id: string;
  username: string;
  email: string;
  thumb: string;
  authToken: string;
}

/** Request a new Plex PIN for the OAuth flow. */
export async function createPlexPin(): Promise<PlexPin> {
  const res = await fetch(`${PLEX_API_BASE}/api/v2/pins`, {
    method: "POST",
    headers: {
      ...PLEX_HEADERS,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "strong=true",
  });

  if (!res.ok) {
    throw new Error(`Plex PIN request failed: HTTP ${res.status}`);
  }

  const data = await res.json();
  const authUrl =
    `https://app.plex.tv/auth#?clientID=thinkarr&code=${data.code}&context%5Bdevice%5D%5Bproduct%5D=Thinkarr`;

  return {
    id: data.id,
    code: data.code,
    authUrl,
  };
}

/** Check if a Plex PIN has been claimed. Returns the auth token if claimed, null otherwise. */
export async function checkPlexPin(pinId: number): Promise<string | null> {
  const res = await fetch(`${PLEX_API_BASE}/api/v2/pins/${pinId}`, {
    headers: PLEX_HEADERS,
  });

  if (!res.ok) {
    throw new Error(`Plex PIN check failed: HTTP ${res.status}`);
  }

  const data = await res.json();
  return data.authToken || null;
}

/**
 * Check if a user (identified by their Plex ID) has access to the configured
 * Plex server by querying /accounts with the admin token. This is more reliable
 * than using the user's personal token, which the server may not accept directly.
 * Returns false when Plex is unreachable so the check fails closed.
 */
export async function checkUserHasLibraryAccess(
  serverUrl: string,
  adminToken: string,
  plexId: string,
): Promise<boolean> {
  const check = validateServiceUrl(serverUrl);
  if (!check.valid) {
    logger.warn("Plex library access check — invalid URL rejected", { serverUrl, error: check.error });
    return false;
  }
  const url = `${serverUrl.replace(/\/$/, "")}/accounts`;
  logger.info("Plex library access check", { url, plexId });
  try {
    const res = await fetch(url, {
      headers: {
        "X-Plex-Token": adminToken,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "(unreadable)");
      logger.warn("Plex library access check — HTTP error", {
        url,
        status: res.status,
        statusText: res.statusText,
        body: body.slice(0, 500),
        plexId,
      });
      return false;
    }

    const data = await res.json() as { MediaContainer?: { Account?: Array<{ id: number }> } };
    const accounts = data?.MediaContainer?.Account ?? [];
    const hasAccess = accounts.some((a) => String(a.id) === String(plexId));
    logger.info("Plex library access check — result", {
      url,
      plexId,
      accountCount: accounts.length,
      hasAccess,
    });
    return hasAccess;
  } catch (err) {
    // Network error — fail closed (deny) so the check cannot be bypassed by
    // making the Plex server temporarily unreachable.
    logger.error("Plex library access check — network error", {
      url,
      plexId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export interface PlexResourceConnection {
  protocol: string;
  address: string;
  port: number;
  uri: string;
  local: boolean;
}

export interface PlexResource {
  name: string;
  clientIdentifier: string;
  accessToken: string;
  owned: boolean;
  connections: PlexResourceConnection[];
}

/** Fetch the list of Plex server resources accessible to the authenticated user. */
export async function getPlexDevices(authToken: string): Promise<PlexResource[]> {
  const res = await fetch(
    `${PLEX_API_BASE}/api/v2/resources?includeHttps=1&includeRelay=1`,
    {
      headers: {
        ...PLEX_HEADERS,
        "X-Plex-Token": authToken,
      },
      signal: AbortSignal.timeout(10000),
    },
  );

  if (!res.ok) {
    throw new Error(`Plex.tv returned HTTP ${res.status}`);
  }

  const raw = await res.json() as Record<string, unknown>[];
  return raw
    .filter((d) => (d.provides as string | undefined)?.split(",").includes("server"))
    .map((d) => ({
      name: d.name as string,
      clientIdentifier: d.clientIdentifier as string,
      accessToken: d.accessToken as string,
      owned: d.owned as boolean,
      connections: ((d.connection as Record<string, unknown>[]) || []).map((c) => ({
        protocol: c.protocol as string,
        address: c.address as string,
        port: c.port as number,
        uri: c.uri as string,
        local: c.local as boolean,
      })),
    }));
}

/** Fetch user info from a Plex auth token. */
export async function getPlexUser(authToken: string): Promise<PlexUser> {
  const res = await fetch(`${PLEX_API_BASE}/api/v2/user`, {
    headers: {
      ...PLEX_HEADERS,
      "X-Plex-Token": authToken,
    },
  });

  if (!res.ok) {
    throw new Error(`Plex user fetch failed: HTTP ${res.status}`);
  }

  const data = await res.json();
  return {
    id: String(data.id),
    username: data.username || data.title || "Unknown",
    email: data.email || "",
    thumb: data.thumb || "",
    authToken,
  };
}
