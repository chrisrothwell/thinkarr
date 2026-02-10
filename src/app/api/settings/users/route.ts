import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
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

  const db = getDb();
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

  // Get per-user settings from config
  const usersWithSettings = users.map((u) => ({
    ...u,
    defaultModel: getConfig(`user.${u.id}.defaultModel`) || "",
    canChangeModel: getConfig(`user.${u.id}.canChangeModel`) !== "false",
  }));

  return NextResponse.json<ApiResponse>({ success: true, data: usersWithSettings });
}

export async function PATCH(request: Request) {
  const session = await getSession();
  if (!session || !session.user.isAdmin) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Admin access required" },
      { status: 403 },
    );
  }

  let body: {
    userId: number;
    isAdmin?: boolean;
    defaultModel?: string;
    canChangeModel?: boolean;
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

  if (body.isAdmin !== undefined) {
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

  return NextResponse.json<ApiResponse>({ success: true });
}
