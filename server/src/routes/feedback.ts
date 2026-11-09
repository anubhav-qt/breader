import { Hono } from 'hono';
import { SendFeedback } from '@breader/shared';
import type { AppEnv, Deps } from '../context.ts';
import { feedback } from '../db/schema.ts';
import { parse, readJson } from '../lib/errors.ts';
import { rateLimit } from '../lib/http.ts';
import { sessionLibrary } from '../lib/library.ts';

/*
 * A reader asking for a feature or telling us something (shared/src/feedback.ts). Anyone may send
 * it, signed in or not; the library they have open goes with it, so the admin page can tell two
 * readers apart. Read and marked done on the admin page (routes/admin.ts).
 */
export function feedbackRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();

  r.post('/feedback', rateLimit({ name: 'feedback', max: 10, windowMs: 10 * 60_000 }), async (c) => {
    const sent = parse(SendFeedback, await readJson(c));
    const lib = await sessionLibrary(c, deps);
    await deps.db.insert(feedback).values({ kind: sent.kind, body: sent.body, libraryId: lib?.id ?? null, release: sent.release ?? null });
    return c.json({ ok: true }, 201);
  });

  return r;
}
