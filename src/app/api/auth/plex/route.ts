import { NextResponse } from "next/server";
import { createPlexPin } from "@/lib/services/plex-auth";
import type { ApiResponse } from "@/types/api";

export async function POST() {
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
      { status: 502 },
    );
  }
}
