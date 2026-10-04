/**
 * Fixed-window rate limiter for API routes.
 *
 * In-memory, so on a serverless platform each instance keeps its own counter and
 * the effective limit is (instances x limit). That is fine for what this
 * defends — an unmetered RPC proxy burning through the Helius free tier — and it
 * costs nothing, which is the point. If we ever need a real global limit, this
 * is the seam to swap for a shared store.
 */

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

/** Bound the map so a flood of unique keys cannot grow it without limit. */
const MAX_TRACKED_KEYS = 10_000;

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  resetAt: number;
}

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): RateLimitResult {
  const existing = buckets.get(key);

  if (!existing || now >= existing.resetAt) {
    if (buckets.size >= MAX_TRACKED_KEYS) evictExpired(now);
    const fresh = { count: 1, resetAt: now + windowMs };
    buckets.set(key, fresh);
    return { ok: true, remaining: limit - 1, resetAt: fresh.resetAt };
  }

  existing.count += 1;
  return {
    ok: existing.count <= limit,
    remaining: Math.max(0, limit - existing.count),
    resetAt: existing.resetAt,
  };
}

function evictExpired(now: number) {
  for (const [key, bucket] of buckets) {
    if (now >= bucket.resetAt) buckets.delete(key);
  }
  // Still full of live entries — drop the oldest to bound memory.
  if (buckets.size >= MAX_TRACKED_KEYS) {
    const oldest = [...buckets.entries()]
      .sort((a, b) => a[1].resetAt - b[1].resetAt)
      .slice(0, Math.floor(MAX_TRACKED_KEYS / 4));
    for (const [key] of oldest) buckets.delete(key);
  }
}

/**
 * Best-effort client identity. `x-forwarded-for` is spoofable, so this is a
 * courtesy limit against ordinary abuse, not a security boundary — the real
 * protection is that every state change costs the caller a signed transaction.
 */
export function clientKey(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return headers.get("x-real-ip") ?? "unknown";
}

/** Test seam — exported so unit tests can start from a clean slate. */
export function __resetRateLimiter() {
  buckets.clear();
}
