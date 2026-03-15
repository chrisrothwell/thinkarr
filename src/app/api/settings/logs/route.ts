import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import path from "path";
import fs from "fs";
import type { ApiResponse } from "@/types/api";

const CONFIG_DIR =
  process.env.CONFIG_DIR || (process.platform === "win32" ? "./.config" : "/config");
const LOGS_DIR = path.join(CONFIG_DIR, "logs");

export async function GET() {
  const session = await getSession();
  if (!session || !session.user.isAdmin) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Admin access required" },
      { status: 403 },
    );
  }

  if (!fs.existsSync(LOGS_DIR)) {
    return NextResponse.json<ApiResponse>({ success: true, data: [] });
  }

  const entries = fs.readdirSync(LOGS_DIR).filter((f) => f.endsWith(".log"));
  const files = entries
    .map((name) => {
      const stat = fs.statSync(path.join(LOGS_DIR, name));
      return { name, size: stat.size, modified: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.modified.localeCompare(a.modified));

  return NextResponse.json<ApiResponse>({ success: true, data: files });
}
