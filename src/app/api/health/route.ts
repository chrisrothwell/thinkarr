import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";

export async function GET() {
  try {
    // Probe the schema — this query references every column that has caused
    // production outages. If duration_ms (or any other expected column) is
    // absent the SELECT throws immediately and we return 503, which fails
    // the Docker HEALTHCHECK and the docker-e2e waitForServer() check in CI.
    getDb()
      .select({ id: schema.messages.id, durationMs: schema.messages.durationMs })
      .from(schema.messages)
      .limit(0)
      .all();
    return NextResponse.json({ status: "ok" });
  } catch (e) {
    return NextResponse.json({ status: "error", detail: String(e) }, { status: 503 });
  }
}
