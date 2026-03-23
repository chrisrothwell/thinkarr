import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";

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
    // Add new tables here as they are introduced in schema.ts.
    db.select().from(schema.appConfig).limit(0).all();
    db.select().from(schema.users).limit(0).all();
    db.select().from(schema.sessions).limit(0).all();
    db.select().from(schema.conversations).limit(0).all();
    db.select().from(schema.messages).limit(0).all();
    return NextResponse.json({ status: "ok" });
  } catch (e) {
    return NextResponse.json({ status: "error", detail: String(e) }, { status: 503 });
  }
}
