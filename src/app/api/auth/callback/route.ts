import { NextResponse } from "next/server";
import { checkPlexPin, getPlexUser, checkUserHasLibraryAccess } from "@/lib/services/plex-auth";
import { createSession } from "@/lib/auth/session";
import { getDb, schema } from "@/lib/db";
import { getConfig } from "@/lib/config";
import { eq } from "drizzle-orm";
import type { ApiResponse } from "@/types/api";

export async function POST(request: Request) {
  let body: { pinId: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  if (!body.pinId) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "pinId is required" },
      { status: 400 },
    );
  }

  try {
    // Check if PIN has been claimed
    const authToken = await checkPlexPin(body.pinId);
    if (!authToken) {
      return NextResponse.json<ApiResponse>({
        success: false,
        error: "pending",
      });
    }

    // Get user info from Plex
    const plexUser = await getPlexUser(authToken);

    // Upsert user in DB
    const db = getDb();
    const existing = db
      .select()
      .from(schema.users)
      .where(eq(schema.users.plexId, plexUser.id))
      .get();

    // Count existing users once — used both for the library access check and
    // for determining whether the new user should be promoted to admin.
    const userCount = existing ? null : db.select().from(schema.users).all().length;

    // Library access check — only for new registrations when Plex is configured.
    // The very first user (the admin) is always allowed through.
    if (!existing && userCount! > 0) {
      const plexServerUrl = getConfig("plex.url");
      if (plexServerUrl) {
        const hasAccess = await checkUserHasLibraryAccess(plexServerUrl, plexUser.authToken);
        if (!hasAccess) {
          return NextResponse.json<ApiResponse>(
            {
              success: false,
              error:
                "You do not have access to any media on this server, please contact the owner to get access to a Shared Library.",
            },
            { status: 403 },
          );
        }
      }
    }

    let userId: number;

    if (existing) {
      db.update(schema.users)
        .set({
          plexUsername: plexUser.username,
          plexEmail: plexUser.email,
          plexAvatarUrl: plexUser.thumb,
          plexToken: plexUser.authToken,
        })
        .where(eq(schema.users.plexId, plexUser.id))
        .run();
      userId = existing.id;
    } else {
      const result = db
        .insert(schema.users)
        .values({
          plexId: plexUser.id,
          plexUsername: plexUser.username,
          plexEmail: plexUser.email,
          plexAvatarUrl: plexUser.thumb,
          plexToken: plexUser.authToken,
          isAdmin: userCount === 0, // userCount is non-null when !existing
        })
        .returning({ id: schema.users.id })
        .get();
      userId = result.id;
    }

    // Create session
    await createSession(userId);

    // Fetch updated user to get isAdmin flag
    const user = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();

    return NextResponse.json<ApiResponse>({
      success: true,
      data: {
        user: {
          id: userId,
          plexUsername: plexUser.username,
          plexAvatarUrl: plexUser.thumb,
          isAdmin: user?.isAdmin ?? false,
        },
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Authentication failed";
    return NextResponse.json<ApiResponse>(
      { success: false, error: msg },
      { status: 500 },
    );
  }
}
