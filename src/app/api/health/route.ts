import { NextResponse } from "next/server";
import { isTable } from "drizzle-orm";
import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { logger } from "@/lib/logger";

// Never cache or pre-render this route — every request must hit the live DB
// so that ensureSchemaIntegrity runs and the probe reflects the real schema state.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = getDb();
    // Probe every table in schema.ts with a zero-row SELECT that exercises
    // all columns. Any column present in schema.ts but absent from the live
    // database causes an immediate SQLite error, returning 503 and failing the
    // Docker HEALTHCHECK before broken queries ever reach real users.
    // Include delegated MCP tables automatically as the schema grows.
    for (const table of Object.values(schema)) {
      if (isTable(table)) db.select().from(table).limit(0).all();
    }
    return NextResponse.json({ status: "ok" });
  } catch {
    try { logger.error("HEALTH_SCHEMA_PROBE_FAILED"); } catch { /* The health response must survive logging failure. */ }
    return NextResponse.json({ status: "error" }, { status: 503 });
  }
}
