import { Hono } from 'hono';
import { SendFeedback, type FeedbackRepliesAnswer, type FeedbackReply } from '@breader/shared';
import type { AppEnv, Deps } from '../context.ts';
import { feedback } from '../db/schema.ts';
import { parse, readJson } from '../lib/errors.ts';
import { rateLimit } from '../lib/http.ts';
import { sessionLibrary } from '../lib/library.ts';

/*
 * A reader asking for a feature or telling us something (shared/src/feedback.ts). Anyone may send
 * it, signed in or not; the library they have open goes with it, so the admin page can tell two
 * readers apart. Read and marked done on the admin page (routes/admin.ts).
 *
 * The library that sent it then asks, as Breader opens, what it should be told: that something is
 * being worked on (a toast), or that it's done and what it became (a dialog). Each is told once:
 * asking marks it told, so another device or a reload never shows it again.
 */
export function feedbackRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();

  r.post('/feedback', rateLimit({ name: 'feedback', max: 10, windowMs: 10 * 60_000 }), async (c) => {
    const sent = parse(SendFeedback, await readJson(c));
    const lib = await sessionLibrary(c, deps);
    await deps.db.insert(feedback).values({ kind: sent.kind, body: sent.body, libraryId: lib?.id ?? null, release: sent.release ?? null });
    return c.json({ ok: true }, 201);
  });

  r.post('/feedback/replies', rateLimit({ name: 'feedback-replies', max: 30, windowMs: 10 * 60_000 }), async (c) => {
    const lib = await sessionLibrary(c, deps);
    if (!lib) return c.json<FeedbackRepliesAnswer>({ replies: [] });
    // Done comes with its line. Working is told only while it isn't done yet: done says more.
    const { rows } = await deps.pool.query<{ id: string; kind: 'working' | 'done'; reply: string | null }>(
      `WITH done AS (
         UPDATE feedback SET told_done_at = now()
         WHERE library_id = $1 AND done_at IS NOT NULL AND reply IS NOT NULL AND told_done_at IS NULL
         RETURNING id, reply
       ), working AS (
         UPDATE feedback SET told_working_at = now()
         WHERE library_id = $1 AND working_at IS NOT NULL AND done_at IS NULL AND told_working_at IS NULL
         RETURNING id
       )
       SELECT id, 'done' AS kind, reply FROM done
       UNION ALL
       SELECT id, 'working' AS kind, NULL AS reply FROM working
       ORDER BY id`,
      [lib.id],
    );
    const replies: FeedbackReply[] = rows.map((f) => {
      if (f.kind === 'done') return { id: Number(f.id), kind: 'done', reply: f.reply ?? '' };
      return { id: Number(f.id), kind: 'working' };
    });
    return c.json<FeedbackRepliesAnswer>({ replies });
  });

  return r;
}
