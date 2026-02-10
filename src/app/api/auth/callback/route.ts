import { NextResponse } from "next/server";
import { checkPlexPin, getPlexUser } from "@/lib/services/plex-auth";
import { createSession } from "@/lib/auth/session";
import { getDb, schema } from "@/lib/db";
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
      // First user is admin
      const userCount = db.select().from(schema.users).all().length;
      const result = db
        .insert(schema.users)
        .values({
          plexId: plexUser.id,
          plexUsername: plexUser.username,
          plexEmail: plexUser.email,
          plexAvatarUrl: plexUser.thumb,
          plexToken: plexUser.authToken,
          isAdmin: userCount === 0,
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
