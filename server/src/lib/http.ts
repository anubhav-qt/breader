import type { Context, MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { ApiError } from './errors.ts';

/** The reader's address: Cloudflare puts it in cf-connecting-ip, Render in x-forwarded-for. */
export function clientIp(c: Context): string {
  const cf = c.req.header('cf-connecting-ip');
  if (cf) return cf;
  const fwd = c.req.header('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * A small fixed-window limit per address, kept in memory. Each server counts on its own, which is
 * enough to stop scripted guessing; Turnstile joins it on sign-up in Phase 2. Limits are looser
 * than a single person needs because Indian mobile carriers put many people behind one address.
 */
export function rateLimit(opts: { name: string; max: number; windowMs: number }): MiddlewareHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return async (c, next) => {
    const now = Date.now();
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    const key = clientIp(c);
    let h = hits.get(key);
    if (!h || h.resetAt <= now) {
      h = { count: 0, resetAt: now + opts.windowMs };
      hits.set(key, h);
    }
    if (++h.count > opts.max) {
      c.header('Retry-After', String(Math.ceil((h.resetAt - now) / 1000)));
      throw new ApiError(429, 'too_many', 'Too many tries from this network. Wait a few minutes and try again.');
    }
    await next();
  };
}

/**
 * Writes must come from the app's own pages. Browsers always send Origin on these requests, so a
 * missing or foreign Origin means another site (or a script) is trying to use the reader's cookie.
 */
export function sameOriginWrites(allowed: string[]): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.method !== 'OPTIONS') {
      const origin = c.req.header('origin');
      if (!origin || !allowed.includes(origin)) {
        throw new ApiError(403, 'bad_origin', 'This request didn’t come from Breader.');
      }
    }
    await next();
  };
}
