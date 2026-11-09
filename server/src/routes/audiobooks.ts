import { Hono } from 'hono';
import type { AppEnv } from '../context.ts';
import { ApiError } from '../lib/errors.ts';

/*
 * Audiobooks are made on readers' own devices only. This is left for apps opened before that
 * changed, for one release: they ask whether Breader's computer makes them (it doesn't) and, for a
 * book it was making, are told to make it on the device. Remove it in the release after.
 */
export function audiobookRoutes() {
  const r = new Hono<AppEnv>();

  r.get('/audiobooks/info', (c) => {
    c.header('Cache-Control', 'private, no-store');
    return c.json({ on: false, voices: [] });
  });

  r.all('/audiobooks/*', () => {
    throw new ApiError(410, 'audiobooks_off', 'Breader’s computer doesn’t make audiobooks any more. Make it on this device instead.');
  });

  return r;
}
