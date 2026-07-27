export interface PlexDeviceConnection {
  protocol: string;
  address: string;
  port: number;
  local: boolean;
}

export interface PlexDeviceLike {
  name: string;
  connections: PlexDeviceConnection[];
}

export type PlexDeviceSelection = { ok: true; url: string } | { ok: false; error: string };

/**
 * Pick the best connection URL for a Plex server discovered via plex.tv.
 * A server resource can be returned with zero connections (offline, or plex.tv
 * hasn't seen a recent heartbeat) — that's reported as an error rather than
 * silently producing an empty URL (#457).
 */
export function selectPlexConnectionUrl(device: PlexDeviceLike): PlexDeviceSelection {
  if (device.connections.length === 0) {
    return {
      ok: false,
      error: `"${device.name}" has no reachable connection right now (it may be offline). Choose a different server, or check it's running and try Discover again.`,
    };
  }

  const best =
    device.connections.find((c) => c.local && c.protocol === "http") ||
    device.connections.find((c) => c.local) ||
    device.connections[0];

  return { ok: true, url: `${best.protocol}://${best.address}:${best.port}` };
}
