import { redirect } from "next/navigation";
import { getDb, schema } from "@/lib/db";

export default function Home() {
  // If no users exist yet, this is a fresh install — show welcome splash
  const db = getDb();
  const userCount = db.select().from(schema.users).all().length;
  if (userCount === 0) {
    redirect("/setup");
  }

  // Proxy handles session check — if we reach here, user is authenticated
  redirect("/chat");
}
