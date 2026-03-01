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
  const res = await fetch("https://plex.tv/api/v2/pins", {
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
  const res = await fetch(`https://plex.tv/api/v2/pins/${pinId}`, {
    headers: PLEX_HEADERS,
  });

  if (!res.ok) {
    throw new Error(`Plex PIN check failed: HTTP ${res.status}`);
  }

  const data = await res.json();
  return data.authToken || null;
}

/**
 * Check if a user (identified by their personal Plex token) has access to at
 * least one library section on the configured Plex server. Returns false when
 * Plex is unreachable so callers can decide whether to block or allow.
 */
export async function checkUserHasLibraryAccess(
  serverUrl: string,
  userToken: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${serverUrl.replace(/\/$/, "")}/library/sections`, {
      headers: {
        "X-Plex-Token": userToken,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch {
    // Network error — fail closed (deny) so the check cannot be bypassed by
    // making the Plex server temporarily unreachable.
    return false;
  }
}

/** Fetch user info from a Plex auth token. */
export async function getPlexUser(authToken: string): Promise<PlexUser> {
  const res = await fetch("https://plex.tv/api/v2/user", {
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
