import { createHash } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { REVISIT, RevisitKnownRequest, RevisitNotes, RevisitPartRequest, type ApiError as Why, type RevisitKnownResponse, type RevisitPartResponse } from '@breader/shared';
import type { AppEnv, Deps } from '../context.ts';
import { recaps } from '../db/schema.ts';
import { ApiError, parse, readJson } from '../lib/errors.ts';
import { rateLimit } from '../lib/http.ts';
import { requireLibrary } from '../lib/library.ts';
import { PROMPT_VERSION, readPart } from '../lib/mistral.ts';
import { log } from '../log.ts';

/*
 * Revisit: the names, places and words of what a reader has read so far. The app sends the part
 * it's read, a chapter (or a piece of a long one) at a time, and Mistral reads it (lib/mistral.ts)
 * in the background: a part takes it a quarter of a minute or so, and nothing waits on it. The
 * app asks /known how its parts stand until they're all read, and puts the notes together itself.
 * Notes are kept by the hash of the text, so the same words are read once for everyone.
 */
export function revisitRoutes(deps: Deps) {
  const { db, env } = deps;
  const r = new Hono<AppEnv>();
  const keyOf = (hash: string) => `v${PROMPT_VERSION}:${hash}`;

  /** Parts each library had read today: a key's quota on the free reader. */
  const today = new Map<string, { day: number; parts: number }>();
  const count = (libraryId: string) => {
    const day = Math.floor(Date.now() / 86_400_000);
    let t = today.get(libraryId);
    if (!t || t.day !== day) {
      if (today.size > 5_000) today.clear();
      t = { day, parts: 0 };
      today.set(libraryId, t);
    }
    if (t.parts >= REVISIT.perDay) throw new ApiError(429, 'revisit_quota', 'That’s all Revisit can read for this library today. It’s back tomorrow.');
    t.parts++;
    // A part that couldn't be read doesn't count.
    const counted = t;
    return () => { counted.parts--; };
  };

  /** Parts being read now, by key: one read each, however many readers send it. */
  const reading = new Map<string, Promise<void>>();
  /** Parts that couldn't be read lately, and why. Sending one again tries again. */
  const failed = new Map<string, { at: number; why: Why }>();
  const FAILED_FOR = 10 * 60_000;
  const MOST_READING = 200;
  const failure = (key: string) => {
    const f = failed.get(key);
    if (f && Date.now() - f.at > FAILED_FOR) failed.delete(key);
    return f && failed.has(key) ? f.why : null;
  };

  r.use('/revisit/*', requireLibrary(deps));

  r.post('/revisit/known', rateLimit({ name: 'revisit-known', max: 120, windowMs: 60_000 }), async (c) => {
    const { hashes } = parse(RevisitKnownRequest, await readJson(c));
    const out: RevisitKnownResponse = { known: {}, reading: [], failed: {}, on: !!env.MISTRAL_API_KEY };
    if (hashes.length) {
      const rows = await db.select().from(recaps).where(inArray(recaps.key, hashes.map(keyOf)));
      for (const row of rows) {
        const notes = RevisitNotes.safeParse(row.notes);
        if (notes.success) out.known[row.key.slice(row.key.indexOf(':') + 1)] = notes.data;
      }
      for (const hash of hashes) {
        if (out.known[hash]) continue;
        const why = failure(keyOf(hash));
        if (reading.has(keyOf(hash))) out.reading.push(hash);
        else if (why) out.failed[hash] = why;
      }
    }
    c.header('Cache-Control', 'private, no-store');
    return c.json(out);
  });

  r.post('/revisit/part', rateLimit({ name: 'revisit-part', max: 60, windowMs: 60_000 }), async (c) => {
    const part = parse(RevisitPartRequest, await readJson(c));
    const hash = createHash('sha256').update(part.text).digest('hex');
    const key = keyOf(hash);
    const [kept] = await db.select().from(recaps).where(eq(recaps.key, key));
    const was = kept && RevisitNotes.safeParse(kept.notes);
    if (was?.success) return c.json({ hash, notes: was.data } satisfies RevisitPartResponse);
    if (!env.MISTRAL_API_KEY) throw new ApiError(503, 'revisit_off', 'Revisit isn’t set up on this server yet.');
    if (!reading.has(key)) {
      if (reading.size >= MOST_READING) throw new ApiError(429, 'revisit_busy', 'Revisit has a lot to read right now. Try again in a minute.');
      const undo = count(c.var.library.id);
      failed.delete(key);
      if (failed.size > 5_000) failed.clear();
      reading.set(
        key,
        readPart(env, part)
          .then(async (notes) => { await db.insert(recaps).values({ key, notes }).onConflictDoNothing(); })
          .catch((err: unknown) => {
            undo();
            if (!(err instanceof ApiError)) log.error({ err }, 'revisit part failed');
            const why = err instanceof ApiError ? { code: err.code, message: err.message } : { code: 'revisit_failed', message: 'Revisit couldn’t read that part. Try again in a moment.' };
            failed.set(key, { at: Date.now(), why });
          })
          .finally(() => reading.delete(key)),
      );
    }
    return c.json({ hash } satisfies RevisitPartResponse, 202);
  });

  return r;
}
