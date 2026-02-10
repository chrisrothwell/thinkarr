import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { createPlexPin, checkPlexPin } from "@/lib/services/plex-auth";
import { setConfig } from "@/lib/config";
import type { ApiResponse } from "@/types/api";

/** POST: Create a Plex PIN for the settings OAuth flow. */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session || !session.user.isAdmin) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Admin access required" },
      { status: 403 },
    );
  }

  let body: { action: string; pinId?: number } = { action: "create" };
  try {
    body = await request.json();
  } catch {
    // Default to create
  }

  if (body.action === "check" && body.pinId) {
    // Check if the PIN has been claimed
    try {
      const token = await checkPlexPin(body.pinId);
      if (token) {
        // Save the Plex token to config
        setConfig("plex.token", token, true);
        return NextResponse.json<ApiResponse>({
          success: true,
          data: { claimed: true },
        });
      }
      return NextResponse.json<ApiResponse>({
        success: true,
        data: { claimed: false },
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "PIN check failed";
      return NextResponse.json<ApiResponse>(
        { success: false, error: msg },
        { status: 500 },
      );
    }
  }

  // Create new PIN
  try {
    const pin = await createPlexPin();
    return NextResponse.json<ApiResponse>({
      success: true,
      data: pin,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Failed to create Plex PIN";
    return NextResponse.json<ApiResponse>(
      { success: false, error: msg },
      { status: 500 },
    );
  }
}
