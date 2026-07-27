import type { RequestHandler } from "express";

interface Bucket {
  count: number;
  resetAt: number;
}

export function createRateLimiter(limit: number, windowMs: number): RequestHandler {
  const buckets = new Map<string, Bucket>();

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, Math.min(windowMs, 60_000));
  cleanup.unref();

  return (req, res, next) => {
    const forwarded = req.header("x-forwarded-for")?.split(",")[0]?.trim();
    const key = forwarded || req.ip || "unknown";
    const now = Date.now();
    const current = buckets.get(key);

    if (!current || current.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    current.count += 1;
    if (current.count > limit) {
      res.setHeader("Retry-After", Math.ceil((current.resetAt - now) / 1000));
      res.status(429).json({
        ok: false,
        error: { code: "RATE_LIMITED", message: "Too many requests. Try again shortly." }
      });
      return;
    }

    next();
  };
}
