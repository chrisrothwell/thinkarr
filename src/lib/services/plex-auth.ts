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
