import { cookies, headers } from "next/headers";
import { v4 as uuidv4 } from "uuid";
import { getDb, schema } from "@/lib/db";
import { eq, and, gt } from "drizzle-orm";
import type { User } from "@/types";

const SESSION_COOKIE = "thinkarr_session";
const SESSION_MAX_AGE_DAYS = 30;

/**
 * Determine whether the session cookie should be marked Secure.
 *
 * Three modes via SECURE_COOKIES env var:
 *   "true"  — always set Secure (user has confirmed HTTPS everywhere)
 *   "false" — never set Secure (plain HTTP LAN deployment, the default)
 *   "auto"  — trust X-Forwarded-Proto from the upstream reverse proxy;
 *             sets Secure only when the proxy signals HTTPS
 *
 * Note: only trust X-Forwarded-Proto in "auto" mode when the app is behind
 * a reverse proxy you control. In direct-internet deployments, this header
 * could be spoofed, making the cookie insecure rather than more secure (the
 * worst outcome is a non-Secure cookie, not a security escalation).
 */
async function shouldUseSecureCookie(): Promise<boolean> {
  const mode = process.env.SECURE_COOKIES ?? "false";
  if (mode === "true") return true;
  if (mode === "false") return false;
  // auto: check the forwarded protocol header set by the reverse proxy
  const headerStore = await headers();
  return headerStore.get("x-forwarded-proto") === "https";
}

export interface SessionWithUser {
  sessionId: string;
  user: User;
}

/** Create a new session for the given user ID. Sets the session cookie. */
export async function createSession(userId: number): Promise<string> {
  const db = getDb();
  const sessionId = uuidv4();
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000);

  db.insert(schema.sessions)
    .values({ id: sessionId, userId, expiresAt })
    .run();

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: await shouldUseSecureCookie(),
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_DAYS * 24 * 60 * 60,
  });

  return sessionId;
}

/** Validate the session cookie and return the associated user. Returns null if invalid/expired. */
export async function getSession(): Promise<SessionWithUser | null> {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value;
  if (!sessionId) return null;

  const db = getDb();
  const now = new Date();

  const session = db
    .select()
    .from(schema.sessions)
    .where(and(eq(schema.sessions.id, sessionId), gt(schema.sessions.expiresAt, now)))
    .get();

  if (!session) return null;

  const user = db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, session.userId))
    .get();

  if (!user) return null;

  return {
    sessionId,
    user: {
      id: user.id,
      plexId: user.plexId,
      plexUsername: user.plexUsername,
      plexEmail: user.plexEmail,
      plexAvatarUrl: user.plexAvatarUrl,
      isAdmin: user.isAdmin,
    },
  };
}

/** Destroy a session by ID and clear the cookie. */
export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value;

  if (sessionId) {
    const db = getDb();
    db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId)).run();
  }

  cookieStore.delete(SESSION_COOKIE);
}

/** Check if a session cookie exists (lightweight check for middleware — no DB hit). */
export function hasSessionCookie(cookieHeader: string | null): boolean {
  if (!cookieHeader) return false;
  return cookieHeader.includes(`${SESSION_COOKIE}=`);
}

export { SESSION_COOKIE };
