import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getDb, schema } from "@/lib/db";
import { eq, asc } from "drizzle-orm";
import { getConfig, getRateLimit, setRateLimit, countUserMessagesSince } from "@/lib/config";
import type { RateLimitPeriod } from "@/lib/config";
import { checkUserApiRateLimit } from "@/lib/security/api-rate-limit";
import { logger } from "@/lib/logger";
import type { ApiResponse } from "@/types/api";

export async function GET() {
  const session = await getSession();
  if (!session || !session.user.isAdmin) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Admin access required" },
      { status: 403 },
    );
  }

  if (!checkUserApiRateLimit(session.user.id)) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Too many requests. Please slow down." },
      { status: 429 },
    );
  }

  const db = getDb();

  try {
    const users = db
      .select({
        id: schema.users.id,
        plexUsername: schema.users.plexUsername,
        plexEmail: schema.users.plexEmail,
        plexAvatarUrl: schema.users.plexAvatarUrl,
        isAdmin: schema.users.isAdmin,
        createdAt: schema.users.createdAt,
      })
      .from(schema.users)
      .all();

    // Get per-user settings and message stats from config/DB
    const now = new Date();
    const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const since7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const since30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const usersWithSettings = users.map((u) => {
      const rl = getRateLimit(u.id);
      return {
        ...u,
        plexAvatarUrl: u.plexAvatarUrl ? `/api/plex/avatar/${u.id}` : null,
        defaultModel: getConfig(`user.${u.id}.defaultModel`) || "",
        canChangeModel: getConfig(`user.${u.id}.canChangeModel`) !== "false",
        rateLimitMessages: rl.messages,
        rateLimitPeriod: rl.period,
        msgCount24h: countUserMessagesSince(u.id, since24h),
        msgCount7d: countUserMessagesSince(u.id, since7d),
        msgCount30d: countUserMessagesSince(u.id, since30d),
      };
    });

    return NextResponse.json<ApiResponse>({ success: true, data: usersWithSettings });
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : "Database error";
    logger.error("Failed to list users", { adminUserId: session.user.id, error });
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Failed to load users" },
      { status: 500 },
    );
  }
}

export async function PATCH(request: Request) {
  const session = await getSession();
  if (!session || !session.user.isAdmin) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Admin access required" },
      { status: 403 },
    );
  }

  if (!checkUserApiRateLimit(session.user.id)) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Too many requests. Please slow down." },
      { status: 429 },
    );
  }

  let body: {
    userId: number;
    isAdmin?: boolean;
    defaultModel?: string;
    canChangeModel?: boolean;
    rateLimitMessages?: number;
    rateLimitPeriod?: RateLimitPeriod;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Invalid JSON" },
      { status: 400 },
    );
  }

  const db = getDb();
  const { setConfig } = await import("@/lib/config");

  try {
    if (body.isAdmin !== undefined) {
      // The first registered user (lowest ID) is the master admin and cannot be demoted
      const firstUser = db
        .select({ id: schema.users.id })
        .from(schema.users)
        .orderBy(asc(schema.users.id))
        .get();
      if (body.isAdmin === false && firstUser?.id === body.userId) {
        return NextResponse.json<ApiResponse>(
          { success: false, error: "The master administrator cannot be demoted" },
          { status: 403 },
        );
      }
      db.update(schema.users)
        .set({ isAdmin: body.isAdmin })
        .where(eq(schema.users.id, body.userId))
        .run();
    }

    if (body.defaultModel !== undefined) {
      setConfig(`user.${body.userId}.defaultModel`, body.defaultModel);
    }

    if (body.canChangeModel !== undefined) {
      setConfig(`user.${body.userId}.canChangeModel`, String(body.canChangeModel));
    }

    if (body.rateLimitMessages !== undefined || body.rateLimitPeriod !== undefined) {
      const current = getRateLimit(body.userId);
      setRateLimit(body.userId, {
        messages: body.rateLimitMessages ?? current.messages,
        period: body.rateLimitPeriod ?? current.period,
      });
    }
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : "Database error";
    logger.error("Failed to update user settings", { adminUserId: session.user.id, targetUserId: body.userId, error });
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Failed to update user settings" },
      { status: 500 },
    );
  }

  logger.info("User settings updated", { adminUserId: session.user.id, targetUserId: body.userId });
  return NextResponse.json<ApiResponse>({ success: true });
}
