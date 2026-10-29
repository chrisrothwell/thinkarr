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
 *
 * plex.tv's /api/v2/resources can return a server resource with zero
 * connections even when the server itself is up and reachable on the LAN —
 * confirmed against beta logs (#457) where direct plexFetch calls to the same
 * server succeeded throughout. The most common cause is the server not
 * publishing itself to plex.tv (Plex Media Server → Settings → Remote Access),
 * which many LAN-only setups turn off deliberately — in that case plex.tv has
 * no address to hand back, and no amount of client-side logic can recover a
 * URL from an empty array. Surfaced as a clear error with the manual-entry
 * fallback rather than silently producing a blank/wrong URL.
 */
export function selectPlexConnectionUrl(device: PlexDeviceLike): PlexDeviceSelection {
  if (device.connections.length === 0) {
    return {
      ok: false,
      error: `"${device.name}" has no reachable connection according to plex.tv. This usually means the server isn't publishing itself on plex.tv (common for LAN-only setups) — enter its local URL in the field below manually instead.`,
    };
  }

  const best =
    device.connections.find((c) => c.local && c.protocol === "http") ||
    device.connections.find((c) => c.local) ||
    device.connections[0];

  return { ok: true, url: `${best.protocol}://${best.address}:${best.port}` };
}
