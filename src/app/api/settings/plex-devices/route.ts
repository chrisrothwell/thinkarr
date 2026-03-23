import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { logger } from "@/lib/logger";
import type { ApiResponse } from "@/types/api";

export interface PlexConnection {
  protocol: string;
  address: string;
  port: number;
  uri: string;
  local: boolean;
}

export interface PlexDevice {
  name: string;
  clientIdentifier: string;
  accessToken: string;
  owned: boolean;
  connections: PlexConnection[];
}

export async function GET(): Promise<NextResponse> {
  const session = await getSession();
  if (!session || !session.user.isAdmin) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Admin access required" },
      { status: 403 },
    );
  }

  // Fetch the full user row to get the stored plexToken
  const db = getDb();
  let user: { plexToken: string | null } | undefined;
  try {
    user = db
      .select({ plexToken: schema.users.plexToken })
      .from(schema.users)
      .where(eq(schema.users.id, session.user.id))
      .get();
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : "Database error";
    logger.error("Failed to fetch user for plex-devices", { userId: session.user.id, error });
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Failed to retrieve user data" },
      { status: 500 },
    );
  }

  if (!user?.plexToken) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "No Plex account linked — log in with Plex first" },
      { status: 400 },
    );
  }

  let raw: unknown[];
  try {
    const res = await fetch(
      `https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1&X-Plex-Token=${user.plexToken}`,
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!res.ok) {
      return NextResponse.json<ApiResponse>(
        { success: false, error: `Plex.tv returned HTTP ${res.status}` },
        { status: 502 },
      );
    }
    raw = await res.json();
  } catch {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Failed to reach plex.tv — check your internet connection" },
      { status: 502 },
    );
  }

  // Filter to server devices only and shape the response
  const servers: PlexDevice[] = (raw as Record<string, unknown>[])
    .filter((d) => (d.provides as string[] | undefined)?.includes("server"))
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

  return NextResponse.json<ApiResponse>({ success: true, data: servers });
}
