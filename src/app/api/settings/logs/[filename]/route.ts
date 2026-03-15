import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import path from "path";
import fs from "fs";
import type { ApiResponse } from "@/types/api";

const CONFIG_DIR =
  process.env.CONFIG_DIR || (process.platform === "win32" ? "./.config" : "/config");
const LOGS_DIR = path.join(CONFIG_DIR, "logs");

const TAIL_LINES = 500;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ filename: string }> },
) {
  const session = await getSession();
  if (!session || !session.user.isAdmin) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Admin access required" },
      { status: 403 },
    );
  }

  const { filename } = await params;

  // Prevent path traversal: only allow plain filenames with no directory separators
  if (!filename || filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Invalid filename" },
      { status: 400 },
    );
  }

  const filePath = path.join(LOGS_DIR, filename);

  // Ensure the resolved path is inside LOGS_DIR
  if (!filePath.startsWith(LOGS_DIR + path.sep) && filePath !== LOGS_DIR) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Invalid filename" },
      { status: 400 },
    );
  }

  if (!fs.existsSync(filePath)) {
    return NextResponse.json<ApiResponse>(
      { success: false, error: "Log file not found" },
      { status: 404 },
    );
  }

  const { searchParams } = new URL(request.url);
  const full = searchParams.get("full") === "true";
  const download = searchParams.get("download") === "true";

  if (download) {
    const stream = fs.createReadStream(filePath);
    return new Response(stream as unknown as ReadableStream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  const allLines = raw.split("\n").filter((l) => l.trim() !== "");
  const totalLines = allLines.length;

  const lines = full ? allLines : allLines.slice(-TAIL_LINES);
  const showing = lines.length;

  return NextResponse.json<ApiResponse>({
    success: true,
    data: { content: lines.join("\n"), totalLines, showing },
  });
}
