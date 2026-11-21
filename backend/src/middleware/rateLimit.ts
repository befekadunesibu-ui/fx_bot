import type { RequestHandler } from 'express';

const buckets = new Map<string, { startedAt: number; count: number }>();

export function userRateLimit(maxRequests: number, windowMs: number): RequestHandler {
  return (request, response, next) => {
    const key = request.telegramUser?.id ?? request.ip ?? 'unknown';
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || now - bucket.startedAt >= windowMs) {
      buckets.set(key, { startedAt: now, count: 1 });
      next();
      return;
    }
    bucket.count += 1;
    if (bucket.count > maxRequests) {
      response.status(429).json({ error: 'Too many requests. Please retry later.' });
      return;
    }
    next();
  };
}
