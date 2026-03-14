/**
 * Lightweight in-memory IP rate limiter for auth endpoints.
 *
 * Suitable for single-instance Docker deployments. Resets on container
 * restart, which is acceptable — the goal is to slow brute-force attempts
 * during normal operation, not to persist bans across restarts.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

const WINDOW_MS = 60_000; // 1 minute
const MAX_ATTEMPTS = 10;

/** Prune expired buckets to prevent unbounded memory growth. */
function prune() {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/**
 * Check whether the given IP has exceeded the auth attempt limit.
 * Increments the attempt counter on every call.
 *
 * @returns true if the request should be allowed, false if rate limited.
 */
export function checkAuthRateLimit(ip: string): boolean {
  const now = Date.now();

  // Prune occasionally (every ~100 calls) to keep memory bounded
  if (Math.random() < 0.01) prune();

  let bucket = buckets.get(ip);

  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 1, resetAt: now + WINDOW_MS };
    buckets.set(ip, bucket);
    return true;
  }

  bucket.count += 1;
  return bucket.count <= MAX_ATTEMPTS;
}

/** Extract the best available IP from a Request, respecting reverse-proxy headers. */
export function getClientIp(request: Request): string {
  // x-forwarded-for may contain a comma-separated list; take the first (client) IP
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  // x-real-ip is set by Nginx and some other proxies
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  return "unknown";
}

/** Reset all rate limit buckets — exposed for testing only. */
export function _resetRateLimits() {
  buckets.clear();
}
