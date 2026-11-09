import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { NewsSeen, type NewsSeenAnswer } from '@breader/shared';
import type { AppEnv, Deps } from '../context.ts';
import { newsSeen } from '../db/schema.ts';
import { parse, readJson } from '../lib/errors.ts';
import { rateLimit } from '../lib/http.ts';
import { sessionLibrary } from '../lib/library.ts';

/*
 * What's new shows once for an account, an address and a device. The device keeps its own note
 * (frontend features/news/seen.ts) and asks here before showing one: the first ask for a note from
 * this library or this address is told to show it, every later one is told not to.
 */
export function newsRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();

  r.post('/news/seen', rateLimit({ name: 'news', max: 30, windowMs: 10 * 60_000 }), async (c) => {
    const { note } = parse(NewsSeen, await readJson(c));
    const lib = await sessionLibrary(c, deps);
    const who: string[] = [];
    if (lib) {
      who.push(`lib:${lib.id}`);
    }
    if (c.var.ip !== 'unknown') {
      who.push(`ip:${addressMark(c.var.ip, deps.env.KEY_PEPPER)}`);
    }
    if (who.length === 0) {
      return c.json<NewsSeenAnswer>({ first: true });
    }
    const rows = who.map((w) => ({ who: w, note }));
    const added = await deps.db.insert(newsSeen).values(rows).onConflictDoNothing().returning({ who: newsSeen.who });
    const first = added.length === who.length;
    return c.json<NewsSeenAnswer>({ first });
  });

  return r;
}

/** An address as it's kept: the same for the same address, and no way back to it. */
function addressMark(ip: string, pepper: string): string {
  return createHmac('sha256', pepper).update(`news-ip:${ip}`).digest('base64url');
}
