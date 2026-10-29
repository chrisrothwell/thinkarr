import { NextResponse } from "next/server";
import { checkPlexPin, getPlexUser } from "@/lib/services/plex-auth";
import { createSession } from "@/lib/auth/session";
import { checkAuthRateLimit, getClientIp } from "@/lib/auth/rate-limit";
import { logger } from "@/lib/logger";
import type { ApiResponse } from "@/types/api";
import { PlexRegistrationError, registerPlexAccount } from "@/lib/auth/plex-registration";

export async function POST(request: Request) {
  const ip = getClientIp(request);
  if (!checkAuthRateLimit(ip)) {
    logger.warn("Auth rate limit exceeded", { ip });
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Too many attempts. Please wait before trying again." },
      { status: 429 },
    );
  }

  let body: { pinId: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  if (!body || typeof body !== "object" || typeof body.pinId !== "number" || !Number.isSafeInteger(body.pinId) || body.pinId <= 0) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "pinId must be a positive safe integer" },
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
    const user = await registerPlexAccount(plexUser);
    const userId = user.id;

    // Create session
    await createSession(userId);

    return NextResponse.json<ApiResponse>({
      success: true,
      data: {
        user: {
          id: userId,
          plexUsername: plexUser.username,
          plexAvatarUrl: plexUser.thumb ? `/api/plex/avatar/${userId}` : null,
          isAdmin: user?.isAdmin ?? false,
        },
      },
    });
  } catch (e: unknown) {
    if (e instanceof PlexRegistrationError) return NextResponse.json<ApiResponse>({ success: false, error: e.message }, { status: e.status });
    const msg = e instanceof Error ? e.message : "Authentication failed";
    return NextResponse.json<ApiResponse>(
      { success: false, error: msg },
      { status: 500 },
    );
  }
}
