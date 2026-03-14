import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { getSession } from "@/lib/auth/session";
import { getConfig, setConfig } from "@/lib/config";
import type { ApiResponse } from "@/types/api";

export async function GET() {
  const session = await getSession();
  if (!session || !session.user.isAdmin) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Admin access required" },
      { status: 403 },
    );
  }

  let token = getConfig("mcp.bearerToken");
  if (!token) {
    token = randomBytes(32).toString("hex");
    setConfig("mcp.bearerToken", token, true);
  }

  return NextResponse.json<ApiResponse>({
    success: true,
    data: { token },
  });
}

export async function POST() {
  const session = await getSession();
  if (!session || !session.user.isAdmin) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Admin access required" },
      { status: 403 },
    );
  }

  const token = randomBytes(32).toString("hex");
  setConfig("mcp.bearerToken", token, true);

  return NextResponse.json<ApiResponse>({
    success: true,
    data: { token },
  });
}
