import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { getConfig } from "@/lib/config";
import { logger } from "@/lib/logger";
import { checkUserHasLibraryAccess, type PlexUser } from "@/lib/services/plex-auth";

export class PlexRegistrationError extends Error {
  readonly status = 403;
}

/** Existing normal Plex registration admission; no channel credential can
 * bypass it or select a different Plex account by name.
 */
export async function registerPlexAccount(plexUser: PlexUser) {
  const db = getDb();
  const existing = db.select().from(schema.users).where(eq(schema.users.plexId, plexUser.id)).get();
  const userCount = existing ? null : db.select().from(schema.users).all().length;
  if (!existing && userCount! > 0) {
    const url = getConfig("plex.url");
    const token = getConfig("plex.token");
    if (url && token && !await checkUserHasLibraryAccess(url, token, plexUser.id)) {
      logger.warn("Library access denied", { plexId: plexUser.id });
      throw new PlexRegistrationError("You do not have access to any media on this server, please contact the owner to get access to a Shared Library.");
    }
  }
  const fields = { plexUsername: plexUser.username, plexEmail: plexUser.email, plexAvatarUrl: plexUser.thumb, plexToken: plexUser.authToken };
  if (existing) {
    db.update(schema.users).set(fields).where(eq(schema.users.id, existing.id)).run();
    logger.info("User login", { userId: existing.id });
  } else {
    db.insert(schema.users).values({ plexId: plexUser.id, ...fields, isAdmin: userCount === 0 }).run();
  }
  const user = db.select().from(schema.users).where(eq(schema.users.plexId, plexUser.id)).get()!;
  if (!existing) logger.info("User registered", { userId: user.id, isAdmin: user.isAdmin });
  return user;
}
