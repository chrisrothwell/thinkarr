import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getConfig } from "@/lib/config";
import type { ApiResponse } from "@/types/api";

export async function GET() {
  const session = await getSession();
  if (!session || !session.user.isAdmin) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Admin access required" },
      { status: 403 },
    );
  }

  return NextResponse.json<ApiResponse>({
    success: true,
    data: {
      publicKey: getConfig("langfuse.publicKey") || "",
      secretKey: getConfig("langfuse.secretKey") || "",
    },
  });
}
