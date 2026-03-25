import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getConfig, setConfig } from "@/lib/config";
import { randomBytes } from "crypto";
import type { ApiResponse } from "@/types/api";

export async function GET() {
  const session = await getSession();
  if (!session || !session.user.isAdmin) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Admin access required" },
      { status: 403 },
    );
  }

  const key = getConfig("internal_api_key") ?? "";
  return NextResponse.json<ApiResponse>({ success: true, data: { key } });
}

export async function POST() {
  const session = await getSession();
  if (!session || !session.user.isAdmin) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Admin access required" },
      { status: 403 },
    );
  }

  const key = randomBytes(32).toString("hex");
  setConfig("internal_api_key", key, true);
  return NextResponse.json<ApiResponse>({ success: true, data: { key } });
}
