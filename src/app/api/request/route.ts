import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { requestMovie, requestTv } from "@/lib/services/overseerr";
import { logger } from "@/lib/logger";
import type { ApiResponse } from "@/types/api";

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json<ApiResponse>({ success: false, error: "Not authenticated" }, { status: 401 });
  }

  let body: { id: number; mediaType: "movie" | "tv"; seasons?: number[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<ApiResponse>({ success: false, error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.id || !body.mediaType) {
    return NextResponse.json<ApiResponse>({ success: false, error: "id and mediaType are required" }, { status: 400 });
  }

  try {
    let result: { success: boolean; message: string };
    if (body.mediaType === "movie") {
      result = await requestMovie(body.id);
    } else {
      result = await requestTv(body.id, body.seasons);
    }

    if (result.success) {
      logger.info("Media request submitted", {
        userId: session.user.id,
        mediaType: body.mediaType,
        overseerrId: body.id,
      });
    } else {
      logger.warn("Media request failed", {
        userId: session.user.id,
        mediaType: body.mediaType,
        overseerrId: body.id,
        reason: result.message,
      });
      return NextResponse.json<ApiResponse>({ success: false, error: result.message }, { status: 422 });
    }

    return NextResponse.json<ApiResponse>({ success: true, data: result });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Request failed";
    logger.error("Media request error", { userId: session.user.id, error: msg });
    return NextResponse.json<ApiResponse>({ success: false, error: msg }, { status: 500 });
  }
}
