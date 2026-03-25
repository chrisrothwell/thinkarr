import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import path from "path";
import fs from "fs";
import type { ApiResponse } from "@/types/api";

const CONFIG_DIR =
  process.env.CONFIG_DIR || (process.platform === "win32" ? "./.config" : "/config");
const LOGS_DIR = path.join(CONFIG_DIR, "logs");

const DEFAULT_TAIL = 300;
const MAX_TAIL = 2000;

export async function GET(request: Request) {
  const providedKey = request.headers.get("x-api-key");
  const storedKey = getConfig("internal_api_key");

  if (!providedKey || !storedKey || providedKey !== storedKey) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const { searchParams } = new URL(request.url);
  const tailParam = searchParams.get("tail");
  const parsed = parseInt(tailParam ?? "", 10);
  const tail = Math.min(Math.max(1, isNaN(parsed) ? DEFAULT_TAIL : parsed), MAX_TAIL);

  const levelFilter = searchParams.get("level")?.toLowerCase() ?? null;
  const conversationFilter = searchParams.get("conversationId") ?? null;

  if (!fs.existsSync(LOGS_DIR)) {
    return NextResponse.json<ApiResponse>({ success: true, data: { lines: [], tail: 0 } });
  }

  // Collect log files newest-first so we can stop reading once we have enough lines.
  const logFiles = fs
    .readdirSync(LOGS_DIR)
    .filter((f) => f.endsWith(".log"))
    .sort()
    .reverse();

  const collected: string[] = [];

  for (const filename of logFiles) {
    const content = fs.readFileSync(path.join(LOGS_DIR, filename), "utf-8");
    const lines = content.split("\n").filter((l) => l.trim() !== "");
    // Prepend in reverse so the final array stays chronological
    collected.unshift(...lines);
    if (collected.length >= tail && !levelFilter && !conversationFilter) {
      // Enough raw lines — no need to read older files
      break;
    }
  }

  // Apply filters before slicing so tail reflects filtered lines, not raw lines
  let filtered = collected;
  if (levelFilter) {
    filtered = filtered.filter((l) => l.toLowerCase().includes(`"level":"${levelFilter}"`));
  }
  if (conversationFilter) {
    filtered = filtered.filter((l) => l.includes(conversationFilter));
  }

  const lines = filtered.slice(-tail);

  return NextResponse.json<ApiResponse>({
    success: true,
    data: { lines, tail: lines.length },
  });
}
