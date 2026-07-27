import { logger } from "@/lib/logger";
import { validateServiceUrl } from "@/lib/security/url-validation";
import { getConfig, setConfig } from "@/lib/config";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";

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

/**
 * Re-derive the configured Plex server's per-server access token by re-running
 * device discovery — the same request the Settings UI makes when an admin
 * clicks "Discover Servers". Per-server access tokens (`plex.token`) can go
 * stale independently of a user's plex.tv account token (`users.plexToken`),
 * which is long-lived and doesn't require re-authenticating in a browser. This
 * reproduces that "just click Discover again" fix automatically instead of
 * requiring the admin to do it by hand (#457).
 *
 * Matches the resource by `plex.clientIdentifier` (stable identity for the
 * server), not URL, so this still works if the server's LAN address changed.
 * Tries every admin's account token in case the one who originally connected
 * Plex is no longer an admin or their account token itself is stale.
 *
 * Returns the fresh token on success, or null if there's nothing on record to
 * match against, or no admin's account currently has access to that server.
 */
export async function refreshPlexToken(): Promise<string | null> {
  const clientIdentifier = getConfig("plex.clientIdentifier");
  if (!clientIdentifier) return null;

  const db = getDb();
  const admins = db
    .select({ id: schema.users.id, plexToken: schema.users.plexToken })
    .from(schema.users)
    .where(eq(schema.users.isAdmin, true))
    .all();

  for (const admin of admins) {
    if (!admin.plexToken) continue;
    try {
      const resources = await getPlexDevices(admin.plexToken);
      const match = resources.find((r) => r.clientIdentifier === clientIdentifier);
      if (match?.accessToken) {
        setConfig("plex.token", match.accessToken, true);
        logger.info("Plex token refreshed via re-discovery", { adminUserId: admin.id, clientIdentifier });
        return match.accessToken;
      }
    } catch (err) {
      logger.warn("Plex token refresh — discovery failed for admin", {
        adminUserId: admin.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return null;
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
