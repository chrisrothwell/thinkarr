import { NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { checkPlexPin, getPlexUser, checkUserHasLibraryAccess } from "@/lib/services/plex-auth";
import { getConfig } from "@/lib/config";
import { logger } from "@/lib/logger";
import type { ApiResponse } from "@/types/api";

/** GET /api/mcp/link?token=xxx — validate a registration token, return channel info. */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get("token");
  if (!token) {
    return NextResponse.json<ApiResponse>({ success: false, error: "token is required" }, { status: 400 });
  }

  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const row = db
    .select()
    .from(schema.mcpRegistrationTokens)
    .where(eq(schema.mcpRegistrationTokens.token, token))
    .get();

  if (!row || row.expiresAt < now) {
    return NextResponse.json<ApiResponse>({ success: false, error: "Registration link has expired. Please ask again to get a new one." }, { status: 410 });
  }

  return NextResponse.json<ApiResponse>({
    success: true,
    data: { channelType: row.channelType, channelUserId: row.channelUserId },
  });
}

/**
 * POST /api/mcp/link — complete channel identity registration after Plex OAuth.
 * Body: { pinId: number, registrationToken: string }
 */
export async function POST(request: Request) {
  let body: { pinId?: number; registrationToken?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<ApiResponse>({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const { pinId, registrationToken } = body;
  if (!pinId || !registrationToken) {
    return NextResponse.json<ApiResponse>({ success: false, error: "pinId and registrationToken are required" }, { status: 400 });
  }

  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  const regToken = db
    .select()
    .from(schema.mcpRegistrationTokens)
    .where(eq(schema.mcpRegistrationTokens.token, registrationToken))
    .get();

  if (!regToken || regToken.expiresAt < now) {
    return NextResponse.json<ApiResponse>({ success: false, error: "Registration link has expired." }, { status: 410 });
  }

  // Validate Plex PIN and get user
  const authToken = await checkPlexPin(pinId).catch(() => null);
  if (!authToken) {
    return NextResponse.json<ApiResponse>({ success: false, error: "pending" });
  }

  const plexUser = await getPlexUser(authToken).catch((e: unknown) => {
    throw new Error(e instanceof Error ? e.message : "Failed to get Plex user");
  });

  // Upsert Thinkarr user
  const existing = db.select().from(schema.users).where(eq(schema.users.plexId, plexUser.id)).get();

  if (!existing) {
    const userCount = db.select().from(schema.users).all().length;
    if (userCount > 0) {
      const plexServerUrl = getConfig("plex.url");
      const plexAdminToken = getConfig("plex.token");
      if (plexServerUrl && plexAdminToken) {
        const hasAccess = await checkUserHasLibraryAccess(plexServerUrl, plexAdminToken, plexUser.id);
        if (!hasAccess) {
          return NextResponse.json<ApiResponse>(
            { success: false, error: "You do not have access to any media on this server." },
            { status: 403 },
          );
        }
      }
    }
    db.insert(schema.users).values({
      plexId: plexUser.id,
      plexUsername: plexUser.username,
      plexEmail: plexUser.email,
      plexAvatarUrl: plexUser.thumb,
      plexToken: plexUser.authToken,
      isAdmin: userCount === 0,
    }).run();
  } else {
    db.update(schema.users)
      .set({ plexUsername: plexUser.username, plexEmail: plexUser.email, plexAvatarUrl: plexUser.thumb, plexToken: plexUser.authToken })
      .where(eq(schema.users.plexId, plexUser.id))
      .run();
  }

  const user = db.select().from(schema.users).where(eq(schema.users.plexId, plexUser.id)).get()!;

  // Store (or update) channel identity
  const existingIdentity = db
    .select()
    .from(schema.mcpChannelIdentities)
    .where(
      and(
        eq(schema.mcpChannelIdentities.channelType, regToken.channelType),
        eq(schema.mcpChannelIdentities.channelUserId, regToken.channelUserId),
      ),
    )
    .get();

  if (existingIdentity) {
    db.update(schema.mcpChannelIdentities)
      .set({ userId: user.id })
      .where(
        and(
          eq(schema.mcpChannelIdentities.channelType, regToken.channelType),
          eq(schema.mcpChannelIdentities.channelUserId, regToken.channelUserId),
        ),
      )
      .run();
  } else {
    db.insert(schema.mcpChannelIdentities).values({
      channelType: regToken.channelType,
      channelUserId: regToken.channelUserId,
      userId: user.id,
    }).run();
  }

  // Consume the registration token
  db.delete(schema.mcpRegistrationTokens)
    .where(eq(schema.mcpRegistrationTokens.token, registrationToken))
    .run();

  logger.info("MCP_CHANNEL_LINKED", {
    channelType: regToken.channelType,
    userId: user.id,
    plexUsername: plexUser.username,
  });

  return NextResponse.json<ApiResponse>({
    success: true,
    data: { plexUsername: plexUser.username },
  });
}
