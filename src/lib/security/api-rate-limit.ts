/**
 * Lightweight in-memory per-user rate limiter for authenticated API endpoints.
 *
 * Suitable for single-instance Docker deployments. Resets on container restart,
 * which is acceptable — the goal is to prevent abuse and pre-empt ZAP findings,
 * not to persist limits across restarts.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<number, Bucket>();

const WINDOW_MS = 60_000; // 1 minute
const MAX_REQUESTS = process.env.API_RATE_LIMIT_MAX
  ? parseInt(process.env.API_RATE_LIMIT_MAX, 10)
  : 60;

/** Prune expired buckets to prevent unbounded memory growth. */
function prune() {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/**
 * Check whether the given user has exceeded the API rate limit.
 * Increments the request counter on every call.
 *
 * @returns true if the request should be allowed, false if rate limited.
 */
export function checkUserApiRateLimit(userId: number): boolean {
  const now = Date.now();

  // Prune occasionally (~1% of calls) to keep memory bounded
  if (Math.random() < 0.01) prune();

  let bucket = buckets.get(userId);

  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 1, resetAt: now + WINDOW_MS };
    buckets.set(userId, bucket);
    return true;
  }

  bucket.count += 1;
  return bucket.count <= MAX_REQUESTS;
}

/** Reset all buckets — exposed for testing only. */
export function _resetApiRateLimits() {
  buckets.clear();
}
